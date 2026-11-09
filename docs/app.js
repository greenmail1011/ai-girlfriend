// ===== 純網頁版：所有東西都在瀏覽器裡跑 =====
const P = window.PERSONA;
const $ = (id) => document.getElementById(id);
const chat = $("chat"), input = $("input");
const MOODS = { 開心: 2, 撒嬌: 2, 害羞: 2, 平靜: 0, 想睡: 0, 吃醋: -1, 難過: -1, 生氣: -3 };
const MOOD_EMOJI = { 開心: "😊", 撒嬌: "🥺", 害羞: "☺️", 平靜: "🙂", 想睡: "😪", 吃醋: "😤", 難過: "😢", 生氣: "😠" };
const WEEKDAYS = "日一二三四五六";
const MAX_CTX = 30, MAX_STORED = 600;

// ---------------- 儲存（localStorage）----------------
const store = {
  get(k, d) { try { const v = localStorage.getItem("gf_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("gf_" + k, JSON.stringify(v)); } catch (e) { console.warn("儲存失敗", e); } },
};
let messages = store.get("messages", []);   // {role, content, ts}
let facts = store.get("facts", []);         // {id, content}
let state = store.get("state", { mood: "平靜", affection: 60 });
let cfg = store.get("cfg", { base: "", key: "", model: "", mBase: "", mKey: "", mModel: "", mExtra: "" });
const save = () => { store.set("messages", messages.slice(-MAX_STORED)); store.set("facts", facts); store.set("state", state); };

// ---------------- 模型呼叫 ----------------
const matureReady = () => !!(cfg.mBase && cfg.mKey && cfg.mModel);

async function callLLM(msgs, { mature = false, temperature = 0.9, max_tokens = 400 } = {}) {
  cfg = store.get("cfg", cfg); // 永遠讀最新設定（多個分頁同時開著時）
  const key = mature ? cfg.mKey : cfg.key;
  const isOR = (key || "").startsWith("sk-or-");
  const base = (mature ? cfg.mBase : cfg.base) || (isOR ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
  const model = (mature ? cfg.mModel : cfg.model) || (isOR ? "openai/gpt-4o-mini" : "gpt-4o-mini");
  if (!key) return mockReply(msgs);
  let r;
  try {
    r = await fetch(base.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: msgs, temperature, max_tokens }),
    });
  } catch {
    throw new Error(`連不到 ${base}。請檢查 API 網址是否正確、網路是否正常，或是廣告阻擋外掛有沒有擋住它。`);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`模型回應 ${r.status}：${t.slice(0, 160)}`);
  }
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

function mockReply(msgs) {
  const last = msgs[msgs.length - 1]?.content || "";
  if (last.includes("整理") && last.includes("事實")) return "無";
  const picks = [
    "[心情:開心]\n欸真的假的||你再多說一點啦 🥺",
    "[心情:撒嬌]\n哼～你都不早點來找我||不過算了，原諒你一次",
    "[心情:平靜]\n嗯嗯我在聽||然後呢？",
    "[心情:吃醋]\n…你剛剛是跟誰在聊天啦||我才沒有在意喔",
    "[心情:平靜]\n（測試模式：到設定裡填 API 金鑰我才會真的回你喔）",
  ];
  return picks[Math.floor(Math.random() * picks.length)];
}

// ---------------- 系統提示 ----------------
function describeGap(sec) {
  const h = sec / 3600;
  if (h < 3) return "";
  if (h < 24) return `距離你們上次聊天已經過了大約 ${Math.floor(h)} 小時。`;
  return `距離你們上次聊天已經過了 ${Math.floor(h / 24)} 天，你有點想他。`;
}

function buildSystemPrompt(mature) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const last = messages.length ? messages[messages.length - 1].ts : null;
  const gap = last ? describeGap((Date.now() - last) / 1000) : "這是你們在這裡的第一次對話。";
  const factsText = facts.map((f) => "- " + f.content).join("\n") || "（還沒有）";

  let p = `你是「${P.name}」，${P.age} 歲。你正在用手機跟男朋友傳訊息。你叫他「${P.userNickname}」。

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

【現在】${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} 星期${WEEKDAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}。依照時間決定你在做什麼（上班、睡前、週末賴床…）。${gap}
【你現在的心情】${state.mood}
【你對他的好感度】${state.affection}/100（越高越黏人、越願意撒嬌；低的時候比較冷淡、需要被哄）
【你記得關於他的事】
${factsText}

【回覆規則】
1. 完全以${P.name}的身分說話，用繁體中文、台灣口語，像真人傳訊息。
2. 每次回 1～3 則訊息，訊息之間用 || 分隔；每則簡短。
3. 第一行寫心情標籤，格式：[心情:X]，X 只能是：${Object.keys(MOODS).join("、")}。
4. 自然地提起你記得的事，但不要每次都提。會反問、會分享自己今天的事，讓對話有來有往。
5. 不要用條列、標題、括號旁白描述動作。`;

  if (mature && cfg.mExtra.trim()) p += `\n\n【補充設定】\n${cfg.mExtra.trim()}`;
  return p;
}

