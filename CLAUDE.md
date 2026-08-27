# ai-usage — Claude / Codex 使用枠ウィジェット

> このファイルは **Claude Code などの AI コーディング支援に読ませる前提の作業メモ**。
> 「なぜそう作ったか」「何を試して駄目だったか」「再検討しないと決めたこと」を残してある。
> 手を入れる前に読むと、同じ回り道をせずに済む。使い方は `README.md` を見ること。

## これは何か

Claude と Codex のサブスク使用枠（5時間枠・週次枠）を、Mac 側で収集して JSON に書き出し、
iPhone の Scriptable ウィジェットに表示する。手順は `README.md`、実装詳細は
`docs/internals.md` にある。

```
Mac（常時起動）
├─ ai_usage_fetch.py … Claude は非公式 OAuth、Codex は内部 API。
│                      Codex は失敗時のみ ~/.codex のログにフォールバック
├─ launchd で 30 分ごとに実行
└─ 出力: iCloud Drive/Scriptable/ai-usage.json
iPhone
└─ AIUsage.js（Scriptable ウィジェット）が上の JSON を読んで描画
```

## 現在地（最重要）

**Phase 0 / 1 / 2 完了（2026-07-31）。実機で同期まで確認済み。**
残りは運用と、必要になったときの Phase 3（Swift 化）だけ。

**iCloud 経由は使い物にならなかった。**ウィジェット拡張はオンデマンド・ダウンロードを
起こせず、ショートカット経由で読めた中身も 2 時間前だった。4 通り試して解決せず、
**Dropbox 共有リンクを HTTPS で取る方式に変えたところ即座に解決した。**
iCloud に戻そうとしないこと。

前バージョンのこのファイルは「コードは合成データでのみ動作確認済み」と書いていたが、
実際にはコードそのものが存在していなかった。2026-07-26 に実物のレスポンスと
JSONL を見てから書き直したのが現在の `ai_usage_fetch.py`。確定した事実:

- Claude の OAuth トークンは **keychain の `Claude Code-credentials`**。
  `~/.claude/.credentials.json` は**存在しない**（コードは両方見る）。
- `https://api.anthropic.com/api/oauth/usage` は 200 を返す。使うキーは
  `limits[]`（`kind`/`percent`/`resets_at`/`is_active`/`scope.model.display_name`）、
  フォールバックに `five_hour`/`seven_day` の `utilization`、加えて `extra_usage`。
  `PCT_KEYS` などの候補リストは不要になったので廃止した。
- Codex は **`https://chatgpt.com/backend-api/codex/usage`（`~/.codex/auth.json` の
  `tokens.access_token` + `chatgpt-account-id` ヘッダ）が本命**。常に現在値を返す。
  失敗時のみ rollout JSONL（`payload.rate_limits`）にフォールバックする。
- **JSONL はアプリを起動しているだけでは更新されない。** `rate_limits` は API レスポンスに
  同梱されて記録されるため、実際にターンを回さないと 1 件も増えない（実測確認済み）。
  だから「Codex を常時起動しておく」は解決策にならない。
  逆に**アプリはターンなしでも `rate_limits: null` のスタブを一斉に作る**
  （2026-08-27 実測: 深夜に 12 ファイル/秒）。走査窓をファイル数で数えると
  これだけで埋まるので、**有効イベントが取れたファイル数**で数える。
  rollout のファイル名はローカル時刻・行内 timestamp は UTC。
- **openai/codex の開発版は 7 日より古い rollout を `.zst` に圧縮する**（2026-08-26 に
  ソースで確認。mtime 基準・起動時のバックグラウンドジョブ）。効き始めると
  **フォールバックは直近 1 週間ぶんしか読めなくなる**。ただし作者の環境では
  2026-06 の rollout が未圧縮のまま＝インストール版には未搭載らしく、いまの
  「イベントなし」は「最近ターンを回していない」のが原因。行フォーマットと
  保存先（`token_count` の `rate_limits`・`window_minutes`・unix 秒）は変わっていない。
- **Codex のトークンは約 10 日もつ。Claude の約 8 時間とは桁が違う**
  （`auth.json` の `access_token` は JWT。`exp` を読んで `token_expires_at` に出す）。
  そして **`auth.json` を更新するのは `codex` CLI だけで、デスクトップアプリは触らない**
  （アプリ常時起動のまま 183 時間失効していたのを実測）。Claude と同じ構図だが、
  **寿命が長いぶん「稀にしか起きないが、起きると 1 週間気づかない」**壊れ方をする。
