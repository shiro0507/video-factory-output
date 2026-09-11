# video-factory-output

GCP(Cloud Run Jobs)でレンダリングした動画を受け取り、GitHub Actions から
Instagram Reels へ自動投稿するためのリポジトリ。

## 仕組み

```
GCP Cloud Run Job                     このリポジトリ                    GitHub Actions
────────────────────                  ──────────────────                ─────────────────────
台本取得→生成→レンダリング   ─→  Release を作成し             ─→  (release: published)
                                   output-*.mp4 と                    .meta.json を読む
                                   *.meta.json をアセット添付           mp4 の公開URLを解決
                                                                       Instagram Graph API で投稿
```

- レンダリングの重い処理は GCP、投稿は Actions に分離
- 動画の受け渡しは **Release アセット**（公開リポジトリなので mp4 の
  ダウンロードURLがそのまま Instagram の `video_url` に使える）

## Release に添付するもの（GCP 側が生成）

| ファイル | 内容 |
|---|---|
| `output-<timestamp>.mp4` | レンダリング済み動画（Reels: 9:16 推奨、最長15分/1GB以内） |
| `<任意>.meta.json` | 投稿メタデータ（下記スキーマ） |

### `.meta.json` スキーマ

```json
{
  "caption": "投稿本文をここに。改行可。",
  "hashtags": ["旅行", "vlog", "#already_hashed_ok"]
}
```

- `hashtags` の各要素は `#` 有無どちらでも可（ワークフローが付与）
- 最終キャプション = `caption` + 空行 + ハッシュタグを space 連結

## 必要な Secrets

| Secret | 用途 |
|---|---|
| `INSTAGRAM_ACCESS_TOKEN` | Meta システムユーザーの無期限アクセストークン |
| `INSTAGRAM_ACCOUNT_ID` | Instagram プロアカウントのユーザーID |

## 手動実行

```
gh workflow run publish.yml -f tag=<リリースタグ>
```

## ローカルでの投稿テスト

```
INSTAGRAM_ACCESS_TOKEN=xxx \
INSTAGRAM_ACCOUNT_ID=xxx \
VIDEO_URL='https://example.com/sample.mp4' \
CAPTION='テスト投稿' \
node scripts/publish-instagram.mjs
```
