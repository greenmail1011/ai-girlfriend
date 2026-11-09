// ===== 3D 版：所有東西都在瀏覽器裡跑 =====
import { Avatar } from "./avatar.js";

const P = window.PERSONA;
const $ = (id) => document.getElementById(id);
const input = $("input");
const MOODS = { 開心: 2, 撒嬌: 2, 害羞: 2, 平靜: 0, 想睡: 0, 吃醋: -1, 難過: -1, 生氣: -3 };
const WEEKDAYS = "日一二三四五六";
const MAX_CTX = 30, MAX_STORED = 600;
const DEFAULT_VRM = "models/sample.vrm";
const AUDIO_TAG = /\[(?:laughs?|laughing|giggles?|chuckles?|sighs?|whispers?|excited|happy|sad|curious|playfully|softly|teasing|gasps?|pause|clears throat|yawns?)[^\]]*\]/gi;

// ---------------- 儲存 ----------------
const store = {
  get(k, d) { try { const v = localStorage.getItem("gf_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("gf_" + k, JSON.stringify(v)); } catch (e) { console.warn("儲存失敗", e); } },
};
let messages = store.get("messages", []);
let facts = store.get("facts", []);
let state = store.get("state", { mood: "平靜", affection: 60 });
const CFG_DEFAULT = { base: "", key: "", model: "", elKey: "", elVoice: "", elModel: "", mBase: "", mKey: "", mModel: "", mExtra: "" };
let cfg = { ...CFG_DEFAULT, ...store.get("cfg", {}) };
const reloadCfg = () => (cfg = { ...CFG_DEFAULT, ...store.get("cfg", {}) });
const save = () => { store.set("messages", messages.slice(-MAX_STORED)); store.set("facts", facts); store.set("state", state); };

// VRM 檔很大，存在 IndexedDB
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("gf", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res) => { const q = db.transaction("files").objectStore("files").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async del(k) { const db = await this.open(); return new Promise((res) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").delete(k); tx.oncomplete = res; }); },
};
let customVrm = false;

// ---------------- 模型呼叫 ----------------
const matureReady = () => customVrm && !!(cfg.mBase && cfg.mKey && cfg.mModel);
const useV3 = () => !!cfg.elKey && !!cfg.elVoice && /v3/.test(cfg.elModel || "eleven_v3");

async function callLLM(msgs, { mature = false, temperature = 0.9, max_tokens = 400 } = {}) {
  reloadCfg();
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
    throw new Error(`連不到 ${base}，請檢查 API 網址、網路，或廣告阻擋外掛。`);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    if (r.status === 402) throw new Error("模型帳戶額度不足（402），請到 OpenRouter 儲值。");
    if (r.status === 401) throw new Error("API 金鑰不正確（401），請到設定檢查。");
    throw new Error(`模型回應 ${r.status}：${t.slice(0, 140)}`);
  }
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

function mockReply(msgs) {
  const last = msgs[msgs.length - 1]?.content || "";
  if (last.includes("整理") && last.includes("事實")) return "無";
  const picks = [
    "[心情:開心]\n欸～真的假的||你再多說一點嘛",
    "[心情:撒嬌]\n哼，你都不早點來找我||不過算了啦，原諒你",
    "[心情:害羞]\n你、你突然這樣說幹嘛啦…",
    "[心情:平靜]\n（測試模式：到設定裡填好聊天模型的金鑰，我才會真的回你喔）",
  ];
  return picks[Math.floor(Math.random() * picks.length)];
}

// ---------------- 系統提示 ----------------
function describeGap(sec) {
  const h = sec / 3600;
  if (h < 3) return "";
  if (h < 24) return `距離你們上次說話已經過了大約 ${Math.floor(h)} 小時。`;
  return `距離你們上次說話已經過了 ${Math.floor(h / 24)} 天，你有點想他。`;
}

function buildSystemPrompt(mature) {
  const now = new Date(), pad = (n) => String(n).padStart(2, "0");
  const last = messages.length ? messages[messages.length - 1].ts : null;
  const gap = last ? describeGap((Date.now() - last) / 1000) : "這是你們第一次在這裡見面。";
  const factsText = facts.map((f) => "- " + f.content).join("\n") || "（還沒有）";
  const tags = useV3()
    ? `\n7. 你的話會用很自然的語音念出來。可以偶爾在句子裡加英文聲音標籤讓語氣更生動，例如 [laughs] [giggles] [sighs] [whispers] [excited]，一次最多一兩個，不要每句都加。`
    : "";

  let p = `你是「${P.name}」，${P.age} 歲。你正在跟男朋友面對面聊天（像視訊一樣看得到彼此），你說的每句話都會用你的聲音說出來。你叫他「${P.userNickname}」。

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

【現在】${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} 星期${WEEKDAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}。依照時間決定你的狀態（剛下班、睡前、週末賴床…）。${gap}
【你現在的心情】${state.mood}
【你對他的好感度】${state.affection}/100（越高越黏人、越願意撒嬌；低的時候比較冷淡、需要被哄）
【你記得關於他的事】
${factsText}

【回覆規則】
1. 完全以${P.name}的身分說話，繁體中文、台灣口語。
2. 這是「說出口的話」，不是打字：要像真人講話一樣有語助詞（欸、嗯、啊、齁、啦）、停頓（…）、說到一半改口，句子不要太工整、不要像在寫文章。
3. 每次說 1～3 段，段落之間用 || 分隔；每段一兩句就好。
4. 第一行寫心情標籤，格式：[心情:X]，X 只能是：${Object.keys(MOODS).join("、")}。
5. 會反問、會分享自己今天的事，自然提起你記得的事，但不要每次都提。
6. 不要用表情符號、條列、標題，也不要用括號描述動作。${tags}`;

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
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const displayText = (t) => t.replace(AUDIO_TAG, "").replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();

function updateMood(mood) {
  if (!(mood in MOODS)) return;
  state.mood = mood;
  state.affection = Math.max(0, Math.min(100, state.affection + MOODS[mood]));
}

async function extractFacts() {
  const convo = messages.slice(-20).map((m) => `${m.role === "user" ? "他" : "我"}：${displayText(m.content)}`).join("\n");
  const known = facts.map((f) => "- " + f.content).join("\n");
  try {
    const out = await callLLM([
      { role: "system", content: "你負責整理記憶。只輸出新的條列，每行以「- 」開頭，沒有就輸出「無」。" },
      { role: "user", content: `已知事實：\n${known || "（無）"}\n\n最近對話：\n${convo}\n\n請整理對話中「他」透露的、值得長期記住的新事實（姓名、工作、喜好、計畫、重要日子、在意的事），不要重複已知事實，不要記錄短暫情緒。` },
    ], { temperature: 0.2, max_tokens: 300 });
    out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).forEach((c) => {
      if (c && !facts.some((f) => f.content === c)) facts.push({ id: Date.now() + Math.random(), content: c });
    });
    facts = facts.slice(-120); save();
  } catch (e) { console.warn("記憶整理失敗", e); }
}

async function generate(userText, systemNote) {
  const mature = $("optMature").checked && matureReady();
  if (userText) { messages.push({ role: "user", content: userText, ts: Date.now() }); save(); }
  const history = messages.slice(-MAX_CTX).map(({ role, content }) => ({ role, content }));
  const msgs = [{ role: "system", content: buildSystemPrompt(mature) }, ...history];
  if (systemNote) msgs.push({ role: "system", content: systemNote });
  const { parts, mood } = parseReply(await callLLM(msgs, { mature }));
  updateMood(mood);
  messages.push({ role: "assistant", content: parts.join("||"), ts: Date.now() });
  save();
  if (messages.length % 16 === 0) extractFacts();
  return parts;
}

// ---------------- 3D 角色 ----------------
const avatar = new Avatar($("scene"));
avatar.mouthLevel = () => mouth.level();

async function loadAvatar() {
  $("loading").hidden = false;
  try {
    const buf = await idb.get("vrm").catch(() => null);
    customVrm = !!buf;
    await avatar.load(buf || DEFAULT_VRM);
  } catch (e) {
    console.error(e);
    customVrm = false;
    if (avatar.vrm == null) await avatar.load(DEFAULT_VRM).catch(() => {});
    alert("模型載入失敗：" + e.message);
  }
  $("loading").hidden = true;
  avatar.setMood(state.mood);
  renderMatureRow();
}

// ---------------- 聲音 ----------------
let actx, analyser, levelBuf;
function audioCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = actx.createAnalyser(); analyser.fftSize = 512;
    levelBuf = new Uint8Array(analyser.fftSize);
    analyser.connect(actx.destination);
  }
  if (actx.state === "suspended") actx.resume();
  return actx;
}
addEventListener("pointerdown", () => audioCtx(), { once: true });
addEventListener("keydown", () => audioCtx(), { once: true });

const mouth = {
  mode: "none", // none | audio | fake
  smooth: 0,
  level() {
    let v = 0;
    if (this.mode === "audio" && analyser) {
      analyser.getByteTimeDomainData(levelBuf);
      let sum = 0;
      for (const b of levelBuf) { const x = (b - 128) / 128; sum += x * x; }
      v = Math.min(1, Math.sqrt(sum / levelBuf.length) * 5.5);
    } else if (this.mode === "fake") {
      const t = performance.now() / 1000;
      v = 0.25 + 0.45 * Math.abs(Math.sin(t * 13)) * (0.6 + 0.4 * Math.sin(t * 3.7));
    }
    this.smooth += (v - this.smooth) * 0.35;
    return this.smooth;
  },
};

function tone(freqs, dur = 0.12, vol = 0.06) {
  try {
    const c = audioCtx(), t = c.currentTime;
    freqs.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(vol, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + dur);
      o.connect(g).connect(c.destination);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + dur + 0.02);
    });
  } catch {}
}
const sfx = { sent: () => tone([660], 0.08, 0.04) };

