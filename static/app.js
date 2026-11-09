const $ = (id) => document.getElementById(id);
const chat = $("chat"), input = $("input");
const MOOD_EMOJI = { 開心: "😊", 撒嬌: "🥺", 害羞: "☺️", 平靜: "🙂", 想睡: "😪", 吃醋: "😤", 難過: "😢", 生氣: "😠" };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let persona = null;
let busy = false;
let voiceOn = store.get("voiceOn", true);
let lastUserActivity = Date.now();
let proactiveFired = false;
let unread = 0;

// ---------------- 音效（WebAudio 合成，不需檔案）----------------
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

// ---------------- 語音輸出（Edge TTS，失敗則用瀏覽器內建）----------------
const speechQueue = [];
let speaking = false;
const cleanForSpeech = (t) => t
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
  .replace(/[（(][^）)]{0,12}[）)]/g, "")
  .replace(/[~～]+/g, "，").trim();

function speak(text, force = false) {
  if (!voiceOn && !force) return;
  const t = cleanForSpeech(text);
  if (!t) return;
  speechQueue.push(t);
  if (!speaking) nextSpeech();
}
async function nextSpeech() {
  const t = speechQueue.shift();
  if (!t) { speaking = false; maybeListenAgain(); return; }
  speaking = true;
  try {
    const r = await fetch("/api/tts?text=" + encodeURIComponent(t));
    if (!r.ok) throw new Error();
    const audio = new Audio(URL.createObjectURL(await r.blob()));
    audio.onended = nextSpeech; audio.onerror = nextSpeech;
    await audio.play();
  } catch {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = "zh-TW"; u.pitch = 1.25; u.rate = 1.05;
      u.onend = nextSpeech; u.onerror = nextSpeech;
      speechSynthesis.speak(u);
    } else nextSpeech();
  }
}

// ---------------- 語音輸入 ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
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
function maybeListenAgain() {
  if ($("optCall").checked && !busy) setTimeout(startListening, 400);
}

// ---------------- 畫面 ----------------
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });

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
  return row;
}
function markRead() {
  chat.querySelectorAll(".me .read").forEach((el) => (el.textContent = "已讀"));
}
function setStatus(text, typing = false) {
  $("status").textContent = text;
  $("status").classList.toggle("typing", typing);
}
function showTyping() {
  const t = document.createElement("div");
  t.className = "typing-bubble"; t.innerHTML = "<i></i><i></i><i></i>";
  chat.append(t); chat.scrollTop = chat.scrollHeight;
  setStatus("輸入中…", true);
  return t;
}
function setMood(mood, aff) {
  if (mood) $("mood").textContent = (MOOD_EMOJI[mood] || "") + " " + mood;
  if (aff !== undefined) $("affBar").style.width = aff + "%";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模擬真人：先已讀、停頓、打字，再一則一則傳
async function deliver(data) {
  await sleep(500 + Math.random() * 1200);
  markRead();
  for (const m of data.messages) {
    const t = showTyping();
    await sleep(Math.min(600 + m.length * 85, 4200));
    t.remove();
    addBubble("assistant", m);
    sfx.recv(); speak(m);
    if (document.hidden) { unread++; document.title = `(${unread}) ${persona.name}傳了訊息`; }
    await sleep(350);
  }
  setStatus("在線上");
  setMood(data.mood, data.affection);
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = ""; autosize();
  addBubble("user", text); sfx.sent();
  lastUserActivity = Date.now(); proactiveFired = false;
  busy = true; $("btnSend").disabled = true;
  try {
    const data = await post("/api/chat", { text, mature: $("optMature").checked });
    await deliver(data);
  } catch (e) {
    setStatus("在線上");
    addBubble("assistant", "⚠️ " + e.message);
  } finally {
    busy = false; $("btnSend").disabled = false;
    if (!speaking) maybeListenAgain();
  }
}

// ---------------- 主動傳訊息 ----------------
let idleTarget = randomIdle();
function randomIdle() { return (8 + Math.random() * 12) * 60 * 1000; } // 8–20 分鐘
setInterval(async () => {
  if (!$("optProactive").checked || busy || proactiveFired) return;
  const idle = Date.now() - lastUserActivity;
  if (idle < idleTarget) return;
  proactiveFired = true; idleTarget = randomIdle();
  busy = true;
  try {
    await deliver(await post("/api/proactive", { idle_minutes: Math.round(idle / 60000), mature: $("optMature").checked }));
  } catch {}
  busy = false;
}, 30 * 1000);

// ---------------- 設定面板 ----------------
async function openSheet() {
  $("sheet").hidden = false;
  const facts = await (await fetch("/api/memories")).json();
  const ul = $("facts"); ul.innerHTML = "";
  if (!facts.length) ul.innerHTML = '<li class="empty">聊久一點，她就會開始記住你的事</li>';
  facts.forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f.content;
    const del = document.createElement("button");
    del.textContent = "忘記"; del.onclick = async () => { await fetch("/api/memories/" + f.id, { method: "DELETE" }); li.remove(); };
    li.append(del); ul.append(li);
  });
}

