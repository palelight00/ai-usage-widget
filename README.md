# AI Usage Widget

Claude と Codex のサブスク使用枠を Mac で集めて JSON に書き出し、iPhone の
Scriptable ウィジェットで見る。**ウィジェットの表示は端末の言語に追従する**
（日本語以外は英語）。

> **English** — A macOS collector + iOS (Scriptable) widget that shows how much of your
> Claude and Codex subscription limits you have used. The Mac writes a small JSON every
> 30 minutes; the widget fetches it over HTTPS from a share link (Dropbox / Google Drive /
> OneDrive / your own server), falling back to iCloud and an on-device cache.
> The widget follows the device language: Japanese on Japanese devices, English otherwise.
>
> **This uses undocumented endpoints and can break without notice.** It reads OAuth tokens
> from the local keychain and `~/.codex/auth.json` but never sends them anywhere — only
> usage percentages, reset times and status leave the Mac. Read `ai_usage_fetch.py`
> before running it. No warranty. See `READ_FIRST.md` before using or redistributing.

```
Mac（常時起動）
├─ ai_usage_fetch.py … Claude / Codex とも本命は OAuth・内部 API。
│                      Codex は失敗時のみ ~/.codex のログにフォールバック
├─ launchd（local.ai-usage）で 30 分ごとに実行
└─ 出力: iCloud Drive/Scriptable/ai-usage.json
iPhone
└─ AIUsage.js（Scriptable ウィジェット）が JSON を読んで描画
```

## セットアップ

```bash
./install.sh
```

リポジトリ内の `ai_usage_fetch.py` を launchd から**直接**呼ぶ（コピーしない）。
デスクトップアプリのルーティンではなく launchd を使うのは、アプリの起動状態に
左右されないため（ルーティンでは keychain も更新されないので利点がない）。
`~/.ai-usage/` はキャッシュ（`last.json`）とログ専用。外すときは `./install.sh uninstall`。

iPhone 側は `AIUsage.js` を iCloud Drive の `Scriptable/` に置き、ホーム画面に
Scriptable ウィジェットを追加して Script に `AIUsage` を選ぶ。

## 表示言語

ウィジェットは `Device.language()` を見て、日本語なら日本語、それ以外は英語で描く。
文言は `STRINGS`（`ja` / `en`）にまとめてあり、追加したい言語はここに足すだけでよい。

枠のラベル（`5時間` / `週次` / `Weekly (Fable)`）は **Mac 側の JSON に入っている
`label` を使わない**。`key` / `window_minutes` / `scope_model` から `windowLabel()` が
端末の言語で組み立てる。`label` は古い JSON との互換のための保険として残してある
（新しいフィールドが無い JSON でも壊れず、日本語ラベルのまま表示される）。

Mac 側のログと `--raw` の出力は日本語のまま。運用者しか見ないため。

## ウィジェットのレイアウト

Claude と Codex はサービスごとにグループ化し、見出し・区切り線・サービス色
（Claude=オレンジ / Codex=青）で区別する。バーの色は通常時はサービス色だが、
50% 以上で琥珀、80% 以上で赤に変わる（色分けと警告を両立させるため）。

**サイズごとにレイアウトを変える。** small / medium は縦 158pt しかなく、
4 枠 + 見出しはフォントを縮めても入らない。medium は横 338pt あるので、
縦に詰めるのではなく 2 列にした。

| サイズ | レイアウト | 内容 |
|---|---|---|
| small | 1 列 | Claude 2 枠 + Codex。`weekly_scoped` は週次の内訳なので省く |
| medium | **2 列**（Claude ｜ Codex） | 全枠。リセット時刻は省く |
| large | 1 列 | 全枠 + リセット時刻 + クレジット |

**iCloud には中身が変わったときだけ書く。** 無条件に 30 分ごと書き換えると、端末へ
配り終える前に次の版が来て追いつかない。`content_signature()` で時刻類を除いた
指紋を比べ、変化時のみ書く。無変化でも `ICLOUD_FORCE_WRITE_SECONDS`（2 時間）ごとに
1 回は書く。ログの `icloud=changed/periodic/skipped` で挙動が分かる。
ウィジェットの `STALE_AFTER_MINUTES`（150 分）はこの 2 時間に合わせてある。

**ウィジェット拡張では iCloud のリトライをしない。** ダウンロードを起こせないので
粘っても無駄で、実行時間を食うだけ。ショートカット / アプリ内でだけ待つ。

**候補は `generated_at` が最大のものを採る。** iCloud は古いコピーを返すことがあり、
「最初に読めたものを採用」すると控えを巻き戻してしまう。控えの更新は厳密に
新しいときだけ（同世代で書き直すと `cached_at` だけ新しくなり古さを見誤る）。

