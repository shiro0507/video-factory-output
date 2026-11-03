// X(旧Twitter)への動画投稿スクリプト。依存ライブラリなし(Node 22 の fetch / crypto のみ)。
//
// 使い方:
//   node scripts/x-post.mjs post   … data/x_queue.json から1件選んで投稿し、結果を $RESULT_FILE に書く
//   node scripts/x-post.mjs apply  … $RESULT_FILE の結果を data/x_queue.json に反映する
// post と apply を分けているのは、投稿中にダッシュボードからキューが書き換えられても
// 「最新のキューを pull → 結果だけ反映 → push」できるようにするため(ワークフロー側でリトライ)。
//
// 環境変数:
//   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET … OAuth 1.0a ユーザーコンテキスト
//     (どれか1つでも未設定なら自動的に dry-run になる)
//   ITEM_ID   … 指定するとその id のアイテムを投稿(未指定ならキュー先頭の queued)
//   DRY_RUN   … "true" なら X には何も送らず、動画取得と本文チェックだけ行う
//   QUEUE_FILE (既定 data/x_queue.json) / RESULT_FILE (既定 x_result.json)
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const QUEUE_FILE = process.env.QUEUE_FILE || "data/x_queue.json";
const RESULT_FILE = process.env.RESULT_FILE || "x_result.json";
const API = "https://api.x.com/2";
const CHUNK = 4 * 1024 * 1024; // 公式推奨は 5MB 以下
const MAX_WEIGHT = 280;

const KEYS = {
  consumerKey: process.env.X_API_KEY,
  consumerSecret: process.env.X_API_SECRET,
  token: process.env.X_ACCESS_TOKEN,
  tokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
};
const KEY_ENV = { consumerKey: "X_API_KEY", consumerSecret: "X_API_SECRET", token: "X_ACCESS_TOKEN", tokenSecret: "X_ACCESS_TOKEN_SECRET" };

// ---- 文字数(X の重み付きカウント。twitter-text v3 準拠の近似) ----
// 半角英数・ラテン文字等は1、日本語などそれ以外は2、絵文字(複数コードポイントの書記素)は2、URLは一律23。
// docs/index.html にも同じ関数がある(変えるときは両方)。
export function xWeight(text) {
  const URL_RE = /https?:\/\/\S+/g;
  let w = 0;
  const rest = text.normalize("NFC").replace(URL_RE, () => { w += 23; return ""; });
  const light = (cp) => cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
  for (const { segment } of new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(rest)) {
    const cps = [...segment];
    w += cps.length === 1 && light(cps[0].codePointAt(0)) ? 1 : 2;
  }
  return w;
}

// ---- OAuth 1.0a 署名 ----
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function oauthHeader(method, url, query = {}) {
  const oauth = {
    oauth_consumer_key: KEYS.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: KEYS.token,
    oauth_version: "1.0",
  };
  // JSON / multipart の本文は署名対象外。クエリパラメータのみ含める
  const params = { ...query, ...oauth };
  const paramStr = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  const base = [method.toUpperCase(), enc(url), enc(paramStr)].join("&");
  const key = `${enc(KEYS.consumerSecret)}&${enc(KEYS.tokenSecret)}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
}

async function xFetch(method, path, { query, json, form } = {}) {
  const url = `${API}${path}`;
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const headers = { Authorization: oauthHeader(method, url, query) };
  let body;
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form; // Content-Type(boundary付き)は fetch が付ける
  const res = await fetch(url + qs, { method, headers, body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非JSON */ }
  if (!res.ok) {
    const remaining = res.headers.get("x-rate-limit-remaining");
    throw new Error(`X API ${method} ${path} → ${res.status}${remaining != null ? ` (rate-limit-remaining ${remaining})` : ""}: ${text.slice(0, 500)}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadVideo(buf) {
  const init = await xFetch("POST", "/media/upload/initialize", {
    json: { media_type: "video/mp4", total_bytes: buf.length, media_category: "tweet_video" },
  });
  const id = init?.data?.id;
  if (!id) throw new Error(`initialize の応答に id がありません: ${JSON.stringify(init)}`);
  console.log(`media id: ${id}`);

  for (let i = 0, off = 0; off < buf.length; i++, off += CHUNK) {
    const form = new FormData();
    form.append("segment_index", String(i));
    form.append("media", new Blob([buf.subarray(off, off + CHUNK)]), `chunk${i}`);
    await xFetch("POST", `/media/upload/${id}/append`, { form });
    console.log(`append #${i} (${Math.min(off + CHUNK, buf.length)}/${buf.length} bytes)`);
  }

  let info = (await xFetch("POST", `/media/upload/${id}/finalize`))?.data?.processing_info;
  for (let n = 0; info && info.state !== "succeeded"; n++) {
    if (info.state === "failed") throw new Error(`動画の処理に失敗: ${JSON.stringify(info)}`);
    if (n >= 60) throw new Error("動画処理がタイムアウトしました");
    await sleep(Math.max(1, info.check_after_secs || 5) * 1000);
    info = (await xFetch("GET", "/media/upload", { query: { command: "STATUS", media_id: id } }))?.data?.processing_info;
    console.log(`processing: ${info?.state ?? "done"} ${info?.progress_percent ?? ""}`);
  }
  return id;
}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { items: [] };
  return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
}

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

