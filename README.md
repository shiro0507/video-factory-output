# video-factory-output

GCP(Cloud Run Jobs)でレンダリングした動画を受け取り、GitHub Actions から
Instagram Reels へ自動投稿するためのリポジトリ。

## 仕組み

```
GCP Cloud Run Job                このリポジトリ                人間                GitHub Actions
────────────────────             ──────────────────            ────                ─────────────────────
台本取得→生成→レンダリング ─→ Release をdraft作成    ─→  内容確認         ─→  (release: published)
                                output-*.mp4 と            "Publish release"        .meta.json を読む
                                *.meta.json をアセット添付                          mp4の公開URLを解決
                                                                                    Instagram Graph APIで投稿
```

- レンダリングの重い処理は GCP、投稿は Actions に分離
- 動画の受け渡しは **Release アセット**（公開リポジトリなので mp4 の
  ダウンロードURLがそのまま Instagram の `video_url` に使える）
- **公開前に人間のレビューを挟む**: GCP側は Release を **draft** のまま作成する
  （`GITHUB_RELEASE_AUTO_PUBLISH=true` を指定しない限り自動publishしない）。
  [Releases](../../releases) で draft を開き、動画とキャプションを確認して
  問題なければ **Publish release** を押すとその場で Actions が発火して投稿される。
  却下する場合は draft を削除すればよい（投稿は発生しない）。

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
