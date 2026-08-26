[English](internals.en.md) | **日本語**

# 内部仕様と実装メモ

**壊れたときに直すための記録。**使い方とセットアップは [README.md](../README.md)、
設計上の決定と再検討しないと決めた項目は [CLAUDE.md](../CLAUDE.md) にある。

非公開エンドポイントと JSONL の構造は予告なく変わる。ここに書いてあるのは
2026-07-26 に実物で確認した内容で、合わなくなったら `--raw` で現物を見ること。
直す場所は `ai_usage_fetch.py` 冒頭の定数か、`parse_claude` /
`parse_codex_api`（API 用）/ `parse_codex`（JSONL 用）。

## データ源

### Claude

OAuth トークンは **keychain の `Claude Code-credentials`** にある。
`~/.claude/.credentials.json` はこの環境には存在しない（コードは両方見る）。

```
security find-generic-password -s "Claude Code-credentials" -w
→ {"claudeAiOauth": {"accessToken": "...", "subscriptionType": "max", ...}, ...}
```

`GET https://api.anthropic.com/api/oauth/usage`（`Authorization: Bearer`,
`anthropic-beta: oauth-2025-04-20`）が 200 で返す:

| 使うキー | 中身 |
|---|---|
| `limits[]` | `kind`（`session` / `weekly_all` / `weekly_scoped`）, `percent`, `resets_at`, `severity`, `is_active`, `scope.model.display_name` |
| `five_hour` / `seven_day` | `utilization`（％）, `resets_at`。`limits[]` が空のときのフォールバック |
| `extra_usage` | `is_enabled`, `utilization`, `used_credits`, `monthly_limit`, `currency`, `decimal_places` |

`percent` も `utilization` も 0–100 のパーセント（0–1 の割合ではない）。
401/403 は `login_required` として扱う。

2026-08-26 の再採取では、`limits[]` に `group`（`session` / `weekly`）が増え、
トップレベルにも `spend` ブロックや多数の実験的キー（ほぼ null）が追加されていた。
使うキーは変わっておらず、パースへの影響はない。

**`extra_usage.utilization` は未使用のとき null で返る**（月初に実測）。
0% も表示すべき情報なので、`used_credits` と `monthly_limit` から自分で算出する。

### Codex（本命：内部エンドポイント）

`~/.codex/auth.json` の `tokens.access_token` と `tokens.account_id` を使う。

```
GET https://chatgpt.com/backend-api/codex/usage
    Authorization: Bearer <access_token>
    chatgpt-account-id: <account_id>
```

```json
{"plan_type":"team",
 "rate_limit":{"allowed":true,"limit_reached":false,
   "primary_window":{"used_percent":0,"limit_window_seconds":18000,
                     "reset_after_seconds":18000,"reset_at":1787774812},
   "secondary_window":{"used_percent":27,"limit_window_seconds":604800,
                       "reset_after_seconds":520069,"reset_at":1788276880}},
 "credits":{"has_credits":true,"unlimited":false,"overage_limit_reached":false,
            "balance":null,"approx_local_messages":null,"approx_cloud_messages":null},
 "rate_limit_reset_credits":{"available_count":1,"applicable_available_count":0}}
```

（2026-08-26 採取。`user_id` / `account_id` / `email` も返るが個人情報なのでここには
載せない。ほかに `code_review_rate_limit` / `additional_rate_limits` /
`spend_control` / `promo` など null 中心のキーがある。いずれも未使用。）

- `limit_window_seconds` は**秒**（JSONL 側の `window_minutes` とは単位が違う）。
- `reset_at` は unix 秒。
- **2026-08 に ChatGPT へ 5 時間制限が追加された。**2026-07-26 採取時は
  `primary_window` = 週次・`secondary_window` = `null` だったが、2026-08-26 の
  再採取で `primary_window` = 5 時間（18000 秒）・`secondary_window` = 週次に
  変わっていた（上の実例）。**スロットの中身が入れ替わった実績がある**ので、
  どのスロットに何が入るかは決め打ちせず `limit_window_seconds` で判定し、
  出力の `windows` は枠の長さ順（5 時間 → 週次）に並べる（`sort_codex_windows()`）。
- `/backend-api/wham/usage` も同一のレスポンスを返す（別名。片方が消えたら乗り換え先）。
- 401/403 は `login_required`。**失敗の種類によらず、下の JSONL にフォールバックする**
  （トークンが切れていても JSONL には最後の値が残っているため）。
  そのとき出力の `api_status` に API 側の失敗理由が入る。
- 優先順位は **API → JSONL → 前回値**。JSONL が読めるならそちらを使い、
  `status` は `ok` のままにする（前回値より、古くとも実データを優先する）。
  前回値の引き継ぎに落ちるのは、API も JSONL も駄目なときだけ。