**`refreshAfterDate` を 30 分後に設定している。** 強制力はないが、控えが新しいのに
表示が古いままという間を縮められる。

**iCloud のファイルは `os.replace()` で置き換えてはいけない。** inode が変わると
iCloud には「削除 + 新規作成」と映り、端末側のローカルコピーが 30 分ごとに
無効化される。ウィジェットは読むたびにダウンロード待ちになり、間に合わず控えに
落ちる（実際に同期が止まった）。`write_in_place()` で同じ inode に上書きする。

**`JSON.parse(null)` は例外を投げず `null` を返す。** iCloud がファイルを退避していると
`readString()` が `null` を返し、そのまま通すと描画側が `null` を触って落ちる
（実際に発生した）。読み込みは「オブジェクトでなければ null 扱い」で受け、
端末内の控え（`ai-usage-cache.json`、iCloud ではなくローカル）に退避する。
エントリポイントにも `try/catch` を置き、赤いエラー画面ではなく文言を出す。

寸法は `SIZE`（フォント・余白）と `contentWidthFor()`（バー幅）に集約してある。
枠が増えて溢れたらここを削る。バーは幅を明示しないと比率で塗れないので、
画面幅から実幅を見積もり、上下限で挟んでいる。

クレジットは Claude（`extra_usage`）と Codex（`credits`）の両方にありうるため、
**必ずサービス名と色付きの丸を添える**。どちらのものか分からない表示にしない。



## ウィジェットの取得経路（Dropbox 共有リンク）

**ウィジェット拡張は iCloud のオンデマンド・ダウンロードを起こせない**（実測）。
一方でネットワークは使えるので、Dropbox の共有リンクから HTTPS で取る。

```
Mac    ai_usage_fetch.py → public/ai-usage.json（Dropbox 配下・.gitignore 済み）
iPhone ウィジェットが順に試す
       ① Dropbox 共有リンク（HTTPS）… 外出先・セルラーでも可
       ② iCloud ファイル
       ③ 端末内の控え（ai-usage-cache.json）
```

取れた中から `generated_at` が新しいものを採り、控えは厳密に新しいときだけ更新する。


### 対応している共有サービス

ウィジェットがやるのは **HTTPS で JSON を 1 つ取る**ことだけなので、サービスは何でもよい。
ただし共有リンクは既定で HTML のプレビューを返すため、直リンクに直す必要がある。
その規則がサービスごとに違うので `directUrl()` で吸収している。

| サービス | 貼るリンク | 変換後 |
|---|---|---|
| Dropbox | `.../ai-usage.json?rlkey=…&dl=0` | `dl=1` に書き換え |
| Google ドライブ | `.../file/d/<ID>/view?usp=sharing` | `drive.usercontent.google.com/download?id=<ID>&export=download` |
| OneDrive / SharePoint | `https://1drv.ms/...` | `download=1` を付加 |
| 自前の HTTP サーバー | そのまま | 変換なし |
| GitHub raw / Gist raw | そのまま | 変換なし |

いずれも「**リンクを知っている全員**」で共有すること。認証が要るリンクでは取得できない。
表に無いサービスでも、JSON の実体が返る URL ならそのまま使える。
JSON 以外が返ったときは iCloud → 控え に落ちるだけなので、試して壊れることはない。

リンクを登録すると**その場で 1 回取得して成否を知らせる**ので、うまくいかない
サービスかどうかはすぐ分かる。

### 出力先の変更

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

### セットアップ

1. Mac の Finder で `AI-Usage-Widget/public/ai-usage.json` を右クリック →
   「Dropbox」→「コピーを共有」→ **「リンクを知っているメンバー全員」** でリンクを作る
2. iPhone の Scriptable で `AIUsage` を 1 回実行すると入力を求められるので、リンクを貼る
3. リンクは **Keychain（`ai-usage-url`）に保存**され、スクリプトには書き込まれない

リンクを変えたくなったら、**Scriptable アプリ内で `AIUsage` を実行するだけ**でよい。
現在のリンクが入った入力欄が出るので、書き換えて「保存」を押す。
空にして保存すると登録が消え、iCloud 経由に戻る。
（ウィジェットとショートカットからは画面を出さないので、自動実行の邪魔にはならない）

**リンクをスクリプトに直書きしないこと。** `AIUsage.js` は iCloud 同期され配布物にも入るため、
直書きすると配布先にリンクが漏れる。変更したいときは Scriptable で
`Keychain.remove("ai-usage-url")` を実行してから、アプリ内で 1 回動かすと再入力できる。

