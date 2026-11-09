// ===== 後端：API 金鑰只存在這裡，使用者看不到 =====
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const C = require("./config");
const P = require("./persona");
const L = require("./logic");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

setGlobalOptions({ region: "asia-east1", maxInstances: 10 }); // asia-east1 = 彰化機房
const OPENROUTER_KEY = defineSecret("OPENROUTER_KEY");
const ELEVEN_KEY = defineSecret("ELEVEN_KEY");

const userRef = (uid) => db.collection("users").doc(uid);
const isAdmin = (auth) => !!auth?.token?.email && C.ADMIN_EMAILS.includes(auth.token.email) && auth.token.email_verified;

function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "請先登入");
  return req.auth.uid;
}

// 檢查餘額與限流（在同一個交易裡），通過才去呼叫付費 API
async function gate(uid, kind) {
  const limit = kind === "tts" ? C.TTS_LIMIT_PER_MINUTE : C.RATE_LIMIT_PER_MINUTE;
  const field = kind === "tts" ? "rlTts" : "rlChat";
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef(uid));
    if (!snap.exists) throw new HttpsError("failed-precondition", "帳號尚未初始化，請重新整理");
    const u = snap.data();
    if ((u.balance ?? 0) < C.MIN_BALANCE) throw new HttpsError("resource-exhausted", "點數不足，請先儲值");
    let rl;
    try { rl = L.rateCheck(u[field], limit); }
    catch { throw new HttpsError("resource-exhausted", "說太快了，休息一下再繼續"); }
    tx.update(userRef(uid), { [field]: rl });
    return u;
  });
}

// 扣點並記帳
async function charge(uid, type, usd, extra = {}) {
  const points = L.usdToPoints(usd);
  const batch = db.batch();
  batch.update(userRef(uid), { balance: FieldValue.increment(-points), spentUsd: FieldValue.increment(usd) });
  batch.set(userRef(uid).collection("ledger").doc(), { type, points: -points, usd: L.round4(usd), ts: Date.now(), ...extra });
  await batch.commit();
  return points;
}