`credits` は長らく `has_credits` が false だったが、**2026-08-26 に
`has_credits: true` を初観測した**（5 時間制限の導入と同時期）。ただし `balance` /
`approx_local_messages` / `approx_cloud_messages` はすべて null、`unlimited` /
`overage_limit_reached` は false で、**中身のある値はまだ見ていない**。この形だと
ウィジェットは保険の「クレジットあり」を表示する。単位が不明なので、判断材料に
なりそうな項目は引き続き出力に残してある。同時に現れた `rate_limit_reset_credits`
（`available_count` など）は枠リセット用のクレジットらしいが、意味が分かるまで使わない。

### Codex（フォールバック：rollout JSONL）

`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` の各行が 1 イベント。
`payload.type == "token_count"` の行に `rate_limits` が同梱されている:

```json
{"timestamp":"...","type":"event_msg","payload":{"type":"token_count","info":{...},
 "rate_limits":{"limit_id":"codex","primary":{"used_percent":15.0,
 "window_minutes":10080,"resets_at":1785618902},"secondary":null,
 "credits":{"has_credits":false,...},"plan_type":"team"}}}
```

- `resets_at` は **unix 秒**（Claude 側は ISO 文字列）。
- `window_minutes` で枠の種類を判定する（`300` = 5 時間、`10080` = 週次）。
  2026-08 の 5 時間制限追加までは、team プランは `secondary` が `null` で週次のみ
  だった。**`primary` = 5 時間枠と決め打ちしないこと**（API 側と同じく、出力は
  枠の長さ順に並べ直す）。
- 巨大なファイル（数十 MB）があるので末尾 3 MB だけ読む。新しい順に 12 ファイル走査。
- **現行の codex は 7 日より古い rollout を `.zst` に圧縮する**（mtime 基準・起動時の
  バックグラウンドジョブ。2026-08-26 に openai/codex のソースで確認）。このスクリプトは
  素の `.jsonl` しか読まないため、**フォールバックが拾えるのは直近 1 週間ぶんだけ**。
  `--raw` で「イベントなし」になる主因はこれか、そもそもターンを回していないこと。
  1 週間より古い値はどのみち表示価値が薄いので、.zst の展開には対応しない。
- 行フォーマット・保存先・`rate_limits` の同梱は現行ソースでも上記のまま
  （`sessions/YYYY/MM/DD/rollout-*.jsonl`、`token_count` イベント、`used_percent` /
  `window_minutes` / unix 秒の `resets_at`。同日に openai/codex のソースで確認）。
  なお JSONL 側の `credits.balance` は**文字列型**（`Option<String>`）。数値を前提に
  している金額表示は効かず、保険の「クレジットあり」になる（実物は未観測）。

**JSONL の値は Codex を実際に使ったときにしか更新されない。** `rate_limits` は API
レスポンスに同梱されて記録されるので、アプリを起動しているだけでは 1 件も増えない
（実測: あるセッションの 6 件はすべてターン実行中の約 100 秒間に集中）。
`.codex-global-state.json` も使用枠の数値は持っていない。
**だから「codex を起動して `/status`」では直らない。** API 側の復旧を優先すること。

そのため出力の `observed_at` / `observed_age_seconds` に記録時刻を持たせ、
ウィジェットは medium / large で、かつ `status` が全て `ok` のときに限り、
1 時間以上古ければその旨を出す（`status` 異常はそちらの表示を優先する）。
エンドポイント経由なら `source: "api"` / `observed_age_seconds: 0` になる。

**JSONL に落ちた回は `stale: true` も立てる。**実データではあるが現在値ではない。
`status` は `ok` のままにし、理由は `api_status` に持たせる。
**表示側で「いつの数値か」を出すときは `observed_at` を優先すること。**
この経路の `fetched_at` は JSONL を読んだ時刻なので、値の古さを表さない。

### トークンの寿命

`auth.json` の `access_token` は JWT で、`exp` に失効時刻が入っている。これを
`token_expires_at` として出力する（時刻だけ。トークン本体は外に出さない）。

**Claude が約 8 時間なのに対し、Codex は約 10 日**（実測: 2026-08-12 時点で
9 日先）。しかも **`auth.json` を更新するのは `codex` CLI だけで、デスクトップ
アプリは触らない。**この 2 つが重なるため、切れると誰にも気づかれないまま
1 週間走りうる（実際に 183 時間踏んだ）。

そのため `login_required` のときだけ `codex exec` を 1 回叩いて、公式ツールに
`auth.json` を書き直させる（`claude -p` と同じ考え方。`~/.ai-usage/codex_refresh.stamp`
で 1 時間に 1 回まで）。成功すると出力に `cli_refresh: true`、ログに
`codex_cli_refresh` が出る。リフレッシュトークンは自前で使わない。

