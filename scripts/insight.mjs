// scripts/insight.mjs
// 投稿済みReelsのインサイト(lifetime)とフォロワー数を取得し、日次スナップショットとして
// JSONファイルに追記する。出力形式は shiro0507/ig_post の data/insta_stats.json を踏襲:
//   {
//     "<media_id>": {
//       "caption": "<先頭30文字>",
//       "created_at": "<投稿日時>",
//       "history": [{ "date": "YYYY-MM-DD", "views": .., "reach": .., "saved": ..,
//                     "total_interactions": .., "likes": .., "comments": .., "shares": .. }]
//     },
//     "follower_history": [{ "date": "YYYY-MM-DD", "followers_count": .. }]
//   }
// 日付はJST。同じ日付のスナップショットが既にあれば追記しない(1日1件)。
//
// 必須env:
//   INSTAGRAM_ACCESS_TOKEN  … システムユーザーの無期限トークン(全アカウント共通)
//   INSTAGRAM_ACCOUNT_ID    … 対象IGアカウントのユーザーID
//   STATS_FILE              … 出力先JSON(例: data/insta_stats.json)
// 任意env:
//   GRAPH_VERSION           … 既定 "v21.0"

import fs from "fs";
import path from "path";

const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const STATS_FILE = process.env.STATS_FILE;
const V = process.env.GRAPH_VERSION || "v21.0";
const BASE = `https://graph.facebook.com/${V}`;
const METRICS = "views,reach,saved,total_interactions,likes,comments,shares";

function die(msg) {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

if (!TOKEN) die("INSTAGRAM_ACCESS_TOKEN が未設定です");
if (!IG_ID) die("INSTAGRAM_ACCOUNT_ID が未設定です");
if (!STATS_FILE) die("STATS_FILE が未設定です");

async function get(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

async function getFollowersCount() {
  const { ok, json } = await get(`${BASE}/${IG_ID}?fields=followers_count&access_token=${encodeURIComponent(TOKEN)}`);
  if (!ok || json.error) {
    console.warn(`[WARN] followers_count を取得できませんでした: ${json.error?.message || "unknown error"}`);
    return null;
  }
  return json.followers_count ?? null;
}

// 全投稿をページングして取得(ig_post版は先頭25件のみだったが、古いReelsも追跡し続けるため全件)
async function listMedia() {
  const all = [];
  let url = `${BASE}/${IG_ID}/media?fields=id,caption,media_type,media_product_type,timestamp&limit=100&access_token=${encodeURIComponent(TOKEN)}`;
  while (url) {
    const { ok, json } = await get(url);
    if (!ok || json.error) die(`メディア一覧の取得失敗: ${JSON.stringify(json.error || json)}`);
    all.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  return all;
}

async function getReelsData() {
  const media = await listMedia();
  const reels = media.filter(
    (m) => (m.media_type === "VIDEO" || m.media_type === "REEL") && m.media_product_type === "REELS",
  );
  const stats = {};
  for (const m of reels) {
    const { json } = await get(
      `${BASE}/${m.id}/insights?metric=${METRICS}&period=lifetime&access_token=${encodeURIComponent(TOKEN)}`,
    );
    const metrics = { date: today };
    if (json.data) {
      for (const d of json.data) {
        if (d.values?.length) metrics[d.name] = d.values[0].value;
        else if ("value" in d) metrics[d.name] = d.value;
      }
    } else {
      console.warn(`[WARN] ${m.id} のインサイトなし: ${json.error?.message || "unknown error"}`);
    }
    stats[m.id] = {
      caption: [...(m.caption || "")].slice(0, 30).join(""),
      created_at: m.timestamp,
      metrics,
    };
  }
  return stats;
}

const data = fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")) : {};

const followers = await getFollowersCount();
if (followers != null) {
  data.follower_history ??= [];
  if (!data.follower_history.some((h) => h.date === today)) {
    data.follower_history.push({ date: today, followers_count: followers });
  }
}

const latest = await getReelsData();
for (const [id, info] of Object.entries(latest)) {
  data[id] ??= { caption: info.caption, created_at: info.created_at, history: [] };
  if (!data[id].history.some((h) => h.date === info.metrics.date)) {
    data[id].history.push(info.metrics);
  }
}

fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2) + "\n");
console.log(`[OK] ${Object.keys(latest).length}件のReelsを ${STATS_FILE} に保存しました (date=${today}, followers=${followers})`);
