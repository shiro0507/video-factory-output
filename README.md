# video-factory-output

GCP(Cloud Run Jobs)でレンダリングした動画、または用意した画像を受け取り、
GitHub Actions から Instagram へ自動投稿するためのリポジトリ。
**Reels(動画1本)と画像カルーセル(2〜10枚)の両方に対応。**

## 仕組み

```
GCP Cloud Run Job          このリポジトリ                 レビューUI(人間)              日次バッチ(毎日9:00 JST)      GitHub Actions
────────────────────       ──────────────────             ────────────────             ─────────────────────       ─────────────────────
台本取得→生成→レンダリング ─→ Release をdraft作成   ─→  目視確認・承認          ─→  承認済みキューから    ─→  (release: published)
                            output-*.mp4 と            draft=true,                  最古の1件をpublish          bodyのjsonを読む
                            bodyにmeta埋め込み         prerelease=true に            (draft=false)              mp4の公開URLを解決
                                                        (=投稿待ちキュー)                                        Instagram Graph APIで投稿
```

- レンダリングの重い処理は GCP、投稿は Actions に分離
- 動画の受け渡しは **Release アセット**（公開リポジトリなので mp4 の
  ダウンロードURLがそのまま Instagram の `video_url` に使える）
- ⚠️ Releaseアセットの実体（Azure Blob Storageへのリダイレクト先）はCORS非対応で、
  ブラウザの`fetch()`からは公開済みでも読めない。動画/画像プレビューは
  `<video>`/`<img>`のネイティブ要素で読み込む（CORSの制約を受けない）ため、
  **draft中はレビューUIを開くブラウザでgithub.comにログインしている必要がある**
  （このリポジトリへのアクセス権を持つアカウントで）。publish後は認証不要で見える
- **公開前に人間のレビュー + 投稿頻度の平準化を挟む**（3段階のライフサイクル）:
  1. GCP側は Release を **draft**（`draft=true, prerelease=false`）のまま作成する
     （`GITHUB_RELEASE_AUTO_PUBLISH=true` を指定しない限り自動publishしない）
  2. [レビューUI](https://shiro0507.github.io/video-factory-output/) で動画とキャプションを確認し、
     問題なければ「承認」→ `prerelease=true` になり**投稿待ちキュー**に入る
     （draftのままなのでこの時点ではまだ何も投稿されない）
  3. 毎日9:00(JST)に `daily-batch-publish.yml` が実行され、キューの中から
     **作成日時が最も古い1件だけ**を publish（`draft=false, prerelease=false`）。
     publishが `release:published` イベントを発火し、既存の `publish.yml` が
     Instagram投稿を実行する
  - 却下する場合はレビューUIの「却下して削除」（どの段階でも可）
  - キューから戻したい場合は「キューから戻す」（`prerelease=false` に戻すだけ）

## Release に添付するもの（GCP 側 / アップロードスクリプトが生成）

| 場所 | 内容 |
|---|---|
| アセット: `output-<timestamp>.mp4` | Reels用動画（9:16推奨、最長15分/1GB以内） |
| アセット: `slide-01.jpg` 〜 `slide-10.jpg` | カルーセル用画像（2〜10枚、ファイル名の連番＝表示順） |
| **本文(body)**: `` ```json ... ``` `` ブロック | 投稿メタデータ（下記スキーマ）。アセットではなくbodyに埋め込む(理由は上記CORSの注意点を参照) |

1つの Release には mp4 か 画像群 のどちらか一方のみを添付する（混在不可）。

### メタデータ(Release本文に埋め込むjson)のスキーマ

```json
{
  "caption": "投稿本文をここに。改行可。",
  "hashtags": ["旅行", "vlog", "#already_hashed_ok"],
  "media_type": "REELS",
  "thumb_offset": 408
}
```

- `media_type` は `"REELS"`（既定・省略可）または `"CAROUSEL"`
- `hashtags` の各要素は `#` 有無どちらでも可（ワークフローが付与）
- 最終キャプション = `caption` + 空行 + ハッシュタグを space 連結
- カルーセルの場合、レビューUI・`publish.yml` ともに画像アセットを**ファイル名の昇順**でソートして表示順・投稿順とする
- `thumb_offset`（任意、REELSのみ）: サムネイルに使うフレームのミリ秒位置。省略時はInstagramが自動選択

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

Reels:
```
INSTAGRAM_ACCESS_TOKEN=xxx \
INSTAGRAM_ACCOUNT_ID=xxx \
VIDEO_URL='https://example.com/sample.mp4' \
CAPTION='テスト投稿' \
node scripts/publish-instagram.mjs
```

カルーセル:
```
INSTAGRAM_ACCESS_TOKEN=xxx \
INSTAGRAM_ACCOUNT_ID=xxx \
MEDIA_TYPE=CAROUSEL \
IMAGE_URLS='https://example.com/1.jpg,https://example.com/2.jpg' \
CAPTION='テスト投稿' \
node scripts/publish-instagram.mjs
```
