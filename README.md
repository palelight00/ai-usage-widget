[English](README.en.md) | **日本語**

# AI Usage Widget

Claude と Codex のサブスク使用枠が、iPhone のホーム画面で分かる。
Mac 側のスクリプトが 30 分ごとに数値を集めて小さな JSON を書き、
iOS の [Scriptable](https://scriptable.app/) ウィジェットがそれを取って描く。

表示は端末の言語に追従する（日本語端末なら日本語、それ以外は英語）。

> ### ⚠️ 使う前に必ずお読みください
>
> **このツールは非公開エンドポイントを 2 つ使っています。**
>
> | | エンドポイント |
> |---|---|
> | Claude | `api.anthropic.com/api/oauth/usage` |
> | Codex | `chatgpt.com/backend-api/codex/usage` |
>
> いずれも公式に文書化されたものではなく、**予告なく変わって動かなくなります。**
> 各サービスの利用規約はご自身で確認してください。
>
> **ローカルの認証情報を読みます**（macOS keychain の `Claude Code-credentials` と
> `~/.codex/auth.json`）。**読み取るだけで Mac の外には出しません。**書き出す JSON に
> 含まれるのは使用率・リセット時刻・状態だけです。とはいえ認証情報に触れるので、
> **実行前に `ai_usage_fetch.py` をご自身の目で読んでください。**800 行ほどで、
> わざと平易に書いてあります。
>
> 個人が自分用に作ったものです。**無保証**です。詳しくは [READ_FIRST.md](READ_FIRST.md)。

## 動作環境

**収集側は macOS 専用、表示側は iOS。**Windows / Linux では動きません（[後述](#windows--linux-について)）。

| | 必要なもの |
|---|---|
| 収集 | **macOS**（常時起動・スリープしない設定を推奨）、Python 3 |
| | Claude Code CLI（任意・推奨。トークン失効時の自動復旧に使う） |
| 表示 | **iPhone / iPad** + [Scriptable](https://scriptable.app/) |
| 受け渡し | 共有リンクを作れる場所（Dropbox / Google ドライブ / OneDrive / 自前の HTTP サーバー） |

**動作確認したプランは Claude Max / Codex team。**他プランは未検証で、`limits[]` の構成や
Codex の `secondary_window` が異なる可能性があります。

## 仕組み

```
Mac（常時起動）
├─ ai_usage_fetch.py … Claude は OAuth エンドポイント、Codex は内部 API
│                      （失敗時のみ ~/.codex のログにフォールバック）
├─ launchd で 30 分ごとに実行
└─ 出力: 共有フォルダ + iCloud Drive/Scriptable/ai-usage.json
iPhone
└─ AIUsage.js（Scriptable ウィジェット）が取得して描画
```

ウィジェットは次の順に試し、`generated_at` がいちばん新しいものを採用します。

1. **共有リンク（HTTPS）** — 外出先・セルラーでも動く
2. **iCloud ファイル**
3. **端末内の控え**

この順番には理由があります。**iOS のウィジェット拡張は iCloud のオンデマンド・
ダウンロードを起こせない**ため、iCloud だけに頼ると表示が古いまま止まります。
だから共有リンクが本命です。

## セットアップ

### 1. Mac

```bash
AI_USAGE_PUBLIC_PATH="$HOME/Dropbox/ai-usage/ai-usage.json" ./install.sh
```

30 分ごとに動く launchd ジョブ（`local.ai-usage`）を登録します。リポジトリ内の
`ai_usage_fetch.py` を**直接**呼ぶので、コピーは作りません。`~/.ai-usage/` は
キャッシュとログ専用です。外すときは `./install.sh uninstall`。

`AI_USAGE_PUBLIC_PATH` には、クラウドに同期されるフォルダを指定してください。
install 時に渡しておくと控えられるので、**手で動かしても同じ場所に書きます**
（渡さないと、launchd と手動実行で出力先が分かれます）。

### 2. 共有リンク

その `ai-usage.json` に、**「リンクを知っている全員」**の共有リンクを作ります。
貼るのは各サービスが出すリンクのままで構いません。直リンクへの変換はスクリプト側でやります。

| サービス | 貼るリンク | 変換後 |
|---|---|---|
| Dropbox | `.../ai-usage.json?rlkey=…&dl=0` | `dl=1` に書き換え |
| Google ドライブ | `.../file/d/<ID>/view?usp=sharing` | `drive.usercontent.google.com/download?id=<ID>` |
| OneDrive / SharePoint | `https://1drv.ms/...` | `download=1` を付加 |
| 自前の HTTP サーバー | そのまま | 変換なし |
| GitHub raw / Gist raw | そのまま | 変換なし |

表に無いサービスでも、JSON の実体が返る URL ならそのまま使えます。認証が要るリンクでは
取得できません。JSON 以外が返ったときは iCloud → 控え に落ちるだけなので、試して壊れることはありません。

> **共有リンクは URL を知っていれば誰でも読めます。**中身は使用率・リセット時刻・状態のみで
> 認証情報は含みませんが、公開範囲としてはそういう性質だと理解して使ってください。

### 3. iPhone

`AIUsage.js` を iCloud Drive の `Scriptable/` に置き、ホーム画面に Scriptable
ウィジェットを追加して、Script に `AIUsage` を選びます。

そのあと **Scriptable アプリの中で** `AIUsage` を 1 回実行してください。共有リンクの
入力を求められ、**その場で 1 回取得して成否を知らせます**。リンクは Scriptable の
Keychain（`ai-usage-url`）に保存され、スクリプトには書き込まれません。

> **リンクを `AIUsage.js` に直書きしないでください。**このファイルは配布物に入るため、
> 直書きすると配布先にリンクが渡ります。

入力を求めるのは**困っているときだけ**です（未登録のとき、登録済みだが取得できないとき）。
正常に動いているときにアプリ内で実行しても、プレビューを出すだけです。

**動いているリンクを変えたいとき**は、ショートカットの `Run Script` でパラメータに
`setup` を渡して実行します。現在の値が入った入力欄が出ます。空にして保存すると
登録が消え、iCloud 経由に戻ります。

## ウィジェットのレイアウト

Claude と Codex はサービスごとにグループ化し、見出し・区切り線・サービス色
（Claude=オレンジ / Codex=青）で区別します。バーの色は通常時はサービス色で、
50% 以上で琥珀、80% 以上で赤に変わります。

サイズごとにレイアウトが変わります。small / medium は縦 158pt しかないためです。

| サイズ | レイアウト | 内容 |
|---|---|---|
| small | 1 列 | Claude 2 枠 + Codex（`weekly_scoped` は週次の内訳なので省略） |
| medium | **2 列**（Claude ｜ Codex） | 全枠。リセット時刻は省略 |
| large | 1 列 | 全枠 + リセット時刻 + クレジット |

## うまくいかないとき

```bash
python3 ai_usage_fetch.py --raw      # 生レスポンスと生イベント
python3 ai_usage_fetch.py --stdout   # 書き出さずに結果 JSON だけ見る
tail -n 20 ~/.ai-usage/fetch.log     # launchd が何をしていたか
```

> **`--raw` の出力には Codex 側の `email` / `user_id` / `account_id` が含まれます。**
> issue や SNS に貼るときは消してください。

ログの 1 行から大体のことが分かります。

```
2026-08-01T21:07:32+09:00 claude=ok codex=ok [token_exp=... icloud=changed dropbox=ok] -> ...
```

- `claude=login_required` — keychain のトークンが失効。**更新するのは Claude Code の
  CLI だけ**で、デスクトップアプリもそのルーティンも更新しません。そのため
  `claude -p` を 1 回（最大 1 時間に 1 回）走らせて、公式の経路で更新させます
- `codex=login_required` — `~/.codex/auth.json` を確認してください
- `claude=empty` / `codex=empty` — 通信は成功したのに枠が 1 件も読めない状態＝
  キー名が変わったサインです。`--raw` で実物を見てください
- `icloud=skipped` — 中身が変わらなかったので iCloud のファイルに触っていない。
  これは意図的です（30 分ごとに書き換えると端末が追いつけなくなるため）

## バージョン

`0.9.0`。変更履歴は [CHANGELOG.md](CHANGELOG.md)。

作者の環境では実運用で安定していますが、**他人の環境での導入実績がまだありません**。
開発中、シェルのロケールが違うだけで `install.sh` が落ちる不具合が見つかりました
（`LANG=C` では通り、`ja_JP.UTF-8` では落ちる）。環境差でしか出ない問題は、まだ
残っている可能性があります。**別の環境で導入が確認できた時点で 1.0.0 にします。**

不具合の報告時は、`python3 ai_usage_fetch.py --version` の出力か、出力 JSON の
`app_version` を添えてください。

## Windows / Linux について

現状は動きません。塞がっているのは次の 3 点で、いずれも小さいものです。

1. **Claude の認証情報** — `security`（macOS keychain）を使っています。
   Windows / Linux の Claude Code は `~/.claude/.credentials.json` に置くはずで、
   **コードは既にそちらも見に行く**ため、そのまま動く可能性はあります（未検証）
2. **定期実行** — launchd。Windows ならタスク スケジューラ、Linux なら systemd/cron
3. **iCloud への出力** — 該当パスが存在しない。出力先の存在確認が要る

Codex 側（`~/.codex/auth.json`、rollout JSONL）は OS に依存しません。
**`AIUsage.js` は HTTPS で JSON を取るだけ**なので、iPhone 側は収集側の OS を問いません。

対応の Pull Request や動作報告は歓迎します。ただし作者は Windows / Linux で検証
できないため、実機で確認できる方の協力が要ります。

## もっと詳しく

- [docs/internals.md](docs/internals.md) — 実測したレスポンスのキー名、出力フォーマット、
  ウィジェットの実装判断、iCloud のハマりどころ。**壊れたときはここを読んでください**
- [CLAUDE.md](CLAUDE.md) — 何を試して駄目だったか、何を再検討しないと決めたか
- [READ_FIRST.md](READ_FIRST.md) — 使う前の注意（このページ冒頭の詳細版）

## ライセンス

MIT。[LICENSE](LICENSE) を参照。