async function post() {
  const q = loadQueue();
  const want = (process.env.ITEM_ID || "").trim();
  const item = want
    ? q.items.find((it) => it.id === want)
    : q.items.find((it) => it.status === "queued");
  if (!item) {
    console.log(want ? `::error::id=${want} のアイテムがキューにありません` : "キューに queued のアイテムはありません。終了します。");
    if (want) process.exit(1);
    return;
  }
  if (item.status === "posted") {
    console.log(`::error::${item.id} は投稿済みです (tweet ${item.tweet_id})`);
    process.exit(1);
  }

  const missing = Object.entries(KEYS).filter(([, v]) => !v).map(([k]) => KEY_ENV[k]);
  const dry = process.env.DRY_RUN === "true" || missing.length > 0;
  if (missing.length) console.log(`::notice::X のキーが未設定のため dry-run で実行します(未設定: ${missing.join(", ")})`);

  const videoUrl = `https://raw.githubusercontent.com/${item.repo}/${item.branch}/${item.dir}/video.mp4`;
  console.log(`対象: ${item.id}\n動画: ${videoUrl}`);
  const weight = xWeight(item.text);
  console.log(`本文(${weight}/${MAX_WEIGHT}):\n${item.text}\n`);

  let result;
  try {
    if (!item.text?.trim()) throw new Error("本文が空です");
    if (weight > MAX_WEIGHT) throw new Error(`本文が長すぎます(${weight}/${MAX_WEIGHT})`);
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`動画の取得に失敗 (${res.status}): ${videoUrl}`);
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`動画サイズ: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
    if (buf.length > 512 * 1024 * 1024) throw new Error("動画が 512MB を超えています");

    if (dry) {
      console.log("dry-run: X には送信しませんでした(キューも変更しません)");
      setOutput("dry_run", "true");
      return;
    }

    const mediaId = await uploadVideo(buf);
    const tw = await xFetch("POST", "/tweets", { json: { text: item.text, media: { media_ids: [mediaId] } } });
    const tweetId = tw?.data?.id;
    if (!tweetId) throw new Error(`投稿の応答に id がありません: ${JSON.stringify(tw)}`);
    console.log(`投稿しました: https://x.com/i/status/${tweetId}`);
    result = { id: item.id, ok: true, tweet_id: tweetId, at: new Date().toISOString() };
  } catch (e) {
    if (dry) { console.log(`::error::${e.message}`); process.exit(1); }
    console.log(`::error::${e.message}`);
    result = { id: item.id, ok: false, error: e.message.slice(0, 800), at: new Date().toISOString() };
  }
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  setOutput("ok", String(result.ok));
}

function apply() {
  if (!existsSync(RESULT_FILE)) { console.log("反映する結果はありません"); return; }
  const r = JSON.parse(readFileSync(RESULT_FILE, "utf8"));
  const q = loadQueue();
  const item = q.items.find((it) => it.id === r.id);
  if (!item) { console.log(`::warning::${r.id} がキューから消えていたため反映できませんでした`); return; }
  item.attempted_at = r.at;
  if (r.ok) {
    item.status = "posted";
    item.tweet_id = r.tweet_id;
    item.posted_at = r.at;
    delete item.error;
  } else {
    item.status = "failed";
    item.error = r.error;
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2) + "\n");
  console.log(`${r.id} → ${item.status}`);
}

const cmd = process.argv[2];
if (cmd === "post") await post();
else if (cmd === "apply") apply();
else if (cmd) { console.error(`未知のコマンド: ${cmd}`); process.exit(2); }
