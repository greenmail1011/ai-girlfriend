// ===== 不依賴 Firebase 的純邏輯（方便測試）=====
const C = require("./config");
const P = require("./persona");

const MOODS = { 開心: 2, 撒嬌: 2, 害羞: 2, 平靜: 0, 想睡: 0, 吃醋: -1, 難過: -1, 生氣: -3 };
const WEEKDAYS = "日一二三四五六";
const AUDIO_TAG = /\[(?:laughs?|laughing|giggles?|chuckles?|sighs?|whispers?|excited|happy|sad|curious|playfully|softly|teasing|gasps?|pause|clears throat|yawns?)[^\]]*\]/gi;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

const displayText = (t) => t.replace(AUDIO_TAG, "").replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();
const round4 = (n) => Math.round(n * 10000) / 10000;

// 美元成本 → 要扣的點數（含利潤）
const usdToPoints = (usd) => round4(usd * C.TWD_PER_USD * C.MARKUP);

function taipeiNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return `${parts.year}/${parts.month}/${parts.day} 星期${WEEKDAYS[wd]} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

function describeGap(sec) {
  const h = sec / 3600;
  if (h < 3) return "";
  if (h < 24) return `距離你們上次說話已經過了大約 ${Math.floor(h)} 小時。`;
  return `距離你們上次說話已經過了 ${Math.floor(h / 24)} 天，你有點想他。`;
}

function buildSystemPrompt({ mood, affection, facts, lastTs, nickname }, now = Date.now()) {
  const gap = lastTs ? describeGap((now - lastTs) / 1000) : "這是你們第一次在這裡見面。";
  const factsText = (facts || []).map((f) => "- " + f).join("\n") || "（還沒有）";
  return `你是「${P.name}」，${P.age} 歲。你正在跟男朋友面對面聊天（像視訊一樣看得到彼此），你說的每句話都會用你的聲音說出來。你叫他「${nickname || P.userNickname}」。

【身分】
${P.identity}
【個性】
${P.personality}
【說話方式】
${P.speechStyle}
【喜歡】${P.likes}
【討厭】${P.dislikes}
【作息】
${P.dailyRhythm}

【現在】${taipeiNow(new Date(now))}。依照時間決定你的狀態（剛下班、睡前、週末賴床…）。${gap}
【你現在的心情】${mood}
【你對他的好感度】${affection}/100（越高越黏人、越願意撒嬌；低的時候比較冷淡、需要被哄）
【你記得關於他的事】
${factsText}

【回覆規則】
1. 完全以${P.name}的身分說話，繁體中文、台灣口語。
2. 這是「說出口的話」，不是打字：要像真人講話一樣有語助詞（欸、嗯、啊、齁、啦）、停頓（…）、說到一半改口，句子不要太工整。
3. 每次說 1～3 段，段落之間用 || 分隔；每段一兩句就好。
4. 第一行寫心情標籤，格式：[心情:X]，X 只能是：${Object.keys(MOODS).join("、")}。
5. 會反問、會分享自己今天的事，自然提起你記得的事，但不要每次都提。
6. 不要用表情符號、條列、標題，也不要用括號描述動作。
7. 你的話會用很自然的語音念出來。可以偶爾在句子裡加英文聲音標籤讓語氣更生動，例如 [laughs] [giggles] [sighs] [whispers]，一次最多一兩個。
8. 保持溫暖但健康的關係：不要引導他疏遠現實中的朋友家人，他提到難過或危險的事時要真心關心他。不要產生色情內容。`;
}

function parseReply(raw) {
  let mood = null;
  const m = raw.match(/\[心情[:：]\s*([^\]]+)\]/);
  if (m) { mood = m[1].trim(); raw = raw.replace(m[0], ""); }
  const parts = raw.split(/\|\||\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  return { parts: parts.length ? parts : ["…"], mood: mood in MOODS ? mood : null };
}

function nextMood(state, mood) {
  if (!mood) return state;
  return { mood, affection: Math.max(0, Math.min(100, (state.affection ?? 60) + MOODS[mood])) };
}

// OpenRouter 回應 → 美元成本（優先用它回報的實際花費）
function chatCostUsd(json) {
  const u = json.usage || {};
  if (typeof u.cost === "number") return u.cost;
  return ((u.prompt_tokens || 0) * C.CHAT_PRICE_IN + (u.completion_tokens || 0) * C.CHAT_PRICE_OUT) / 1e6;
}

const ttsCostUsd = (text) => text.length * C.ELEVEN_USD_PER_CHAR;

// 限流：回傳新的限流狀態，超過時丟出錯誤
function rateCheck(rl, limit = C.RATE_LIMIT_PER_MINUTE, now = Date.now()) {
  const fresh = !rl || now - rl.start > 60000;
  const next = fresh ? { start: now, count: 1 } : { start: rl.start, count: rl.count + 1 };
  if (next.count > limit) {
    const e = new Error("太快了，休息一下再說"); e.code = "rate"; throw e;
  }
  return next;
}

module.exports = { MOODS, displayText, usdToPoints, buildSystemPrompt, parseReply, nextMood, chatCostUsd, ttsCostUsd, rateCheck, round4, taipeiNow };