let voiceOn = store.get("voiceOn", true);
let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /zh[-_]TW|Taiwan|臺灣|台灣/i.test(v.lang + v.name));
  const rank = (v) => (/HsiaoChen/i.test(v.name) ? 0 : /Natural|Online/i.test(v.name) ? 1 : /female|女|Mei-Jia|Meijia/i.test(v.name) ? 2 : 3);
  zhVoice = vs.sort((a, b) => rank(a) - rank(b))[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

let elWarned = false;
async function speakEleven(text) {
  const model = cfg.elModel || "eleven_v3";
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.elVoice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": cfg.elKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, language_code: "zh" }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}：${(await r.text().catch(() => "")).slice(0, 120)}`);
  const url = URL.createObjectURL(await r.blob());
  const c = audioCtx();
  const audio = new Audio(url);
  const src = c.createMediaElementSource(audio);
  src.connect(analyser);
  await new Promise((res) => {
    audio.onended = res; audio.onerror = res;
    mouth.mode = "audio";
    audio.play().catch(res);
  });
  mouth.mode = "none";
  src.disconnect(); URL.revokeObjectURL(url);
}

function speakBrowser(text) {
  return new Promise((res) => {
    if (!("speechSynthesis" in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW"; if (zhVoice) u.voice = zhVoice;
    u.pitch = P.voice?.pitch ?? 1.15; u.rate = P.voice?.rate ?? 1.05;
    u.onstart = () => (mouth.mode = "fake");
    u.onend = u.onerror = () => { mouth.mode = "none"; res(); };
    speechSynthesis.speak(u);
    setTimeout(() => { if (mouth.mode === "none" && !speechSynthesis.speaking) res(); }, 4000);
  });
}

async function say(raw) {
  const shown = displayText(raw);
  if (!voiceOn) {
    mouth.mode = "fake";
    await sleep(Math.min(700 + shown.length * 110, 5000));
    mouth.mode = "none";
    return;
  }
  reloadCfg();
  if (cfg.elKey && cfg.elVoice) {
    try { await speakEleven(useV3() ? raw : shown); return; }
    catch (e) {
      console.warn(e);
      if (!elWarned) { elWarned = true; showSubtitle("⚠️ " + e.message + "（先改用瀏覽器語音）"); await sleep(2500); showSubtitle(shown); }
    }
  }
  await speakBrowser(shown.replace(/[~～]+/g, "，"));
}

// ---------------- 語音輸入 ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, busy = false;
function startListening() {
  if (!SR) { alert("這個瀏覽器不支援語音輸入，請用 Chrome 或 Edge。"); return; }
  if (listening || busy) return;
  rec = new SR(); rec.lang = "zh-TW"; rec.interimResults = true;
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    input.value = r[0].transcript; autosize();
    if (r.isFinal) send();
  };
  rec.onend = () => { listening = false; $("btnMic").classList.remove("listening"); };
  rec.start(); listening = true; $("btnMic").classList.add("listening");
}
const maybeListenAgain = () => { if ($("optCall").checked && !busy) setTimeout(startListening, 400); };

// ---------------- 畫面 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
let subtitleTimer;
function showSubtitle(text, cls = "") {
  const el = $("subtitle");
  clearTimeout(subtitleTimer);
  el.className = "subtitle show " + cls;
  if (text === "…") el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  else el.textContent = text;
}
function hideSubtitleLater(ms = 9000) {
  clearTimeout(subtitleTimer);
  subtitleTimer = setTimeout(() => ($("subtitle").className = "subtitle"), ms);
}
function setStatus(text, typing = false) {
  $("status").textContent = text;
  $("status").className = typing ? "typing" : "";
}
function renderMood() {
  $("mood").textContent = state.mood;
  $("affBar").style.width = state.affection + "%";
  avatar.setMood(state.mood);
}
function setTimeOfDay() {
  const h = new Date().getHours();
  document.documentElement.dataset.time = h >= 6 && h < 16 ? "day" : h >= 16 && h < 19 ? "sunset" : "night";
}

function logAdd(role, text, ts) {
  const body = $("logBody");
  const d = new Date(ts).toLocaleDateString("zh-TW");
  if (body.dataset.day !== d) {
    const el = document.createElement("div"); el.className = "day"; el.textContent = d;
    body.append(el); body.dataset.day = d;
  }
  const m = document.createElement("div");
  m.className = "m " + (role === "user" ? "me" : "her");
  m.textContent = displayText(text);
  const t = document.createElement("span"); t.className = "t"; t.textContent = fmtTime(ts);
  m.append(t); body.append(m);
  body.scrollTop = body.scrollHeight;
}

async function deliver(parts) {
  renderMood();
  avatar.thinking = false;
  avatar.nod();
  for (const raw of parts) {
    showSubtitle(displayText(raw));
    logAdd("assistant", raw, Date.now());
    if (document.hidden) document.title = `💬 ${P.name}`;
    await say(raw);
    await sleep(250);
  }
  setStatus("在線上");
  hideSubtitleLater();
  maybeListenAgain();
}

let lastUserActivity = Date.now(), proactiveFired = false;

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = ""; autosize();
  audioCtx(); sfx.sent();
  window.speechSynthesis?.cancel();
  logAdd("user", text, Date.now());
  lastUserActivity = Date.now(); proactiveFired = false;
  busy = true; $("btnSend").disabled = true;
  showSubtitle("…"); setStatus("思考中…", true);
  avatar.thinking = true;
  try {
    await deliver(await generate(text));
  } catch (e) {
    avatar.thinking = false;
    setStatus("在線上");
    showSubtitle("⚠️ " + e.message);
  } finally {
    busy = false; $("btnSend").disabled = false;
  }
}

// ---------------- 主動找你說話 ----------------
const randomIdle = () => (8 + Math.random() * 12) * 60 * 1000;
let idleTarget = randomIdle();
setInterval(async () => {
  if (!$("optProactive").checked || busy || proactiveFired || !messages.length) return;
  const idle = Date.now() - lastUserActivity;
  if (idle < idleTarget) return;
  proactiveFired = true; idleTarget = randomIdle(); busy = true;
  try {
    const note = `（系統提示，不要提到這段：他已經 ${Math.round(idle / 60000)} 分鐘沒有說話。依照現在的時間和你的心情，主動跟他說話，例如分享你正在做的事、關心他、或撒嬌抱怨他不理你。不要重複你上一次說過的話。）`;
    await deliver(await generate(null, note));
  } catch (e) { console.warn(e); }
  busy = false;
}, 30 * 1000);

// ---------------- 設定 ----------------
const CFG_FIELDS = { cfgBase: "base", cfgKey: "key", cfgModel: "model", cfgElKey: "elKey", cfgElVoice: "elVoice", cfgElModel: "elModel",
  cfgMBase: "mBase", cfgMKey: "mKey", cfgMModel: "mModel", cfgMExtra: "mExtra" };

function renderFacts() {
  const ul = $("facts"); ul.innerHTML = "";
  if (!facts.length) ul.innerHTML = '<li class="empty">聊久一點，她就會開始記住你的事</li>';
  facts.forEach((f) => {
    const li = document.createElement("li"); li.textContent = f.content;
    const del = document.createElement("button"); del.textContent = "忘記";
    del.onclick = () => { facts = facts.filter((x) => x.id !== f.id); save(); li.remove(); };
    li.append(del); ul.append(li);
  });
}
function openSheet() {
  reloadCfg();
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
  reloadCfg();
  Object.entries(CFG_FIELDS).forEach(([id, k]) => (cfg[k] = $(id).value.trim()));
  store.set("cfg", cfg);
  elWarned = false;
  renderMatureRow();
  $("btnSaveCfg").textContent = "已儲存 ✓";
  setTimeout(() => ($("btnSaveCfg").textContent = "儲存設定"), 1500);
};
$("btnMenu").onclick = openSheet;
$("btnClose").onclick = () => ($("sheet").hidden = true);
$("sheet").onclick = (e) => { if (e.target.id === "sheet") $("sheet").hidden = true; };
$("btnLog").onclick = () => ($("log").hidden = !$("log").hidden);
$("btnLogClose").onclick = () => ($("log").hidden = true);
$("btnFrame").onclick = () => avatar.toggleFraming();
$("scene").addEventListener("dblclick", () => avatar.toggleFraming());

$("btnVrm").onclick = () => $("vrmFile").click();
$("vrmFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const buf = await f.arrayBuffer();
  $("loading").hidden = false;
  try {
    await avatar.load(buf);
    await idb.set("vrm", buf);
    customVrm = true;
    avatar.setMood(state.mood);
  } catch (err) { alert("模型載入失敗：" + err.message); }
  $("loading").hidden = true;
  renderMatureRow();
};
$("btnVrmReset").onclick = async () => { await idb.del("vrm"); await loadAvatar(); };

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
  if (e.target.checked && !confirm("成人模式僅限 18 歲以上使用者，角色也必須是成年人。你已滿 18 歲嗎？")) e.target.checked = false;
  store.set("mature", e.target.checked);
};
["optCall", "optProactive"].forEach((id) => {
  $(id).checked = store.get(id, $(id).checked);
  $(id).onchange = () => store.set(id, $(id).checked);
});
function renderVoice() { $("btnVoice").textContent = voiceOn ? "🔊" : "🔈"; $("btnVoice").classList.toggle("on", voiceOn); }
$("btnVoice").onclick = () => {
  voiceOn = !voiceOn; store.set("voiceOn", voiceOn); renderVoice();
  if (!voiceOn) window.speechSynthesis?.cancel();
};
$("btnMic").onclick = () => (listening ? rec.stop() : startListening());
$("btnSend").onclick = send;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => { autosize(); lastUserActivity = Date.now(); });
function autosize() { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = P.name; });

// ---------------- 啟動 ----------------
(async function init() {
  if (!(P.age >= 18)) { document.body.textContent = "persona.js：角色年齡必須是成年人"; return; }
  document.title = P.name;
  $("name").textContent = P.name;
  setTimeOfDay(); setInterval(setTimeOfDay, 5 * 60 * 1000);
  renderVoice(); renderMood();
  messages.slice(-150).forEach((m) => m.content.split("||").forEach((part) => logAdd(m.role, part, m.ts)));
  await loadAvatar();
  if (matureReady()) $("optMature").checked = store.get("mature", false);
  renderMood();
  setTimeout(() => {
    showSubtitle(cfg.key ? displayText(P.greeting)
      : "嗨～先點右上角的 ⚙ 填好聊天模型，我才能真的跟你說話喔");
    avatar.nod();
    hideSubtitleLater(7000);
  }, 600);
})();