- **keychain を更新するのは Claude Code CLI だけ。**デスクトップアプリも、その
  **スケジュール実行（ルーティン）も更新しない**（アプリは `Claude Safe Storage` を使う。
  失効中に 6 回以上ルーティンが走っても `token_exp` が動かないことを実測で確認）。
  アクセストークンは約 8 時間で切れるので、アプリだけ使っていると失効し続ける
  （実測: 27 時間・53 回連続の `login_required`）。
- **`claude --version` では更新されない。`claude -p` のように認証を通る経路が要る**
  （両方とも実測）。401 のときだけ 1 ターン回して再試行する。成功すれば約 8 時間もつので
  試行は 1 時間に 1 回まで（`~/.ai-usage/cli_refresh.stamp`）。無駄打ちは 429 を招く。
  リフレッシュトークンは自前で使わない（ローテートするため CLI を壊す）。
- Codex の `resets_at` / `reset_at` は **unix 秒**（Claude 側は ISO 文字列）。
  枠の長さは API が `limit_window_seconds`、JSONL が `window_minutes` で**単位が違う**。
  **2026-08 に ChatGPT へ 5 時間制限が追加され、週次と合わせて 2 枠返る**
  （2026-08-26 に実レスポンス採取済み。2026-07 の primary = 週次・secondary = `null`
  から、primary = 5 時間・secondary = 週次へ**スロットの中身が入れ替わっていた**）。
  だからどのスロットにどの枠が入るかは**決め打ちせず、枠の長さで判定する**。
  出力の `windows` は長さ順（5 時間 → 週次）。small も 4 バー全部出す
  （作者の端末で収まることを実機確認。溢れる端末は AIUsage.js の `SIZE.small` を削る）。
  同日、Codex の `credits.has_credits: true` を初観測（中身は全部 null。internals.md 参照）。
  **JSONL 側でも 2026-08-27 に 5 時間 + 週次の 2 枠入り実イベントを採取済み**
  （CLI v0.147.0。値は HTTP と一致。API・JSONL 両経路の実データ検証が完了）。

キー名の詳細と出力フォーマットは `docs/internals.md` に写してある。

### 壊れたときにやること

```bash
python3 ai_usage_fetch.py --raw      # 生レスポンスと生イベントを見る
python3 ai_usage_fetch.py --stdout   # 書き出さずに結果 JSON を見る
tail -n 20 ~/.ai-usage/fetch.err.log # launchd 実行時のエラー
```

Claude が `login_required` なら keychain を確認する。
Codex が `login_required` なら `~/.codex/auth.json` を確認する。

API も JSONL も駄目なときは、API 側の失敗理由がそのまま `status` に出る。
**「codex を起動して `/status`」では直らない**（JSONL は実際にターンを
回さないと増えないため）。API 側の復旧を優先すること。

`empty` は通信できているのに枠が読めない状態＝キー名の変更。`--raw` で実物を見る。

## 決まっていること（再検討しない）

- **ウィジェットの本命は Dropbox 共有リンク（HTTPS）。**ウィジェット拡張は iCloud の
  ダウンロードを起こせないがネットワークは使える。`public/ai-usage.json` を Dropbox に
  書き、共有リンクから取る。リンクは **Keychain（`ai-usage-url`）** に置き、スクリプトに
  直書きしない（`AIUsage.js` は配布物に入るため）。順序は リンク → iCloud → 控え。
- **ウィジェット拡張からは iCloud のダウンロードを起こせない。**ショートカットの拡張からは
  読めるので、iOS のオートメーションで `AIUsage` を定期実行して端末内の控えを更新する。
  アクションは `Run Script` だけにする（`Refresh All Widgets` を足すとアプリが前面に出る。
  `Run In App` も OFF）。手順は README にある。
- **iCloud には中身が変わったときだけ書く。**30 分ごとに無条件で書き換えると、
  端末へ配り終える前に次の版が来て、いつまでも追いつかない（実測: iPhone に 2 時間前の
  版が渡った）。無変化でも 2 時間ごとに 1 回は書き、Mac の死活が分かるようにする。
  ローカルの `last.json` は毎回 atomic に更新する（そちらが正本）。
- **iCloud に書くファイルは `os.replace()` で置き換えない。**inode が変わると iCloud に
  「削除 + 新規作成」と見え、端末側のコピーが毎回無効化されてウィジェットが
  ダウンロード待ちになる（実際に同期が止まった）。`write_in_place()` を使う。
- **VPS を立てない。** Mac が常時起動なので中継サーバーは不要。
- **claude.ai を Playwright でスクレイピングしない。** 壊れやすく、規約上もグレー。
  データはローカルにあるので必要がない。