// ---------------- 回覆處理 ----------------
function parseReply(raw) {
  let mood = null;
  const m = raw.match(/\[心情[:：]\s*([^\]]+)\]/);
  if (m) { mood = m[1].trim(); raw = raw.replace(m[0], ""); }
  const parts = raw.split(/\|\||\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return { parts: parts.length ? parts : ["…"], mood };
}

function updateMood(mood) {
  if (!(mood in MOODS)) return;
  state.mood = mood;
  state.affection = Math.max(0, Math.min(100, state.affection + MOODS[mood]));
}

async function extractFacts() {
  const convo = messages.slice(-20).map((m) => `${m.role === "user" ? "他" : "我"}：${m.content}`).join("\n");
  const known = facts.map((f) => "- " + f.content).join("\n");
  try {
    const out = await callLLM([
      { role: "system", content: "你負責整理記憶。只輸出新的條列，每行以「- 」開頭，沒有就輸出「無」。" },
      { role: "user", content: `已知事實：\n${known || "（無）"}\n\n最近對話：\n${convo}\n\n請整理對話中「他」透露的、值得長期記住的新事實（姓名、工作、喜好、計畫、重要日子、在意的事），不要重複已知事實，不要記錄短暫情緒。` },
    ], { temperature: 0.2, max_tokens: 300 });
    out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).forEach((c) => {
      if (c && !facts.some((f) => f.content === c)) facts.push({ id: Date.now() + Math.random(), content: c });
    });
    facts = facts.slice(-120);
    save();
  } catch (e) { console.warn("記憶整理失敗", e); }
}

async function generate(userText, systemNote) {
  const mature = $("optMature").checked && matureReady();
  if (userText) { messages.push({ role: "user", content: userText, ts: Date.now() }); save(); }
  const history = messages.slice(-MAX_CTX).map(({ role, content }) => ({ role, content }));
  const msgs = [{ role: "system", content: buildSystemPrompt(mature) }, ...history];
  if (systemNote) msgs.push({ role: "system", content: systemNote });

  const raw = await callLLM(msgs, { mature });
  const { parts, mood } = parseReply(raw);
  updateMood(mood);
  messages.push({ role: "assistant", content: parts.join("||"), ts: Date.now() });
  save();
  if (messages.length % 16 === 0) extractFacts();
  return parts;
}

// ---------------- 音效 ----------------
let actx;
function tone(freqs, dur = 0.12, vol = 0.08) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    freqs.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(vol, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + dur);
      o.connect(g).connect(actx.destination);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + dur + 0.02);
    });
  } catch {}
}
const sfx = { sent: () => tone([660], 0.08, 0.05), recv: () => tone([880, 1175], 0.14, 0.07) };

// ---------------- 語音輸出（瀏覽器內建；Edge 有自然的台灣女聲）----------------
let voiceOn = store.get("voiceOn", true);
let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /zh[-_]TW|Taiwan|臺灣|台灣/i.test(v.lang + v.name));
  const rank = (v) => (/HsiaoChen/i.test(v.name) ? 0 : /Natural|Online/i.test(v.name) ? 1 : /female|女|Mei-Jia|Meijia/i.test(v.name) ? 2 : 3);
  zhVoice = vs.sort((a, b) => rank(a) - rank(b))[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

const speechQueue = [];
let speaking = false;
const cleanForSpeech = (t) => t
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
  .replace(/[（(][^）)]{0,12}[）)]/g, "")
  .replace(/[~～]+/g, "，").trim();

function speak(text, force = false) {
  if ((!voiceOn && !force) || !("speechSynthesis" in window)) return;
  const t = cleanForSpeech(text);
  if (!t) return;
  speechQueue.push(t);
  if (!speaking) nextSpeech();
}
function nextSpeech() {
  const t = speechQueue.shift();
  if (!t) { speaking = false; maybeListenAgain(); return; }
  speaking = true;
  const u = new SpeechSynthesisUtterance(t);
  u.lang = "zh-TW"; if (zhVoice) u.voice = zhVoice;
  u.pitch = P.voice?.pitch ?? 1.15; u.rate = P.voice?.rate ?? 1.05;
  u.onend = nextSpeech; u.onerror = nextSpeech;
  speechSynthesis.speak(u);
}

