// 用記憶體模擬 Firestore + 假的 OpenRouter / ElevenLabs，測試後端計費邏輯
const path = require("path");
const assert = require("assert");
const FN = process.argv[2] || path.join(__dirname, "..");
const Module = require("module");
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || "admin@example.com";

// ---------- 迷你 Firestore ----------
const data = new Map(); // path -> object
let autoId = 0;
const INC = Symbol("inc"), AREM = Symbol("arem");
const applyUpdate = (cur, upd) => {
  const out = { ...cur };
  for (const [k, v] of Object.entries(upd)) {
    if (v && v[INC] !== undefined) out[k] = (out[k] || 0) + v[INC];
    else if (v && v[AREM]) out[k] = (out[k] || []).filter((x) => !v[AREM].includes(x));
    else out[k] = v;
  }
  return out;
};
function docRef(p) {
  return {
    path: p, id: p.split("/").pop(),
    collection: (c) => colRef(p + "/" + c),
    async get() { return snap(p); },
    async set(o) { data.set(p, { ...o }); },
    async update(o) { if (!data.has(p)) throw new Error("no doc " + p); data.set(p, applyUpdate(data.get(p), o)); },
    async delete() { data.delete(p); },
  };
}
const snap = (p) => ({ id: p.split("/").pop(), ref: docRef(p), exists: data.has(p), data: () => (data.has(p) ? { ...data.get(p) } : undefined) });
function colRef(p, opts = {}) {
  const children = () => [...data.keys()].filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"));
  return {
    doc: (id) => docRef(p + "/" + (id || "auto" + ++autoId)),
    async add(o) { const r = docRef(p + "/auto" + ++autoId); await r.set(o); return r; },
    orderBy: (f, dir = "asc") => colRef(p, { ...opts, f, dir }),
    limit: (n) => colRef(p, { ...opts, n }),
    async get() {
      let ks = children().map((k) => ({ k, d: data.get(k) }));
      if (opts.f) ks.sort((a, b) => (opts.dir === "desc" ? -1 : 1) * ((a.d[opts.f] ?? 0) - (b.d[opts.f] ?? 0)));
      if (opts.n) ks = ks.slice(0, opts.n);
      const docs = ks.map(({ k }) => snap(k));
      return { docs, empty: !docs.length, forEach: (f) => docs.forEach(f) };
    },
  };
}
const firestore = () => ({
  collection: (c) => colRef(c),
  async runTransaction(fn) {
    const ops = [];
    const tx = { get: (r) => r.get(), update: (r, o) => ops.push(() => r.update(o)) };
    const res = await fn(tx); for (const op of ops) await op(); return res;
  },
  batch() { const ops = []; return {
    set: (r, o) => ops.push(() => r.set(o)), update: (r, o) => ops.push(() => r.update(o)), delete: (r) => ops.push(() => r.delete()),
    commit: async () => { for (const op of ops) await op(); } }; },
});
firestore.FieldValue = { increment: (n) => ({ [INC]: n }), arrayRemove: (...v) => ({ [AREM]: v }) };
const fakeAdmin = { initializeApp() {}, firestore };

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const handlers = {};
const fakeHttps = { HttpsError, onCall: (a, b) => b || a };
const fakeV2 = { setGlobalOptions() {} };
const fakeParams = { defineSecret: (n) => ({ value: () => "secret-" + n }) };

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "firebase-admin") return fakeAdmin;
  if (req === "firebase-functions/v2/https") return fakeHttps;
  if (req === "firebase-functions/v2") return fakeV2;
  if (req === "firebase-functions/params") return fakeParams;
  return origLoad.call(this, req, ...rest);
};

// ---------- 假 API ----------
let fetchLog = [];
let openrouterCost = 0.002;
global.fetch = async (url, opt) => {
  fetchLog.push({ url, opt });
  if (url.includes("openrouter")) {
    const body = JSON.parse(opt.body);
    assert.equal(opt.headers.Authorization, "Bearer secret-OPENROUTER_KEY");
    assert.ok(body.usage?.include, "要求回報實際花費");
    const isFacts = body.messages[0].content.includes("整理記憶");
    return { ok: true, json: async () => ({
      choices: [{ message: { content: isFacts ? "- 他叫 Harry\n- 他是程式老師" : "[心情:開心]\n欸你來啦||今天[laughs]好開心" } }],
      usage: { cost: openrouterCost, prompt_tokens: 1000, completion_tokens: 50 } }) };
  }
  if (url.includes("elevenlabs")) {
    assert.equal(opt.headers["xi-api-key"], "secret-ELEVEN_KEY");
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  }
  throw new Error("unexpected " + url);
};

const F = require(path.join(FN, "index.js"));
const C = require(path.join(FN, "config.js"));
const user = (uid, email = "u@x.com", verified = true) => ({ auth: { uid, token: { email, name: "U", email_verified: verified } } });
const call = (fn, req, d = {}) => F[fn]({ ...req, data: d });
const expectErr = async (p, code) => { try { await p; assert.fail("應該要失敗"); } catch (e) { assert.equal(e.code, code, e.message); } };
const close = (a, b) => Math.abs(a - b) < 1e-6;

