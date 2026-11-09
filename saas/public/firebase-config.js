// ===== 到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式（網頁），複製 firebaseConfig 貼在這裡 =====
// 這些值會公開在網頁上，這是正常的，安全性由登入和 Firestore 規則保護。
export const firebaseConfig = {
  apiKey: "請填入",
  authDomain: "請填入.firebaseapp.com",
  projectId: "請填入",
  storageBucket: "請填入.appspot.com",
  messagingSenderId: "請填入",
  appId: "請填入",
};
export const FUNCTIONS_REGION = "asia-east1";

// 儲值說明（MVP 先手動儲值；之後接綠界／藍新再換掉）
export const TOPUP_TEXT = `目前採人工儲值：
1. 轉帳到：（請填入你的銀行帳號）
2. 轉帳後把「轉帳末五碼」和下面的會員代碼傳給管理員
3. 確認後會幫你加點數（1 點 = NT$1）`;