- **認証情報を Mac の外に出さない。** 転送するのは使用率・リセット時刻・状態だけ。
- **まず Scriptable、次に Swift。** Swift 化は Phase 3 で、判断基準は README に書いた 5 項目。
- **取得失敗時は前回の `windows` を残す。** `status` を差し替え、`stale` と
  `last_attempt_at` を足す（`fetched_at` は前回成功時のまま）。
  200 が返っても枠が 1 件も読めなければ `empty` 扱い。
  Codex の優先順位は **API → JSONL → 前回値**で、JSONL が読めるならそれを使う
  （前回値より、古くとも実データを優先する）。ウィジェットに最終取得時刻を必ず出す。
- **JSONL に落ちた回も `stale` を立てる。**実データではあるが現在値ではない。
  ターンを回さないと増えないので、API が落ちたまま何日も同じ値を配りうる
  （実際に 183 時間前の値を配っていた）。`status` は `ok` のままにし、理由は
  `api_status` に持たせる。**表示側の「いつの数値か」は `observed_at` を優先する**
  ―― JSONL 経路の `fetched_at` は読んだ時刻なので古さを表さない。
- **ログ行には `codex.status` だけでなく `api_status` も出す。**JSONL 経由でも
  `status` は `ok` なので、これが無いと API の失効を事後に追えない
  （実際、183 時間分のログが全行 `codex=ok` だった）。

## 前提としている環境

- **常時起動・スリープしない Mac**（Apple Silicon / macOS 26 系で確認）。
  30 分ごとの収集をこの Mac が担うので、中継サーバーを持たない設計にできる
- **Claude Code はデスクトップアプリ主体で使う**。これが statusline 経路を採らず
  OAuth ポーリングを本命にした理由（アプリでは statusline が発火しない）
- iPhone に Scriptable を入れる
- 動作確認したプランは Claude Max / Codex team。**他プランは未検証**で、
  `limits[]` の構成や Codex の `secondary_window` が異なる可能性がある

## 作業中の方針

- 非公式エンドポイントと JSONL 構造は予告なく変わる。**壊れないコードより、
  `--raw` で実物を見て 5 分で直せるコード**を維持する。防御的パースを薄くしない。
- Phase を飛ばさない。数値が取れる確証を得る前にウィジェットの見た目を触らない。
- 秒単位のリアルタイム性は要件外。30〜60 分間隔で十分。

## 未決事項

- ~~launchd の参照先~~ → 決定。`install.sh` がリポジトリ内の `ai_usage_fetch.py` を
  直接指す plist（`local.ai-usage`）を生成する。`~/.ai-usage/` はキャッシュとログ専用。
- ~~`install.sh` は未作成~~ → 作成済み。`./install.sh` / `./install.sh uninstall`。
- ~~Codex の内部エンドポイントを使うか~~ → 採用。`chatgpt.com/backend-api/codex/usage`。
  「ネットワーク不要という利点を失う」という当初の懸念は成立しなかった
  （Claude 側が既にネットワーク必須なので、スクリプト全体としては何も失わない）。
  JSONL はフォールバックとして残してあるので、壊れても止まらない。
- ~~launchd から `security` で keychain を読めるか~~ → 2026-07-26 に確認。
  launchd 実行（`local.ai-usage`）で `claude=ok`、終了コード 0。**読める。**
  長期運用で再ロックされた場合の挙動は引き続き様子見。
- ~~Codex のトークン失効時の自動復旧~~ → 実装済み（`nudge_codex_cli()`）。
  `codex exec` が `claude -p` に相当する非対話実行。`login_required` のときだけ
  1 回叩き、`~/.ai-usage/codex_refresh.stamp` で 1 時間に 1 回までに絞る。
  フラグ名は版で変わりうるので、弾かれたら素の `exec` で再試行する
  （実際に 2026-08-27、`-a never` が現行 CLI で弾かれるのを実測し、第一候補から
  外した。`--sandbox read-only` は現行も有効）。同日、cwd が git リポジトリ外だと
  「Not inside a trusted directory」で拒否されることも実測。`~/.ai-usage` は
  意図的にリポジトリ外なので **`--skip-git-repo-check` が必須**（素の `exec` も
  同じ理由で落ちる＝この 2 段構えは現行 CLI では第一候補が通ることが前提）。
  **ただし本物の失効では未検証。**トークンがまだ有効なうちは CLI を叩いても
  更新されない（＝いま試しても延びないのが正常）ので、**次の失効予定
  2026-08-22 頃が最初の実地テスト**になる。ログの `codex_cli_refresh` と
  `codex_exp` の変化で判定する。
- Phase 3 の転送経路。第一候補は Tailscale + Mac 上の小さな HTTP サーバー。

## 参考

- Claude Code statusline の `rate_limits` 仕様（公式）: https://code.claude.com/docs/en/statusline