async function callOpenRouter(messages, { temperature = 0.9, max_tokens = 400 } = {}) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY.value()}`,
      "Content-Type": "application/json",
      "X-Title": `${P.name} AI`,
    },
    body: JSON.stringify({ model: C.CHAT_MODEL, messages, temperature, max_tokens, usage: { include: true } }),
  });
  if (!r.ok) {
    console.error("OpenRouter", r.status, await r.text().catch(() => ""));
    throw new HttpsError("unavailable", "她現在有點忙，等一下再試試");
  }
  const json = await r.json();
  return { text: (json.choices?.[0]?.message?.content || "").trim(), usd: L.chatCostUsd(json) };
}

// ---------- 初始化：第一次登入送試用點數 ----------
exports.init = onCall(async (req) => {
  const uid = requireAuth(req);
  const ref = userRef(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      email: req.auth.token.email || "", name: req.auth.token.name || "",
      balance: C.TRIAL_POINTS, spentUsd: 0, mood: "平靜", affection: 60, facts: [], msgCount: 0,
      createdAt: Date.now(),
    });
    await ref.collection("ledger").add({ type: "trial", points: C.TRIAL_POINTS, ts: Date.now(), note: "新會員試用" });
  }
  const u = (await ref.get()).data();
  return { balance: u.balance, mood: u.mood, affection: u.affection, facts: u.facts, isAdmin: isAdmin(req.auth), greeting: P.greeting };
});

// ---------- 聊天 ----------
exports.chat = onCall({ secrets: [OPENROUTER_KEY], timeoutSeconds: 60 }, async (req) => {
  const uid = requireAuth(req);
  const proactive = !!req.data?.proactive;
  const text = String(req.data?.text || "").trim();
  if (!proactive && !text) throw new HttpsError("invalid-argument", "空訊息");
  if (text.length > C.MAX_INPUT_CHARS) throw new HttpsError("invalid-argument", `訊息太長了（最多 ${C.MAX_INPUT_CHARS} 字）`);

  const u = await gate(uid, "chat");
  const msgsCol = userRef(uid).collection("messages");
  const recent = (await msgsCol.orderBy("ts", "desc").limit(C.MAX_CONTEXT_MESSAGES).get()).docs.map((d) => d.data()).reverse();
  const lastTs = recent.length ? recent[recent.length - 1].ts : null;

  const now = Date.now();
  if (text) { await msgsCol.add({ role: "user", content: text, ts: now }); recent.push({ role: "user", content: text }); }

  const messages = [
    { role: "system", content: L.buildSystemPrompt({ mood: u.mood, affection: u.affection, facts: u.facts, lastTs }, now) },
    ...recent.map(({ role, content }) => ({ role, content })),
  ];
  if (proactive) {
    const idle = Math.max(1, Math.min(600, Number(req.data?.idleMinutes) || 10));
    messages.push({ role: "system", content: `（系統提示，不要提到這段：他已經 ${idle} 分鐘沒有說話。依照現在的時間和你的心情，主動跟他說話。不要重複你上一次說過的話。）` });
  }

  const { text: raw, usd } = await callOpenRouter(messages);
  const { parts, mood } = L.parseReply(raw);
  const st = L.nextMood({ mood: u.mood, affection: u.affection }, mood);
  await msgsCol.add({ role: "assistant", content: parts.join("||"), ts: Date.now() });
  const msgCount = (u.msgCount || 0) + (text ? 2 : 1);
  await userRef(uid).update({ mood: st.mood, affection: st.affection, msgCount });
  await charge(uid, "chat", usd);

  // 每 16 則整理一次長期記憶（成本也記在使用者帳上）
  if (Math.floor(msgCount / 16) > Math.floor((u.msgCount || 0) / 16)) {
    await extractFacts(uid, u.facts || []).catch((e) => console.warn("facts", e));
  }

  const after = (await userRef(uid).get()).data();
  return { parts, mood: after.mood, affection: after.affection, balance: after.balance };
});

async function extractFacts(uid, known) {
  const recent = (await userRef(uid).collection("messages").orderBy("ts", "desc").limit(20).get()).docs.map((d) => d.data()).reverse();
  const convo = recent.map((m) => `${m.role === "user" ? "他" : "我"}：${L.displayText(m.content)}`).join("\n");
  const { text, usd } = await callOpenRouter([
    { role: "system", content: "你負責整理記憶。只輸出新的條列，每行以「- 」開頭，沒有就輸出「無」。" },
    { role: "user", content: `已知事實：\n${known.map((f) => "- " + f).join("\n") || "（無）"}\n\n最近對話：\n${convo}\n\n請整理「他」透露的、值得長期記住的新事實（姓名、工作、喜好、計畫、重要日子、在意的事），不要重複已知事實，不要記錄短暫情緒。` },
  ], { temperature: 0.2, max_tokens: 300 });
  const add = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter((f) => f && !known.includes(f));
  if (add.length) await userRef(uid).update({ facts: [...known, ...add].slice(-80) });
  await charge(uid, "memory", usd);
}

// ---------- 語音 ----------
exports.tts = onCall({ secrets: [ELEVEN_KEY], timeoutSeconds: 60 }, async (req) => {
  const uid = requireAuth(req);
  const text = String(req.data?.text || "").trim().slice(0, C.MAX_TTS_CHARS);
  if (!text) throw new HttpsError("invalid-argument", "沒有文字");
  await gate(uid, "tts");

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(C.ELEVEN_VOICE_ID)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY.value(), "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: C.ELEVEN_MODEL, language_code: "zh" }),
  });
  if (!r.ok) {
    console.error("ElevenLabs", r.status, await r.text().catch(() => ""));
    throw new HttpsError("unavailable", "語音暫時無法使用");
  }
  const audio = Buffer.from(await r.arrayBuffer()).toString("base64");
  await charge(uid, "tts", L.ttsCostUsd(text), { chars: text.length });
  const after = (await userRef(uid).get()).data();
  return { audio, balance: after.balance };
});

// ---------- 使用者自己管理記憶 ----------
exports.forgetFact = onCall(async (req) => {
  const uid = requireAuth(req);
  const fact = String(req.data?.fact || "");
  await userRef(uid).update({ facts: FieldValue.arrayRemove(fact) });
  return { ok: true };
});

exports.resetChat = onCall(async (req) => {
  const uid = requireAuth(req);
  const all = !!req.data?.all;
  const col = userRef(uid).collection("messages");
  for (;;) {
    const snap = await col.limit(400).get();
    if (snap.empty) break;
    const b = db.batch(); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit();
  }
  await userRef(uid).update(all ? { msgCount: 0, facts: [], mood: "平靜", affection: 60 } : { msgCount: 0 });
  return { ok: true };
});

// ---------- 管理員 ----------
exports.adminListUsers = onCall(async (req) => {
  if (!isAdmin(req.auth)) throw new HttpsError("permission-denied", "只有管理員可以使用");
  const snap = await db.collection("users").orderBy("createdAt", "desc").limit(500).get();
  return snap.docs.map((d) => {
    const u = d.data();
    return { uid: d.id, email: u.email, name: u.name, balance: L.round4(u.balance || 0), spentUsd: L.round4(u.spentUsd || 0), msgCount: u.msgCount || 0, createdAt: u.createdAt };
  });
});

exports.adminAddPoints = onCall(async (req) => {
  if (!isAdmin(req.auth)) throw new HttpsError("permission-denied", "只有管理員可以使用");
  const uid = String(req.data?.uid || "");
  const points = Number(req.data?.points);
  const note = String(req.data?.note || "").slice(0, 100);
  if (!uid || !Number.isFinite(points) || points === 0 || Math.abs(points) > 100000) throw new HttpsError("invalid-argument", "點數不正確");
  const ref = userRef(uid);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "找不到這個使用者");
  const batch = db.batch();
  batch.update(ref, { balance: FieldValue.increment(points) });
  batch.set(ref.collection("ledger").doc(), { type: "topup", points, ts: Date.now(), note, by: req.auth.token.email });
  await batch.commit();
  return { balance: (await ref.get()).data().balance };
});