## 出力フォーマット

```json
{
  "schema": 1,
  "generated_at": "2026-07-26T21:47:39+09:00",
  "claude": {
    "status": "ok",
    "fetched_at": "...",
    "plan": "max",
    "windows": [
      {"key":"session","label":"5時間","percent":1.0,"resets_at":"...","severity":"normal","is_active":false}
    ],
    "extra_usage": {"percent":6.19,"used":619.0,"limit":10000,"currency":"USD","decimal_places":2}
  },
  "codex": {
    "status": "ok",
    "fetched_at": "...",
    "observed_at": "...",
    "observed_age_seconds": 0,
    "source": "api",
    "plan": "team",
    "token_expires_at": "...",
    "windows": [
      {"key":"primary","label":"5時間","percent":8.0,"resets_at":"...","window_minutes":300},
      {"key":"secondary","label":"週次","percent":15.0,"resets_at":"...","window_minutes":10080}
    ]
  }
}
```

Codex の `windows` は枠の長さ順（短い → 長い）。`key` はレスポンスのスロット名を
そのまま持たせているだけで、**どの `key` がどの枠かは保証しない**（長さで見ること）。

`status` は `ok` / `empty` / `login_required` / `http_<code>` /
`error:<型名>` / `parse_error:<型名>`。`empty` は**通信は成功したのに枠が 1 件も
読めなかった**場合＝キー名が変わったサイン。

**失敗した側は前回の `windows` を残し、`stale: true` と `last_attempt_at` を足して
status を差し替える（`fetched_at` は据え置き）。** 片方が落ちてももう片方は更新される。
終了コードは、**書き出しを伴う通常実行のときだけ**「両方 `ok` なら 0、それ以外は 1」。
`--stdout` と `--raw` は状態によらず 0 を返す（確認用途なので）。

## 出力先の変更

出力先は次の順で決まる。

1. `--public <path>` 引数
2. 環境変数 `AI_USAGE_PUBLIC_PATH`
3. `~/.ai-usage/public_path`（`install.sh` が控える）
4. 既定 = リポジトリ内の `public/ai-usage.json`（`.gitignore` 済み）

install 時に渡しておけば 3 に控えられるので、**手で動かしても同じ場所に書く**。

```bash
AI_USAGE_PUBLIC_PATH="$HOME/Dropbox/ai-usage/ai-usage.json" ./install.sh
```

これをやらないと、launchd は指定先に、手動実行はリポジトリ内 `public/` に書く、
という**二重出力**になる。古いほうの共有リンクを掴んだまま気づけないので注意。

## 表示言語の仕組み

ウィジェットは `Device.language()` を見て、日本語なら日本語、それ以外は英語で描く。
文言は `STRINGS`（`ja` / `en`）にまとめてあり、追加したい言語はここに足すだけでよい。

枠のラベル（`5時間` / `週次` / `Weekly (Fable)`）は **Mac 側の JSON に入っている
`label` を使わない**。`key` / `window_minutes` / `scope_model` から `windowLabel()` が
端末の言語で組み立てる。`label` は古い JSON との互換のための保険として残してある
（新しいフィールドが無い JSON でも壊れず、日本語ラベルのまま表示される）。

Mac 側のログと `--raw` の出力は日本語のまま。運用者しか見ないため。

## ウィジェットの実装判断

### レイアウト

Claude と Codex はサービスごとにグループ化し、見出し・区切り線・サービス色
（Claude=オレンジ / Codex=青）で区別する。バーの色は通常時はサービス色だが、
50% 以上で琥珀、80% 以上で赤に変わる（色分けと警告を両立させるため）。

**サイズごとにレイアウトを変える。** small / medium は縦 158pt しかない。
medium は全枠 + リセット日時が縦に入らないため、横 338pt を使って 2 列にした。
small はリセット日時を省いたバーだけの表示にし、`weekly_scoped` を除く 4 枠
（Claude 2 + Codex 2）を 1 列に収める。

**small の 4 バーは作者の端末（大画面の iPhone）で収まることを実機確認済み。**
2026-08 の 5 時間制限追加で Codex が 2 枠になった際、一度は Codex を最長の 1 枠に
絞った（0.13.0）が、small で 5 時間枠の逼迫に気づけなくなるため 0.14.0 で戻した。
画面の小さい端末で溢れる場合は `SIZE.small` の余白・フォントを削ること。

寸法は `SIZE`（フォント・余白）と `contentWidthFor()`（バー幅）に集約してある。
枠が増えて溢れたらここを削る。バーは幅を明示しないと比率で塗れないので、
画面幅から実幅を見積もり、上下限で挟んでいる。

