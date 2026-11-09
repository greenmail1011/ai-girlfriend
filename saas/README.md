# 小晴 商業版（MVP）

使用者用 Google 登入、儲值點數，聊天和語音依實際 API 成本 × 倍率扣點。你的 API 金鑰只存在 Firebase 後端，使用者看不到。

```
saas/
├── firebase.json          Firebase 設定
├── firestore.rules        安全規則：使用者只能讀自己的資料，不能改餘額
├── functions/             後端（API 金鑰在這裡）
│   ├── config.js          ← 價格、倍率、模型、Voice ID 都在這裡改
│   ├── persona.js         角色設定
│   ├── index.js           chat / tts / 管理員功能
│   ├── .env.example       複製成 .env，填管理員 Email（不會上傳 GitHub）
│   └── test/              計費測試：npm test
└── public/                前端網頁
    ├── firebase-config.js ← 貼上你的 Firebase 設定、儲值說明
    ├── index.html         主畫面
    ├── admin.html         管理後台（只有管理員能用）
    └── terms.html / privacy.html  條款草稿（上線收費前請律師看過）
```

## 部署步驟（第一次大約 30 分鐘）

### 1. 建立 Firebase 專案
1. 到 https://console.firebase.google.com 按「新增專案」，例如取名 `xiaoqing-ai`
2. 左下角「升級」→ 選 **Blaze（隨用隨付）**，綁信用卡。Cloud Functions 要呼叫外部 API 一定要 Blaze；MVP 流量通常在免費額度內
3. 建議在 Google Cloud 主控台設定**預算提醒**（例如每月 10 美元），超過會寄信通知你

### 2. 開啟需要的服務
- **Authentication** → 開始使用 → 登入方式 → 啟用 **Google**
- **Firestore Database** → 建立資料庫 → 地區選 `asia-east1（台灣）` → 正式版模式
- 專案設定 → 一般 → 「你的應用程式」→ 新增**網頁應用程式** → 複製 `firebaseConfig`，貼到 `public/firebase-config.js`

### 3. 填設定
- `public/firebase-config.js`：貼上 firebaseConfig；`TOPUP_TEXT` 改成你的儲值方式
- `functions/config.js`：把 `ELEVEN_VOICE_ID` 改成你的 Voice ID（Nydia 那個）；`ELEVEN_USD_PER_CHAR` 依你買的 ElevenLabs 方案換算
- `functions/.env.example` 複製成 `functions/.env`，`ADMIN_EMAILS=` 填你的 Gmail

> ⚠️ 這個 repo 是公開的。銀行帳號這類資訊**不要**寫進 `firebase-config.js` 再推上 GitHub，可以寫「請私訊 LINE：xxx」之類的聯絡方式。

### 4. 在你的電腦上部署
需要先裝好 Node.js（22 版）。在終端機執行：

```bash
npm install -g firebase-tools
firebase login
cd ai-girlfriend/saas
firebase use --add            # 選剛剛建立的專案
cd functions && npm install && npm test && cd ..

# 把 API 金鑰存進 Secret Manager（會要你貼上金鑰，不會顯示在畫面上）
firebase functions:secrets:set OPENROUTER_KEY
firebase functions:secrets:set ELEVEN_KEY

firebase deploy
```

部署完會給你一個網址，例如 `https://xiaoqing-ai.web.app`。

### 5. 測試
1. 打開網址，用 Google 登入，應該會看到 💎 20 點的試用點數
2. 跟她說話，確認點數有減少
3. 打開 `你的網址/admin.html`，應該看得到自己，試著幫自己加點數

## 計費怎麼算
- 聊天：OpenRouter 回報的實際花費（美元）× `TWD_PER_USD` × `MARKUP`
- 語音：字數 × `ELEVEN_USD_PER_CHAR` × `TWD_PER_USD` × `MARKUP`
- 每 16 則訊息會整理一次長期記憶，這次呼叫也照成本扣點
- 以預設值（Claude Sonnet 5.5、倍率 3）估算：一句聊天約 0.5～1 點（對話越長越貴），一段 20 字的語音約 0.4 點

改價格只要改 `functions/config.js` 後執行 `firebase deploy --only functions`。

## 之後可以做
- 接綠界／藍新金流，付款成功自動加點數
- 每日登入送點數、儲值方案（買越多送越多）
- 使用者自選聲音、自選角色