(async () => {
  const A = user("alice");
  // 未登入
  await expectErr(call("chat", {}, { text: "hi" }), "unauthenticated");
  // 未初始化
  await expectErr(call("chat", A, { text: "hi" }), "failed-precondition");

  // 初始化送試用點數，重複呼叫不會重送
  let r = await call("init", A); assert.equal(r.balance, C.TRIAL_POINTS);
  r = await call("init", A); assert.equal(r.balance, C.TRIAL_POINTS);
  assert.equal(r.isAdmin, false);
  console.log("✓ 初始化與試用點數");

  // 聊天扣點 = 成本 × 匯率 × 倍率
  r = await call("chat", A, { text: "嗨" });
  const per = 0.002 * C.TWD_PER_USD * C.MARKUP;
  assert.deepEqual(r.parts, ["欸你來啦", "今天[laughs]好開心"]);
  assert.equal(r.mood, "開心"); assert.equal(r.affection, 62);
  assert.ok(close(r.balance, C.TRIAL_POINTS - per), `balance ${r.balance}`);
  console.log(`✓ 聊天扣點：每句 ${per.toFixed(4)} 點，餘額 ${r.balance}`);

  // 空訊息、過長訊息
  await expectErr(call("chat", A, { text: "" }), "invalid-argument");
  await expectErr(call("chat", A, { text: "字".repeat(C.MAX_INPUT_CHARS + 1) }), "invalid-argument");
  console.log("✓ 輸入檢查");

  // 語音扣點
  const before = r.balance;
  r = await call("tts", A, { text: "今天好開心" });
  assert.equal(r.audio, Buffer.from([1, 2, 3]).toString("base64"));
  const ttsPts = 5 * C.ELEVEN_USD_PER_CHAR * C.TWD_PER_USD * C.MARKUP;
  assert.ok(close(r.balance, before - ttsPts));
  console.log(`✓ 語音扣點：5 個字 ${ttsPts.toFixed(4)} 點`);

  // 限流：一分鐘內超過上限會被擋
  const B = user("bob"); await call("init", B);
  for (let i = 0; i < C.RATE_LIMIT_PER_MINUTE; i++) await call("chat", B, { text: "hi" + i });
  await expectErr(call("chat", B, { text: "too fast" }), "resource-exhausted");
  console.log(`✓ 限流：每分鐘 ${C.RATE_LIMIT_PER_MINUTE} 次後擋下`);

  // 記憶整理：每 16 則觸發，且也會扣點
  const facts = data.get("users/bob").facts;
  assert.deepEqual(facts, ["他叫 Harry", "他是程式老師"], JSON.stringify(facts));
  const ledgerTypes = [...data.entries()].filter(([k]) => k.startsWith("users/bob/ledger/")).map(([, v]) => v.type);
  assert.ok(ledgerTypes.includes("memory"));
  console.log("✓ 長期記憶整理（第 16 則觸發，並記帳）");

  // 點數不足就擋，不會呼叫付費 API
  const Cz = user("carol"); await call("init", Cz);
  data.set("users/carol", { ...data.get("users/carol"), balance: 0.1 });
  const n = fetchLog.length;
  await expectErr(call("chat", Cz, { text: "hi" }), "resource-exhausted");
  await expectErr(call("tts", Cz, { text: "hi" }), "resource-exhausted");
  assert.equal(fetchLog.length, n, "餘額不足時不應呼叫 API");
  console.log("✓ 點數不足會擋下，且不會產生 API 成本");

  // 管理員權限
  await expectErr(call("adminListUsers", A), "permission-denied");
  await expectErr(call("adminAddPoints", A, { uid: "carol", points: 100 }), "permission-denied");
  const fakeAdminUser = user("evil", C.ADMIN_EMAILS[0], false); // 信箱沒驗證不算
  await expectErr(call("adminListUsers", fakeAdminUser), "permission-denied");
  const H = user("harry", C.ADMIN_EMAILS[0]);
  const list = await call("adminListUsers", H); assert.ok(list.length >= 3);
  r = await call("adminAddPoints", H, { uid: "carol", points: 100, note: "轉帳 12345" });
  assert.ok(close(r.balance, 100.1));
  await expectErr(call("adminAddPoints", H, { uid: "nobody", points: 10 }), "not-found");
  await expectErr(call("adminAddPoints", H, { uid: "carol", points: "abc" }), "invalid-argument");
  r = await call("chat", Cz, { text: "我儲值了" }); assert.ok(r.balance < 100.1);
  console.log("✓ 管理員權限與加點數（一般使用者、未驗證信箱都擋下）");

  // 忘記記憶、清空對話
  await call("forgetFact", B, { fact: "他叫 Harry" });
  assert.deepEqual(data.get("users/bob").facts, ["他是程式老師"]);
  await call("resetChat", B, { all: true });
  assert.equal([...data.keys()].filter((k) => k.startsWith("users/bob/messages/")).length, 0);
  assert.deepEqual(data.get("users/bob").facts, []);
  console.log("✓ 忘記記憶、清空對話");

  // 主動訊息
  data.set("users/alice", { ...data.get("users/alice"), rlChat: null });
  r = await call("chat", A, { proactive: true, idleMinutes: 15 });
  const last = JSON.parse(fetchLog.filter((f) => f.url.includes("openrouter")).pop().opt.body);
  assert.ok(last.messages.at(-1).content.includes("15 分鐘"));
  console.log("✓ 主動找你說話");

  // 帳本加總 = 餘額變化
  const led = [...data.entries()].filter(([k]) => k.startsWith("users/alice/ledger/")).map(([, v]) => v.points);
  assert.ok(close(led.reduce((a, b) => a + b, 0), data.get("users/alice").balance));
  console.log("✓ 帳本加總與餘額一致");
  console.log("\n全部通過");
})().catch((e) => { console.error("✗", e); process.exit(1); });
