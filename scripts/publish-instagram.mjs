// scripts/publish-instagram.mjs
// Instagram へ1件投稿する。Reels(動画)とカルーセル(画像2〜10枚)の両方に対応。
//
// 必須env:
//   INSTAGRAM_ACCESS_TOKEN  … システムユーザーの無期限トークン
//   INSTAGRAM_ACCOUNT_ID    … IG プロアカウントのユーザーID
// 任意env:
//   MEDIA_TYPE      … "REELS"(既定) または "CAROUSEL"
//   VIDEO_URL       … MEDIA_TYPE=REELS のとき必須。公開アクセス可能な mp4 の URL
//   IMAGE_URLS      … MEDIA_TYPE=CAROUSEL のとき必須。カンマ区切りの画像URL(2〜10件、表示順)
//   CAPTION         … 投稿本文(ハッシュタグ含む)
//   SHARE_TO_FEED   … "false" で Reels をフィードに出さない(既定: true。CAROUSELでは無視)
//   GRAPH_VERSION   … 既定 "v21.0"
//
// 使い方:
//   REELS:    VIDEO_URL=... node scripts/publish-instagram.mjs
//   CAROUSEL: MEDIA_TYPE=CAROUSEL IMAGE_URLS="url1,url2,url3" node scripts/publish-instagram.mjs

const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const MEDIA_TYPE = (process.env.MEDIA_TYPE || "REELS").toUpperCase();
const VIDEO_URL = process.env.VIDEO_URL;
const IMAGE_URLS = (process.env.IMAGE_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
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
if (MEDIA_TYPE !== "REELS" && MEDIA_TYPE !== "CAROUSEL") die(`未対応の MEDIA_TYPE: ${MEDIA_TYPE}`);
if (MEDIA_TYPE === "REELS" && !VIDEO_URL) die("VIDEO_URL が未設定です");
if (MEDIA_TYPE === "CAROUSEL") {
  if (IMAGE_URLS.length < 2) die(`カルーセルには画像が2枚以上必要です(現在${IMAGE_URLS.length}枚)`);
  if (IMAGE_URLS.length > 10) die(`カルーセルは画像10枚までです(現在${IMAGE_URLS.length}枚)`);
}

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

// 動画・カルーセルコンテナ共通: 処理完了(status_code=FINISHED)までポーリング
async function waitUntilFinished(creationId) {
  const INTERVAL_MS = 15000;
  const MAX_ATTEMPTS = 40; // 40 * 15s = 10分
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const st = await get(creationId, "status_code,status");
    console.log(`  [${i}/${MAX_ATTEMPTS}] status_code=${st.status_code}`);
    if (st.status_code === "FINISHED") return;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      die(`処理失敗: ${JSON.stringify(st)}`);
    }
    if (i === MAX_ATTEMPTS) die("処理がタイムアウトしました");
  }
}

let creationId;

if (MEDIA_TYPE === "REELS") {
  console.log("[1/3] メディアコンテナ作成中...(REELS)");
  console.log(`  video_url: ${VIDEO_URL}`);
  const container = await post(`${IG_ID}/media`, {
    media_type: "REELS",
    video_url: VIDEO_URL,
    caption: CAPTION,
    share_to_feed: String(SHARE_TO_FEED),
  });
  creationId = container.id;
  if (!creationId) die(`container id が返りませんでした: ${JSON.stringify(container)}`);
  console.log(`  creation_id: ${creationId}`);

  console.log("[2/3] 動画処理待ち...");
  await waitUntilFinished(creationId);
} else {
  console.log(`[1/3] カルーセル子要素を${IMAGE_URLS.length}件作成中...`);
  const childIds = [];
  for (let i = 0; i < IMAGE_URLS.length; i++) {
    const child = await post(`${IG_ID}/media`, {
      image_url: IMAGE_URLS[i],
      is_carousel_item: "true",
    });
    if (!child.id) die(`子要素${i + 1}の作成に失敗: ${JSON.stringify(child)}`);
    console.log(`  [${i + 1}/${IMAGE_URLS.length}] ${child.id}`);
    childIds.push(child.id);
  }

  console.log("[2/3] カルーセルコンテナ作成中...");
  const container = await post(`${IG_ID}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: CAPTION,
  });
  creationId = container.id;
  if (!creationId) die(`カルーセルコンテナ作成に失敗: ${JSON.stringify(container)}`);
  console.log(`  creation_id: ${creationId}`);
  await waitUntilFinished(creationId);
}

// --- 3. 公開 ---
console.log("[3/3] 公開中...");
const published = await post(`${IG_ID}/media_publish`, { creation_id: creationId });
if (!published.id) die(`media_publish が id を返しませんでした: ${JSON.stringify(published)}`);
console.log(`[OK] 投稿完了  media_id: ${published.id}`);