クレジットは Claude（`extra_usage`）と Codex（`credits`）の両方にありうるため、
**必ずサービス名と色付きの丸を添える**。どちらのものか分からない表示にしない。
Codex 側は実物を見ていないので、取れた材料から
無制限 → 残りメッセージ数 → 残高 → クレジットあり の順に選ぶ。

### iCloud まわりのハマりどころ

**iCloud には中身が変わったときだけ書く。** 無条件に 30 分ごと書き換えると、端末へ
配り終える前に次の版が来て追いつかない（実測: iPhone に 2 時間前の版が渡った）。
`content_signature()` で時刻類を除いた指紋を比べ、変化時のみ書く。無変化でも
`ICLOUD_FORCE_WRITE_SECONDS`（2 時間）ごとに 1 回は書き、Mac の死活が分かるようにする。
ログの `icloud=changed/periodic/skipped` で挙動が分かる。
ウィジェットの `STALE_AFTER_MINUTES`（150 分）はこの 2 時間に合わせてある。

**iCloud のファイルは `os.replace()` で置き換えてはいけない。** inode が変わると
iCloud には「削除 + 新規作成」と映り、端末側のローカルコピーが 30 分ごとに
無効化される。ウィジェットは読むたびにダウンロード待ちになり、間に合わず控えに
落ちる（実際に同期が止まった）。`write_in_place()` で同じ inode に上書きする。
ローカルの `last.json` は毎回 atomic に更新する（そちらが正本）。

**ウィジェット拡張では iCloud のリトライをしない。** ダウンロードを起こせないので
粘っても無駄で、実行時間を食うだけ。ショートカット / アプリ内でだけ待つ。

**候補は `generated_at` が最大のものを採る。** iCloud は古いコピーを返すことがあり、
「最初に読めたものを採用」すると控えを巻き戻してしまう。控えの更新は厳密に
新しいときだけ（同世代で書き直すと `cached_at` だけ新しくなり古さを見誤る）。

**`JSON.parse(null)` は例外を投げず `null` を返す。** iCloud がファイルを退避していると
`readString()` が `null` を返し、そのまま通すと描画側が `null` を触って落ちる
（実際に発生した）。読み込みは「オブジェクトでなければ null 扱い」で受け、
端末内の控え（`ai-usage-cache.json`、iCloud ではなくローカル）に退避する。
エントリポイントにも `try/catch` を置き、赤いエラー画面ではなく文言を出す。

**`refreshAfterDate` を 30 分後に設定している。** 強制力はないが、控えが新しいのに
表示が古いままという間を縮められる。

共有リンクは `dl=0` を `dl=1` に書き換え、毎回異なるクエリを足して CDN の古い版を
掴まないようにしている。タイムアウトは 3 秒・リトライなし（実行時間が短いため）。

## iPhone 側の定期更新（iCloud 経由の保険）

> 共有リンクを登録した後は**不要**。iCloud 経由でしか動かせない場合の保険。
> 設定済みなら残しておいても害はない（控えが更新されるだけ）。

**ウィジェット拡張からは iCloud のオンデマンド・ダウンロードを起こせない。**
端末にファイルが降りていないと読めず、控えの表示になる（実測: 4 時間読めないまま）。
一方で**ショートカットの拡張からは読める**ので、そちらで控えを更新させる。

`AIUsage.js` は呼ばれ方で動作を変える。

| 呼ばれ方 | 動作 |
|---|---|
| ショートカット / Siri | 画面を出さず、iCloud を読んで端末内の控えだけ更新 |
| ウィジェット | 控え（または iCloud）を読んで描画 |
| Scriptable アプリ内 | プレビューを表示（`PREVIEW_IN_APP` で無効化できる） |

ショートカットアプリ → オートメーション → 時刻 → 「すぐに実行」「実行時に通知」オフ →
アクションは **`Run Script` の 1 つだけ**。

- スクリプト: `AIUsage`
- パラメータ: **空でよい**（設定を変えたいときだけ `setup`）
- **Run In App: OFF**（ON にするとアプリが前面に出る）
- 実行時に表示: OFF

**`Refresh All Widgets` を足してはいけない。** Scriptable が起動してアプリが前面に出る。
足さなくても、iOS が自前のタイミングでウィジェットを再描画したときに最新の控えを読む。

更新頻度を上げたいときは、同じ内容のオートメーションを複数の時刻に作る。
控えが効いているかはウィジェット下部の赤字（`控え N分前`）で分かる。

## 参考

- Claude Code statusline の `rate_limits` 仕様（公式）: https://code.claude.com/docs/en/statusline