**共有リンクは URL を知っていれば誰でも読める。** 中身は使用率・リセット時刻・状態のみで
認証情報は含まないが、公開範囲としてはそういう性質だと理解して使う。

`dl=0` は `dl=1` に書き換え、毎回異なるクエリを足して CDN の古い版を掴まないようにしている。
タイムアウトは 3 秒・リトライなし（ウィジェットの実行時間が短いため）。

## iPhone 側の定期更新（任意）

> Dropbox 共有リンクを登録した後は**不要**。iCloud 経由でしか動かせない場合の保険。
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

ショートカットアプリ →オートメーション →時刻 →「すぐに実行」「実行時に通知」オフ →
アクションは **`Run Script` の 1 つだけ**。

- スクリプト: `AIUsage`
- パラメータ: **空でよい**（スクリプトは引数を読まない）
- **Run In App: OFF**（ON にするとアプリが前面に出る）
- 実行時に表示: OFF

**`Refresh All Widgets` を足してはいけない。** Scriptable が起動してアプリが前面に出る。
足さなくても、iOS が自前のタイミングでウィジェットを再描画したときに最新の控えを読む。

更新頻度を上げたいときは、同じ内容のオートメーションを複数の時刻に作る。

控えが効いているかはウィジェット下部の赤字（`控え N分前`）で分かる。

## 動作確認

```bash
python3 ai_usage_fetch.py --raw
```

生レスポンスと生イベントを表示する。構造が変わったらまずこれを見て、
`ai_usage_fetch.py` 冒頭の定数か、`parse_claude` / `parse_codex_api`（API 用）/
`parse_codex`（JSONL 用）を直す。

```bash
python3 ai_usage_fetch.py --stdout
```

書き出さずに結果 JSON だけ見る。

## データ源（2026-07-26 に実物で確認）

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

### Codex（本命：内部エンドポイント）

`~/.codex/auth.json` の `tokens.access_token` と `tokens.account_id` を使う。

```
GET https://chatgpt.com/backend-api/codex/usage
    Authorization: Bearer <access_token>
    chatgpt-account-id: <account_id>
```

```json
{"plan_type":"team",
 "rate_limit":{"limit_reached":false,
   "primary_window":{"used_percent":15,"limit_window_seconds":604800,"reset_at":1785618903},
   "secondary_window":null},
 "credits":{"has_credits":false,"unlimited":false,"balance":null}}
```

- `limit_window_seconds` は**秒**（JSONL 側の `window_minutes` とは単位が違う）。
- `reset_at` は unix 秒。
- `/backend-api/wham/usage` も同一のレスポンスを返す（別名。片方が消えたら乗り換え先）。
- 401/403 は `login_required`。**失敗の種類によらず、下の JSONL にフォールバックする**
  （トークンが切れていても JSONL には最後の値が残っているため）。
  そのとき出力の `api_status` に API 側の失敗理由が入る。
- 優先順位は **API → JSONL → 前回値**。JSONL が読めるならそちらを使い、
  `status` は `ok` のままにする（前回値より、古くとも実データを優先する）。
  前回値の引き継ぎに落ちるのは、API も JSONL も駄目なときだけ。

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
- `window_minutes` で枠の種類を判定する（`10080` = 週次）。現行の team プランは
  `secondary` が `null` で週次のみ。`primary` = 5 時間枠と決め打ちしないこと。
- 巨大なファイル（数十 MB）があるので末尾 3 MB だけ読む。新しい順に 12 ファイル走査。

**JSONL の値は Codex を実際に使ったときにしか更新されない。** `rate_limits` は API
レスポンスに同梱されて記録されるので、アプリを起動しているだけでは 1 件も増えない
（実測: あるセッションの 6 件はすべてターン実行中の約 100 秒間に集中）。
`.codex-global-state.json` も使用枠の数値は持っていない。

