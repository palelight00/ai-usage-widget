# 変更履歴

このプロジェクトは [セマンティック バージョニング](https://semver.org/lang/ja/) に従う。

## [未リリース]

### 修正

- **Codex が JSONL にフォールバックしたとき `stale` を立てるようにした。**
  これまで `status` は `ok` のままで、183 時間前の値が現在値と同じ明るさで
  描画されていた（実際に発生。9pt の注意書き一行だけが手がかりだった）
- **ウィジェットは「その数値がいつのものか」に `observed_at` を優先する。**
  JSONL 経路の `fetched_at` は読んだ時刻なので、値の古さを表さない
- **ログ行に `codex_api` と `codex_age` を出すようにした。**JSONL に落ちた回も
  `codex=ok` と記録されるため、API がいつ失効したのかを事後に追えなかった

## [0.9.0] - 2026-08-05

最初の公開版。作者の環境（macOS 26 / Apple Silicon / Claude Max / Codex team）では
実運用で安定しているが、**他人の環境での導入実績がまだ無い**ため 0.9 とする。
別の環境で導入が確認できた時点で 1.0.0 にする。

**収集側は macOS 専用、表示側は iOS。**Windows / Linux では動かない。

### 収集（Mac）

- Claude は keychain の OAuth トークンで `api.anthropic.com/api/oauth/usage`
- Codex は `~/.codex/auth.json` のトークンで `chatgpt.com/backend-api/codex/usage`。
  失敗時のみ rollout JSONL にフォールバック（API → JSONL → 前回値）
- launchd で 30 分ごとに実行（`install.sh`）
- 取得に失敗した側は前回の値を残し、`status` を差し替えて `stale` を立てる
- アクセストークンが失効したら `claude -p` を 1 回だけ呼んで公式に更新させる
  （1 時間に 1 回まで。リフレッシュトークンは自前で使わない）
- Claude の追加クレジットは、未使用のとき API の `utilization` が null で返るため、
  使用量と上限から自分で算出する（0% も表示すべき情報なので消さない）

### 表示（iPhone / Scriptable）

- 共有リンク（HTTPS）→ iCloud → 端末内の控え の順に取得し、
  `generated_at` が最も新しいものを採用する
- 共有リンクは Dropbox / Google ドライブ / OneDrive / 自前サーバーに対応。
  リンクは Keychain に保存し、スクリプトには書き込まない
- リンクの入力を求めるのは困っているときだけ（未登録・登録済みだが取得できない・
  ショートカットから明示的に呼んだ）。動いているときは黙って描画する
- クレジットは Claude / Codex とも表示する。Codex は取れた材料から
  無制限 → 残りメッセージ数 → 残高 → クレジットあり の順に選ぶ
- small / medium / large でレイアウトを変える（medium は 2 列）
- 端末の言語に追従（日本語 / 英語）。README も日本語と英語がある

### 既知の制約

- 非公開エンドポイントに依存しており、予告なく壊れる
- Claude Max / Codex team 以外のプランは未検証
- Codex のクレジットは `has_credits` が常に false で実物を確認できていない
  （表示は合成データでのみ確認）
- ウィジェット拡張からは iCloud のダウンロードを起こせないため、
  共有リンクを登録しない場合は表示が古くなることがある