// ---------------- 語音輸入 ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, busy = false;
function startListening() {
  if (!SR) { alert("這個瀏覽器不支援語音輸入，請用 Chrome 或 Edge。"); return; }
  if (listening || busy) return;
  rec = new SR();
  rec.lang = "zh-TW"; rec.interimResults = true;
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    input.value = r[0].transcript; autosize();
    if (r.isFinal) send();
  };
  rec.onend = () => { listening = false; $("btnMic").classList.remove("listening"); };
  rec.start(); listening = true; $("btnMic").classList.add("listening");
}
function maybeListenAgain() { if ($("optCall").checked && !busy) setTimeout(startListening, 400); }

// ---------------- 畫面 ----------------
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let unread = 0;

function addBubble(role, text, ts = Date.now()) {
  const row = document.createElement("div");
  row.className = "msg " + (role === "user" ? "me" : "her");
  const b = document.createElement("div");
  b.className = "bubble"; b.textContent = text;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = (role === "user" ? '<span class="read"></span><br>' : "") + fmtTime(ts);
  row.append(b, meta);
  if (role !== "user") {
    const s = document.createElement("button");
    s.className = "speak"; s.textContent = "▶"; s.title = "播放語音";
    s.onclick = () => speak(text, true);
    row.append(s);
  }
  chat.append(row);
  chat.scrollTop = chat.scrollHeight;
}
const markRead = () => chat.querySelectorAll(".me .read").forEach((el) => (el.textContent = "已讀"));
function setStatus(text, typing = false) { $("status").textContent = text; $("status").classList.toggle("typing", typing); }
function showTyping() {
  const t = document.createElement("div");
  t.className = "typing-bubble"; t.innerHTML = "<i></i><i></i><i></i>";
  chat.append(t); chat.scrollTop = chat.scrollHeight;
  setStatus("輸入中…", true);
  return t;
}
function renderMood() {
  $("mood").textContent = (MOOD_EMOJI[state.mood] || "") + " " + state.mood;
  $("affBar").style.width = state.affection + "%";
}

async function deliver(parts) {
  await sleep(500 + Math.random() * 1200);
  markRead();
  for (const m of parts) {
    const t = showTyping();
    await sleep(Math.min(600 + m.length * 85, 4200));
    t.remove();
    addBubble("assistant", m);
    sfx.recv(); speak(m);
    if (document.hidden) { unread++; document.title = `(${unread}) ${P.name}傳了訊息`; }
    await sleep(350);
  }
  setStatus("在線上");
  renderMood();
}

let lastUserActivity = Date.now(), proactiveFired = false;

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = ""; autosize();
  addBubble("user", text); sfx.sent();
  lastUserActivity = Date.now(); proactiveFired = false;
  busy = true; $("btnSend").disabled = true;
  try {
    await deliver(await generate(text));
  } catch (e) {
    setStatus("在線上");
    addBubble("assistant", "⚠️ " + e.message);
  } finally {
    busy = false; $("btnSend").disabled = false;
    if (!speaking) maybeListenAgain();
  }
}

// ---------------- 主動傳訊息 ----------------
const randomIdle = () => (8 + Math.random() * 12) * 60 * 1000; // 8–20 分鐘
let idleTarget = randomIdle();
setInterval(async () => {
  if (!$("optProactive").checked || busy || proactiveFired || !messages.length) return;
  const idle = Date.now() - lastUserActivity;
  if (idle < idleTarget) return;
  proactiveFired = true; idleTarget = randomIdle(); busy = true;
  try {
    const note = `（系統提示，不要提到這段：他已經 ${Math.round(idle / 60000)} 分鐘沒有回訊息。依照現在的時間和你的心情，主動傳訊息給他，例如分享你正在做的事、關心他、或撒嬌抱怨他沒回。不要重複你上一則說過的話。）`;
    await deliver(await generate(null, note));
  } catch (e) { console.warn(e); }
  busy = false;
}, 30 * 1000);

// ---------------- 設定面板 ----------------
const CFG_FIELDS = { cfgBase: "base", cfgKey: "key", cfgModel: "model", cfgMBase: "mBase", cfgMKey: "mKey", cfgMModel: "mModel", cfgMExtra: "mExtra" };

