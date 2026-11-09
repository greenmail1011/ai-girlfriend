// ===== 商業版前端：登入 + 點數，所有付費 API 都經過後端 =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, limitToLast, getDocs } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js";
import { firebaseConfig, FUNCTIONS_REGION, TOPUP_TEXT } from "./firebase-config.js";
import { Avatar } from "./avatar.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, FUNCTIONS_REGION);
const api = (name) => httpsCallable(fns, name, { timeout: 70000 });

const $ = (id) => document.getElementById(id);
const input = $("input");
const AUDIO_TAG = /\[(?:laughs?|laughing|giggles?|chuckles?|sighs?|whispers?|excited|happy|sad|curious|playfully|softly|teasing|gasps?|pause|clears throat|yawns?)[^\]]*\]/gi;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const displayText = (t) => t.replace(AUDIO_TAG, "").replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem("gfs_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("gfs_" + k, JSON.stringify(v)); } catch {} },
};

let me = null;          // 伺服器回傳的使用者狀態
let busy = false;
const errMsg = (e) => e?.message?.replace(/^.*?:\s*/, "") || "發生錯誤，等一下再試";

// ---------------- 3D 角色 ----------------
const avatar = new Avatar($("scene"));
avatar.mouthLevel = () => mouth.level();
avatar.load("models/sample.vrm").then(() => { $("loading").hidden = true; avatar.setMood(me?.mood || "平靜"); })
  .catch((e) => { $("loading").textContent = "模型載入失敗：" + e.message; });

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
  mode: "none", smooth: 0,
  level() {
    let v = 0;
    if (this.mode === "audio" && analyser) {
      analyser.getByteTimeDomainData(levelBuf);
      let sum = 0; for (const b of levelBuf) { const x = (b - 128) / 128; sum += x * x; }
      v = Math.min(1, Math.sqrt(sum / levelBuf.length) * 5.5);
    } else if (this.mode === "fake") {
      const t = performance.now() / 1000;
      v = 0.25 + 0.45 * Math.abs(Math.sin(t * 13)) * (0.6 + 0.4 * Math.sin(t * 3.7));
    }
    this.smooth += (v - this.smooth) * 0.35;
    return this.smooth;
  },
};