$("btnMenu").onclick = openSheet;
$("btnClose").onclick = () => ($("sheet").hidden = true);
$("sheet").onclick = (e) => { if (e.target.id === "sheet") $("sheet").hidden = true; };
$("btnReset").onclick = async () => {
  const keep = !confirm("要連她記得的事一起清掉嗎？\n確定＝全部清空，取消＝只清對話");
  if (!confirm("確定清空對話？")) return;
  await fetch("/api/reset?keep_facts=" + keep, { method: "POST" });
  location.reload();
};
$("optMature").onchange = (e) => {
  if (e.target.checked && !confirm("成人模式僅限 18 歲以上使用者。你已滿 18 歲嗎？")) e.target.checked = false;
  store.set("mature", e.target.checked);
};
["optCall", "optProactive"].forEach((id) => {
  $(id).checked = store.get(id, $(id).checked);
  $(id).onchange = () => store.set(id, $(id).checked);
});
$("btnVoice").onclick = () => {
  voiceOn = !voiceOn; store.set("voiceOn", voiceOn); renderVoice();
  if (!voiceOn) { speechQueue.length = 0; speechSynthesis?.cancel(); }
};
function renderVoice() { $("btnVoice").textContent = voiceOn ? "🔊" : "🔈"; $("btnVoice").classList.toggle("on", voiceOn); }

$("btnMic").onclick = () => (listening ? rec.stop() : startListening());
$("btnSend").onclick = send;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => { autosize(); lastUserActivity = Date.now(); });
function autosize() { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) { unread = 0; document.title = persona?.name || "聊天"; } });

// ---------------- 啟動 ----------------
(async function init() {
  persona = await (await fetch("/api/persona")).json();
  document.title = persona.name;
  $("name").textContent = persona.name;
  const av = $("avatar");
  av.textContent = persona.avatar_letter;
  av.style.background = `linear-gradient(135deg, ${persona.avatar_colors[0]}, ${persona.avatar_colors[1]})`;
  setMood(persona.mood, persona.affection);
  renderVoice();
  if (persona.mature_available) { $("matureRow").hidden = false; $("optMature").checked = store.get("mature", false); }

  const hist = await (await fetch("/api/history")).json();
  let lastDay = "";
  hist.forEach((m) => {
    const d = new Date(m.ts * 1000).toLocaleDateString("zh-TW");
    if (d !== lastDay) { const el = document.createElement("div"); el.className = "day"; el.textContent = d; chat.append(el); lastDay = d; }
    addBubble(m.role, m.text, m.ts * 1000);
  });
  markRead();
  if (!hist.length) setTimeout(() => { addBubble("assistant", persona.greeting); sfx.recv(); }, 800);
})();