function renderFacts() {
  const ul = $("facts"); ul.innerHTML = "";
  if (!facts.length) ul.innerHTML = '<li class="empty">聊久一點，她就會開始記住你的事</li>';
  facts.forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f.content;
    const del = document.createElement("button");
    del.textContent = "忘記";
    del.onclick = () => { facts = facts.filter((x) => x.id !== f.id); save(); li.remove(); };
    li.append(del); ul.append(li);
  });
}
function openSheet() {
  cfg = store.get("cfg", cfg);
  Object.entries(CFG_FIELDS).forEach(([id, k]) => ($(id).value = cfg[k] || ""));
  $("modelBox").open = !cfg.key;
  renderFacts();
  $("sheet").hidden = false;
}
function renderMatureRow() {
  $("matureRow").hidden = !matureReady();
  if (!matureReady()) $("optMature").checked = false;
}

$("btnSaveCfg").onclick = () => {
  Object.entries(CFG_FIELDS).forEach(([id, k]) => (cfg[k] = $(id).value.trim()));
  store.set("cfg", cfg);
  renderMatureRow();
  $("btnSaveCfg").textContent = "已儲存 ✓";
  setTimeout(() => ($("btnSaveCfg").textContent = "儲存設定"), 1500);
};
$("btnMenu").onclick = openSheet;
$("btnClose").onclick = () => ($("sheet").hidden = true);
$("sheet").onclick = (e) => { if (e.target.id === "sheet") $("sheet").hidden = true; };

$("btnReset").onclick = () => {
  if (!confirm("確定清空對話？")) return;
  const all = confirm("要連她記得的事、心情一起清掉嗎？\n確定＝全部清空，取消＝只清對話");
  messages = [];
  if (all) { facts = []; state = { mood: "平靜", affection: 60 }; }
  save(); location.reload();
};
$("btnExport").onclick = () => {
  const blob = new Blob([JSON.stringify({ messages, facts, state }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${P.name}-記憶-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
$("btnImport").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  try {
    const d = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(d.messages)) throw new Error();
    if (!confirm("匯入會覆蓋目前的對話和記憶，確定嗎？")) return;
    messages = d.messages; facts = d.facts || []; state = d.state || state;
    save(); location.reload();
  } catch { alert("檔案格式不對"); }
};

$("optMature").onchange = (e) => {
  if (e.target.checked && !confirm("成人模式僅限 18 歲以上使用者。你已滿 18 歲嗎？")) e.target.checked = false;
  store.set("mature", e.target.checked);
};
["optCall", "optProactive"].forEach((id) => {
  $(id).checked = store.get(id, $(id).checked);
  $(id).onchange = () => store.set(id, $(id).checked);
});
function renderVoice() { $("btnVoice").textContent = voiceOn ? "🔊" : "🔈"; $("btnVoice").classList.toggle("on", voiceOn); }
$("btnVoice").onclick = () => {
  voiceOn = !voiceOn; store.set("voiceOn", voiceOn); renderVoice();
  if (!voiceOn) { speechQueue.length = 0; window.speechSynthesis?.cancel(); }
};
$("btnMic").onclick = () => (listening ? rec.stop() : startListening());
$("btnSend").onclick = send;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => { autosize(); lastUserActivity = Date.now(); });
function autosize() { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) { unread = 0; document.title = P.name; } });

// ---------------- 啟動 ----------------
(function init() {
  if (!(P.age >= 18)) { document.body.textContent = "persona.js：角色年齡必須是成年人"; return; }
  document.title = P.name;
  $("name").textContent = P.name;
  $("avatar").textContent = P.avatarLetter;
  $("avatar").style.background = `linear-gradient(135deg, ${P.avatarColors[0]}, ${P.avatarColors[1]})`;
  renderMood(); renderVoice(); renderMatureRow();
  if (matureReady()) $("optMature").checked = store.get("mature", false);

  let lastDay = "";
  messages.slice(-120).forEach((m) => {
    const d = new Date(m.ts).toLocaleDateString("zh-TW");
    if (d !== lastDay) { const el = document.createElement("div"); el.className = "day"; el.textContent = d; chat.append(el); lastDay = d; }
    m.content.split("||").forEach((part) => addBubble(m.role, part, m.ts));
  });
  markRead();

  if (!messages.length) {
    setTimeout(() => {
      addBubble("assistant", P.greeting); sfx.recv();
      if (!cfg.key) addBubble("assistant", "（先點右上角 ⋯ 填好模型設定，我才能真的跟你聊天喔）");
    }, 800);
  }
})();