そのため出力の `observed_at` / `observed_age_seconds` に記録時刻を持たせ、
ウィジェットは medium / large で、かつ `status` が全て `ok` のときに限り、
1 時間以上古ければその旨を出す（`status` 異常はそちらの表示を優先する）。エンドポイント経由なら
`source: "api"` / `observed_age_seconds: 0` になる。フォールバックしたときは
`api_status` に失敗理由が入る。

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
    "windows": [{"key":"primary","label":"週次","percent":15.0,"resets_at":"...","window_minutes":10080}]
  }
}
```

`status` は `ok` / `empty` / `login_required` / `http_<code>` /
`error:<型名>` / `parse_error:<型名>`。`empty` は**通信は成功したのに枠が 1 件も
読めなかった**場合＝キー名が変わったサイン。

**失敗した側は前回の `windows` を残し、`stale: true` と `last_attempt_at` を足して
status を差し替える（`fetched_at` は据え置き）。** 片方が落ちてももう片方は更新される。
終了コードは、**書き出しを伴う通常実行のときだけ**「両方 `ok` なら 0、それ以外は 1」。
`--stdout` と `--raw` は状態によらず 0 を返す（確認用途なので）。

## Phase

- **Phase 0 — データが取れることの確認。完了（2026-07-26）。** Claude / Codex とも実物で確認済み。
- **Phase 1 — 収集と出力。完了（2026-07-26）。** `ai_usage_fetch.py` + `install.sh`。
  launchd（`local.ai-usage`、30 分間隔）で稼働確認済み。
- **Phase 2 — ウィジェット。完了（2026-07-31）。** `AIUsage.js`。実機で表示・同期とも確認済み。
  取得経路は Dropbox 共有リンク（iCloud 経由は伝播が追いつかず断念）。
- **Phase 3 — Swift 化。** 下の 5 項目のうち 3 つ以上に当てはまったら検討する。

### Swift 化の判断基準

1. Scriptable の更新間隔が iOS に絞られて、表示が実用にならないほど古くなる。
2. iCloud Drive の同期遅延が常態化して、`generated_at` が数時間ずれる。
3. ロック画面ウィジェットや Live Activity など Scriptable で届かない表示が必要になる。
4. Scriptable 自体の更新が止まる、または iOS 更新で動かなくなる。
5. JSON の受け渡しを Tailscale + Mac 上の HTTP サーバーに変える必要が出る
   （iCloud を経由しない構成にする）。

## 決まっていること（再検討しない）

- VPS を立てない。Mac が常時起動なので中継サーバーは不要。
- claude.ai を Playwright でスクレイピングしない。
- 認証情報を Mac の外に出さない。転送するのは使用率・リセット時刻・状態だけ。
- まず Scriptable、次に Swift。
- 取得失敗時は前回の `windows` を残し、`status` を差し替えて `stale` /
  `last_attempt_at` を足す。`fetched_at` は前回成功時のまま据え置く。
  ウィジェットに最終取得時刻を必ず出す。

## 未決事項

- Codex のエンドポイントは `chatgpt.com/backend-api/` 配下の内部 API で、予告なく
  変わりうる。壊れたら `--raw` で確認し、駄目なら `/backend-api/wham/usage` に替える。
  それも駄目なら JSONL フォールバックだけで動く（古くなるが止まらない）。
- `~/.codex/auth.json` の `access_token` が失効したときの挙動。Codex 本体が更新するので
  通常は追随するが、自前でリフレッシュはしない（Claude 側と同じ方針）。
- ~~launchd から `security` コマンドで keychain を読めるか~~ → **読める**
  （2026-07-26、launchd 実行で `claude=ok` / 終了コード 0 を確認）。
  ただし失敗しても `security` の stderr は握り潰されるので `fetch.err.log` には
  出ない。`fetch.log` の `claude=login_required` で気づくこと。
- ~~Claude のアクセストークンが失効したときの挙動~~ → **当初の想定は誤りだった**
  （2026-07-28 に判明）。keychain の `Claude Code-credentials` を書くのは
  **CLI であって、デスクトップアプリではない**（アプリは `Claude Safe Storage` という
  別の暗号化ストレージを使う）。アクセストークンの寿命は約 8 時間なので、
  デスクトップアプリだけを使っていると失効したまま放置される。
  実際に 27 時間・53 回連続で `login_required` になった。
  デスクトップアプリの**スケジュール実行（ルーティン）でも更新されない**
  （失効中に 6 回以上走っても `token_exp` が動かなかった）。
  また **`claude --version` では更新されない**——認証を通る経路が必要で、
  `claude -p` なら更新される（いずれも実測）。
  対策として、401 のときだけ `claude -p ok` を 1 回実行して再試行する
  （`nudge_claude_cli()`）。成功すれば約 8 時間もつので、試行は 1 時間に 1 回まで
  （`~/.ai-usage/cli_refresh.stamp`）。無駄打ちは `http_429` を招く。
  **自前でリフレッシュトークンは使わない**——ローテートするので書き戻しを誤ると
  CLI 側のログインを壊すため。
  ログには `cli_refresh` と `token_exp=` が出るので、失効の周期を追える。

## 参考

- Claude Code statusline の `rate_limits` 仕様（公式）: https://code.claude.com/docs/en/statusline
- 元の構想メモ: `docs/2026-07-26_claude-codex-usage-widget-draft.md`（未作成）