let voiceOn = store.get("voiceOn", true);
let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /zh[-_]TW|Taiwan|臺灣|台灣/i.test(v.lang + v.name));
  const rank = (v) => (/HsiaoChen/i.test(v.name) ? 0 : /Natural|Online/i.test(v.name) ? 1 : 2);
  zhVoice = vs.sort((a, b) => rank(a) - rank(b))[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

async function playBase64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
  const audio = new Audio(url);
  const src = audioCtx().createMediaElementSource(audio);
  src.connect(analyser);
  await new Promise((res) => { audio.onended = res; audio.onerror = res; mouth.mode = "audio"; audio.play().catch(res); });
  mouth.mode = "none"; src.disconnect(); URL.revokeObjectURL(url);
}
function speakBrowser(text) {
  return new Promise((res) => {
    if (!("speechSynthesis" in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW"; if (zhVoice) u.voice = zhVoice; u.pitch = 1.15; u.rate = 1.05;
    u.onstart = () => (mouth.mode = "fake");
    u.onend = u.onerror = () => { mouth.mode = "none"; res(); };
    speechSynthesis.speak(u);
  });
}

// 先預先請求語音，播放時就不用等
function prepareVoice(raw) {
  if (!voiceOn || !$("optHqVoice").checked) return null;
  return api("tts")({ text: raw }).then((r) => { setBalance(r.data.balance); return r.data.audio; }).catch((e) => { console.warn(e); return null; });
}
async function say(raw, pending) {
  const shown = displayText(raw);
  if (!voiceOn) { mouth.mode = "fake"; await sleep(Math.min(700 + shown.length * 110, 5000)); mouth.mode = "none"; return; }
  const audio = pending ? await pending : null;
  if (audio) return playBase64(audio);
  await speakBrowser(shown.replace(/[~～]+/g, "，"));
}

// ---------------- 語音輸入 ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
function startListening() {
  if (!SR) { alert("這個瀏覽器不支援語音輸入，請用 Chrome 或 Edge。"); return; }
  if (listening || busy) return;
  rec = new SR(); rec.lang = "zh-TW"; rec.interimResults = true;
  rec.onresult = (e) => { const r = e.results[e.results.length - 1]; input.value = r[0].transcript; autosize(); if (r.isFinal) send(); };
  rec.onend = () => { listening = false; $("btnMic").classList.remove("listening"); };
  rec.start(); listening = true; $("btnMic").classList.add("listening");
}
const maybeListenAgain = () => { if ($("optCall").checked && !busy) setTimeout(startListening, 400); };

// ---------------- 畫面 ----------------
let subtitleTimer;
function showSubtitle(text) {
  const el = $("subtitle"); clearTimeout(subtitleTimer);
  el.className = "subtitle show";
  if (text === "…") el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'; else el.textContent = text;
}
const hideSubtitleLater = (ms = 9000) => { clearTimeout(subtitleTimer); subtitleTimer = setTimeout(() => ($("subtitle").className = "subtitle"), ms); };
function setStatus(t, typing = false) { $("status").textContent = t; $("status").className = typing ? "typing" : ""; }
function setBalance(b) {
  if (typeof b !== "number") return;
  me && (me.balance = b);
  const s = b.toFixed(b < 10 ? 2 : 0);
  $("balance").textContent = s; $("balance2").textContent = s;
  $("btnBalance").classList.toggle("low", b < 3);
}
function renderMood() {
  $("mood").textContent = me?.mood || "平靜";
  $("affBar").style.width = (me?.affection ?? 60) + "%";
  avatar.setMood(me?.mood || "平靜");
}
function setTimeOfDay() {
  const h = new Date().getHours();
  document.documentElement.dataset.time = h >= 6 && h < 16 ? "day" : h >= 16 && h < 19 ? "sunset" : "night";
}
function logAdd(role, text, ts = Date.now()) {
  const body = $("logBody");
  const d = new Date(ts).toLocaleDateString("zh-TW");
  if (body.dataset.day !== d) { const el = document.createElement("div"); el.className = "day"; el.textContent = d; body.append(el); body.dataset.day = d; }
  const m = document.createElement("div"); m.className = "m " + (role === "user" ? "me" : "her"); m.textContent = displayText(text);
  const t = document.createElement("span"); t.className = "t"; t.textContent = new Date(ts).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  m.append(t); body.append(m); body.scrollTop = body.scrollHeight;
}

async function deliver(data) {
  me.mood = data.mood; me.affection = data.affection; setBalance(data.balance);
  renderMood(); avatar.thinking = false; avatar.nod();
  const pendings = data.parts.map(prepareVoice); // 同時請求所有語音
  for (let i = 0; i < data.parts.length; i++) {
    const raw = data.parts[i];
    showSubtitle(displayText(raw)); logAdd("assistant", raw);
    if (document.hidden) document.title = "💬 小晴";
    await say(raw, pendings[i]);
    await sleep(250);
  }
  setStatus("在線上"); hideSubtitleLater(); maybeListenAgain();
}

function handleError(e) {
  avatar.thinking = false; setStatus("在線上");
  const msg = errMsg(e);
  showSubtitle("⚠️ " + msg);
  if (/點數不足/.test(msg)) setTimeout(openTopup, 800);
}

let lastUserActivity = Date.now(), proactiveFired = false;
async function send() {
  const text = input.value.trim();
  if (!text || busy || !me) return;
  input.value = ""; autosize(); audioCtx();
  window.speechSynthesis?.cancel();
  logAdd("user", text);
  lastUserActivity = Date.now(); proactiveFired = false;
  busy = true; $("btnSend").disabled = true;
  showSubtitle("…"); setStatus("思考中…", true); avatar.thinking = true;
  try { await deliver((await api("chat")({ text })).data); }
  catch (e) { handleError(e); }
  finally { busy = false; $("btnSend").disabled = false; }
}

const randomIdle = () => (8 + Math.random() * 12) * 60 * 1000;
let idleTarget = randomIdle();
setInterval(async () => {
  if (!me || !$("optProactive").checked || busy || proactiveFired || document.hidden) return;
  const idle = Date.now() - lastUserActivity;
  if (idle < idleTarget || (me.balance ?? 0) < 1) return;
  proactiveFired = true; idleTarget = randomIdle(); busy = true;
  try { await deliver((await api("chat")({ proactive: true, idleMinutes: Math.round(idle / 60000) })).data); } catch (e) { console.warn(e); }
  busy = false;
}, 30 * 1000);

// ---------------- 面板 ----------------
function openTopup() { $("topup").hidden = false; }
function renderFacts() {
  const ul = $("facts"); ul.innerHTML = "";
  if (!me?.facts?.length) ul.innerHTML = '<li class="empty">聊久一點，她就會開始記住你的事</li>';
  (me?.facts || []).forEach((f) => {
    const li = document.createElement("li"); li.textContent = f;
    const del = document.createElement("button"); del.textContent = "忘記";
    del.onclick = async () => { await api("forgetFact")({ fact: f }); me.facts = me.facts.filter((x) => x !== f); li.remove(); };
    li.append(del); ul.append(li);
  });
}
$("btnMenu").onclick = async () => {
  try { me = { ...me, ...(await api("init")()).data }; } catch {}
  renderFacts(); $("sheet").hidden = false;
};
$("btnClose").onclick = () => ($("sheet").hidden = true);
$("sheet").onclick = (e) => { if (e.target.id === "sheet") $("sheet").hidden = true; };
$("btnBalance").onclick = openTopup;
$("btnTopupClose").onclick = () => ($("topup").hidden = true);
$("topup").onclick = (e) => { if (e.target.id === "topup") $("topup").hidden = true; };
$("btnCopyUid").onclick = () => { navigator.clipboard?.writeText($("myUid").value); $("btnCopyUid").textContent = "已複製 ✓"; };
$("btnLog").onclick = () => ($("log").hidden = !$("log").hidden);
$("btnLogClose").onclick = () => ($("log").hidden = true);
$("btnFrame").onclick = () => avatar.toggleFraming();
$("scene").addEventListener("dblclick", () => avatar.toggleFraming());
$("btnLogout").onclick = () => signOut(auth).then(() => location.reload());
$("btnReset").onclick = async () => {
  if (!confirm("確定清空對話？")) return;
  const all = confirm("要連她記得的事、心情一起清掉嗎？\n確定＝全部清空，取消＝只清對話");
  await api("resetChat")({ all }); location.reload();
};
["optCall", "optProactive", "optHqVoice"].forEach((id) => {
  $(id).checked = store.get(id, $(id).checked);
  $(id).onchange = () => store.set(id, $(id).checked);
});
function renderVoice() { $("btnVoice").textContent = voiceOn ? "🔊" : "🔈"; $("btnVoice").classList.toggle("on", voiceOn); }
$("btnVoice").onclick = () => { voiceOn = !voiceOn; store.set("voiceOn", voiceOn); renderVoice(); if (!voiceOn) window.speechSynthesis?.cancel(); };
$("btnMic").onclick = () => (listening ? rec.stop() : startListening());
$("btnSend").onclick = send;
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
input.addEventListener("input", () => { autosize(); lastUserActivity = Date.now(); });
function autosize() { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "小晴"; });

// ---------------- 登入 ----------------
$("btnLogin").onclick = async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { alert("登入失敗：" + errMsg(e)); }
};

onAuthStateChanged(auth, async (user) => {
  if (!user) { $("gate").hidden = false; return; }
  $("gate").hidden = true;
  $("myUid").value = user.uid;
  $("topupText").textContent = TOPUP_TEXT;
  try {
    me = (await api("init")()).data;
    setBalance(me.balance); renderMood();
    $("btnAdmin").hidden = !me.isAdmin;
    const q = query(collection(db, "users", user.uid, "messages"), orderBy("ts"), limitToLast(100));
    const snap = await getDocs(q);
    snap.forEach((d) => { const m = d.data(); m.content.split("||").forEach((p) => logAdd(m.role, p, m.ts)); });
    if (snap.empty) { setTimeout(() => { showSubtitle(displayText(me.greeting)); avatar.nod(); hideSubtitleLater(7000); }, 600); }
  } catch (e) {
    showSubtitle("⚠️ 連線失敗：" + errMsg(e));
  }
});

setTimeOfDay(); setInterval(setTimeOfDay, 5 * 60 * 1000);
renderVoice(); renderMood();
