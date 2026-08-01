# 変更履歴

このプロジェクトは [セマンティック バージョニング](https://semver.org/lang/ja/) に従う。

## [0.9.0] - 2026-08-01

最初の公開版。作者の環境（macOS 26 / Apple Silicon / Claude Max / Codex team）では
実運用で安定しているが、**他人の環境での導入実績がまだ無い**ため 0.9 とする。
別の環境で導入が確認できた時点で 1.0.0 にする。

### 収集（Mac）

- Claude は keychain の OAuth トークンで `api.anthropic.com/api/oauth/usage`
- Codex は `~/.codex/auth.json` のトークンで `chatgpt.com/backend-api/codex/usage`。
  失敗時のみ rollout JSONL にフォールバック（API → JSONL → 前回値）
- launchd で 30 分ごとに実行（`install.sh`）
- 取得に失敗した側は前回の値を残し、`status` を差し替えて `stale` を立てる
- アクセストークンが失効したら `claude -p` を 1 回だけ呼んで公式に更新させる
  （1 時間に 1 回まで。リフレッシュトークンは自前で使わない）

### 表示（iPhone / Scriptable）

- 共有リンク（HTTPS）→ iCloud → 端末内の控え の順に取得し、
  `generated_at` が最も新しいものを採用する
- 共有リンクは Dropbox / Google ドライブ / OneDrive / 自前サーバーに対応。
  リンクは Keychain に保存し、スクリプトには書き込まない
- small / medium / large でレイアウトを変える（medium は 2 列）
- 端末の言語に追従（日本語 / 英語）

### 既知の制約

- 非公開エンドポイントに依存しており、予告なく壊れる
- Claude Max / Codex team 以外のプランは未検証
- ウィジェット拡張からは iCloud のダウンロードを起こせないため、
  共有リンクを登録しない場合は表示が古くなることがある
