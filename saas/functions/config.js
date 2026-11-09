// ===== 商業設定：價格、模型、管理員（改完重新部署 functions 生效）=====
module.exports = {
  // 管理員 Email：寫在 functions/.env 的 ADMIN_EMAILS（逗號分隔），不放進 GitHub
  ADMIN_EMAILS: (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean),

  // 點數：1 點 = 新台幣 1 元
  TWD_PER_USD: 32,          // 匯率
  MARKUP: 3,                // 售價 = API 成本 × 這個倍數（3 = 毛利約 67%）
  TRIAL_POINTS: 20,         // 新使用者免費試用點數
  MIN_BALANCE: 0.3,         // 低於這個餘額就不能再聊

  // 聊天模型（OpenRouter）
  CHAT_MODEL: "anthropic/claude-sonnet-5.5",
  // 萬一 OpenRouter 沒回傳實際花費時，用這個價格估算（美元 / 每百萬 token）
  CHAT_PRICE_IN: 2.0,
  CHAT_PRICE_OUT: 10.0,
  MAX_CONTEXT_MESSAGES: 30,

  // 語音（ElevenLabs）
  ELEVEN_VOICE_ID: "請填入 Voice ID",
  ELEVEN_MODEL: "eleven_v3",
  // ElevenLabs 每個字元的成本（美元）。依你的方案換算：方案月費 ÷ 方案字數
  // 例如 Creator 方案 22 美元 / 100,000 字 ≈ 0.00022
  ELEVEN_USD_PER_CHAR: 0.00022,

  // 限流
  RATE_LIMIT_PER_MINUTE: 8,      // 聊天：每分鐘最多幾次
  TTS_LIMIT_PER_MINUTE: 30,      // 語音：每分鐘最多幾段
  MAX_INPUT_CHARS: 500,
  MAX_TTS_CHARS: 300,
};
