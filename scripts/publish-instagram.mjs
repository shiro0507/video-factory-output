// scripts/publish-instagram.mjs
// Instagram Reels へ動画を1本投稿する。
//
// 必須env:
//   INSTAGRAM_ACCESS_TOKEN  … システムユーザーの無期限トークン
//   INSTAGRAM_ACCOUNT_ID    … IG プロアカウントのユーザーID
//   VIDEO_URL               … 公開アクセス可能な mp4 の URL(Release アセットの公開URL)
// 任意env:
//   CAPTION                 … 投稿本文(ハッシュタグ含む)
//   SHARE_TO_FEED           … "false" で Reels をフィールドに出さない(既定: true)
//   GRAPH_VERSION           … 既定 "v21.0"
//
// 使い方: node scripts/publish-instagram.mjs

const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const VIDEO_URL = process.env.VIDEO_URL;
const CAPTION = process.env.CAPTION ?? "";
const SHARE_TO_FEED = (process.env.SHARE_TO_FEED ?? "true") !== "false";
const V = process.env.GRAPH_VERSION || "v21.0";
const BASE = `https://graph.facebook.com/${V}`;

function die(msg) {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

if (!TOKEN) die("INSTAGRAM_ACCESS_TOKEN が未設定です");
if (!IG_ID) die("INSTAGRAM_ACCOUNT_ID が未設定です");
if (!VIDEO_URL) die("VIDEO_URL が未設定です");

async function post(path, params) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = await fetch(`${BASE}/${path}`, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(`POST ${path} 失敗: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function get(path, fields) {
  const url = `${BASE}/${path}?fields=${fields}&access_token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(`GET ${path} 失敗: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// --- 1. メディアコンテナ作成 ---
console.log("[1/3] メディアコンテナ作成中...");
console.log(`  video_url: ${VIDEO_URL}`);
const container = await post(`${IG_ID}/media`, {
  media_type: "REELS",
  video_url: VIDEO_URL,
  caption: CAPTION,
  share_to_feed: String(SHARE_TO_FEED),
});
const creationId = container.id;
if (!creationId) die(`container id が返りませんでした: ${JSON.stringify(container)}`);
console.log(`  creation_id: ${creationId}`);

// --- 2. 動画処理完了までポーリング ---
// Reels は非同期エンコードがあり、完了まで数十秒〜数分かかる
console.log("[2/3] 動画処理待ち...");
const INTERVAL_MS = 15000;
const MAX_ATTEMPTS = 40; // 40 * 15s = 10分
for (let i = 1; i <= MAX_ATTEMPTS; i++) {
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
  const st = await get(creationId, "status_code,status");
  console.log(`  [${i}/${MAX_ATTEMPTS}] status_code=${st.status_code}`);
  if (st.status_code === "FINISHED") break;
  if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
    die(`動画処理に失敗: ${JSON.stringify(st)}`);
  }
  if (i === MAX_ATTEMPTS) die("動画処理がタイムアウトしました");
}

// --- 3. 公開 ---
console.log("[3/3] 公開中...");
const published = await post(`${IG_ID}/media_publish`, { creation_id: creationId });
if (!published.id) die(`media_publish が id を返しませんでした: ${JSON.stringify(published)}`);
console.log(`[OK] 投稿完了  media_id: ${published.id}`);
