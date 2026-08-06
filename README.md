[English](README.en.md) | **日本語**

# AI Usage Widget

Claude と Codex のサブスク使用枠を、iPhone のホーム画面で確認できるようにするツールです。
Mac 側のスクリプトが 30 分ごとに使用率を取得して小さな JSON ファイルに書き出し、
iOS の [Scriptable](https://scriptable.app/) ウィジェットがそれを読んで表示します。

ウィジェットの表示言語は端末の設定に従います（日本語端末なら日本語、それ以外は英語）。

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
> `~/.codex/auth.json`）。**読み取るだけで、Mac の外には一切送信しません。**書き出す
> JSON に含まれるのは使用率・リセット時刻・状態だけです。とはいえ認証情報に触れる
> スクリプトですので、**実行する前に `ai_usage_fetch.py` をご自身の目で確認して
> ください。**800 行ほどで、読みやすさを優先して書いてあります。
>
> 個人が自分用に作ったものです。**動作は保証できません。**詳しくは
> [READ_FIRST.md](READ_FIRST.md) をご覧ください。

## 動作環境

**収集側は macOS 専用、表示側は iOS 専用です。**Windows / Linux では動きません
（[後述](#windows--linux-について)）。

| | 必要なもの |
|---|---|
| 収集 | **macOS**（常時起動・スリープしない設定を推奨）、Python 3 |
| | Claude Code CLI（任意・推奨。トークンが失効したときの復旧に使います） |
| 表示 | **iPhone / iPad** と [Scriptable](https://scriptable.app/) |
| 受け渡し | 共有リンクを作れる場所（Dropbox / Google ドライブ / OneDrive / 自前の HTTP サーバー） |

**動作を確認したプランは Claude Max と Codex team だけです。**他のプランは未検証で、
`limits[]` の構成や Codex の `secondary_window` が異なる可能性があります。

## 仕組み

```
Mac（常時起動）
├─ ai_usage_fetch.py … Claude は OAuth エンドポイント、Codex は内部 API から取得
│                      （失敗したときだけ ~/.codex のログを読む）
├─ launchd が 30 分ごとに実行
└─ 出力先: 共有フォルダ と iCloud Drive/Scriptable/ai-usage.json
iPhone
└─ AIUsage.js（Scriptable ウィジェット）が取得して表示
```

ウィジェットは次の 3 つを順に試し、`generated_at`（データを作った時刻）が
いちばん新しいものを採用します。

1. **共有リンク（HTTPS）** — 外出先でもモバイル回線でも取得できます
2. **iCloud 上のファイル**
3. **端末内に保存してある控え** — 1 と 2 のどちらも取得できなかったときに使います

この順番には理由があります。**iOS のウィジェットからは、iCloud にあるだけで端末に
ダウンロードされていないファイルを読み込ませることができません。**そのため iCloud
だけに頼ると、表示がいつまでも更新されないことがあります。共有リンクを最優先にして
いるのはこのためです。

## セットアップ

### 1. Mac

```bash
AI_USAGE_PUBLIC_PATH="$HOME/Dropbox/ai-usage/ai-usage.json" ./install.sh
```

30 分ごとに実行される launchd ジョブ（`local.ai-usage`）を登録します。リポジトリ内の
`ai_usage_fetch.py` を**そのまま**呼び出すので、ファイルのコピーは作りません。
`~/.ai-usage/` はキャッシュとログの置き場所です。
**登録を解除する（アンインストールする）ときは `./install.sh uninstall` を実行します。**

`AI_USAGE_PUBLIC_PATH` には、クラウドに同期されるフォルダ内のパスを指定してください。
インストール時に指定しておくと、この値は launchd の設定に埋め込まれると同時に
`~/.ai-usage/public_path` にも保存されます。そのため、**あとから
`python3 ai_usage_fetch.py` を手動で実行したときも、同じファイルに書き込まれます。**

指定せずにインストールした場合は、リポジトリ内の `public/ai-usage.json` が出力先に
なります。この状態で、手動実行のときだけ `AI_USAGE_PUBLIC_PATH` を付けて実行すると、
launchd と手動実行で出力先が分かれてしまいます。共有リンクが古いファイルを指したまま
になるため、**出力先を変えるときは環境変数を付けて `./install.sh` を実行し直して
ください。**

### 2. 共有リンク

出力された `ai-usage.json` に対して、**「リンクを知っている全員」**が閲覧できる共有
リンクを作成します。リンクは各サービスが発行した形式のまま使えます。ダウンロード用の
URL への変換は、ウィジェット側が自動的に行います。

| サービス | 発行されるリンク | ウィジェットが変換した後 |
|---|---|---|
| Dropbox | `.../ai-usage.json?rlkey=…&dl=0` | `dl=1` に書き換え |
| Google ドライブ | `.../file/d/<ID>/view?usp=sharing` | `drive.usercontent.google.com/download?id=<ID>` |
| OneDrive / SharePoint | `https://1drv.ms/...` | `download=1` を付加 |
| 自前の HTTP サーバー | そのまま | 変換しません |
| GitHub raw / Gist raw | そのまま | 変換しません |

表にないサービスでも、JSON がそのまま返ってくる URL であれば使えます。ログインが必要な
リンクからは取得できません。JSON 以外が返ってきた場合は iCloud、次に端末内の控えへと
順に切り替わるだけですので、試してみて問題が起きることはありません。

> **共有リンクは、URL を知っている人なら誰でも閲覧できます。**中身は使用率・リセット
> 時刻・状態だけで認証情報は含まれませんが、その範囲の情報は公開されることになります。
> ご了承のうえでお使いください。

### 3. iPhone

`AIUsage.js` を iCloud Drive の `Scriptable/` フォルダに置き、ホーム画面に Scriptable
ウィジェットを追加して、Script に `AIUsage` を選択します。

続いて、**Scriptable アプリの中で** `AIUsage` を 1 回実行してください。共有リンクの
入力欄が表示され、保存すると**その場で 1 回取得して、成功したかどうかを知らせます**。
入力したリンクは Scriptable の Keychain（`ai-usage-url`）に保存され、スクリプト
ファイルには書き込まれません。

> **リンクを `AIUsage.js` に直接書き込まないでください。**このファイルは他の人に
> 渡すことがあるため、書き込んでしまうとリンクも一緒に渡ることになります。

入力欄が表示されるのは、**リンクがまだ登録されていないときと、登録済みのリンクから
取得できなかったとき**だけです。正常に動作しているときにアプリ内で実行した場合は、
プレビューを表示するだけで入力を求めません。

**すでに動いているリンクを変更したい場合**は、ショートカットアプリの `Run Script` で
パラメータに `setup` を渡して `AIUsage` を実行してください。現在のリンクが入力された
状態で入力欄が表示されます。空にして保存すると登録が消え、iCloud 経由の取得に戻ります。

## ウィジェットのレイアウト

Claude と Codex はサービスごとにグループ分けし、見出し・区切り線・サービスの色
（Claude はオレンジ、Codex は青）で区別します。使用量のバーは通常はサービスの色ですが、
50% 以上で琥珀色、80% 以上で赤色に変わります。

ウィジェットのサイズによってレイアウトが変わります。small と medium は高さが 158pt
しかなく、4 つの枠と見出しがそのままでは収まらないためです。

| サイズ | レイアウト | 表示内容 |
|---|---|---|
| small | 1 列 | Claude 2 枠 と Codex（`weekly_scoped` は週次枠の内訳なので省略） |
| medium | **2 列**（Claude ｜ Codex） | すべての枠。リセット時刻は省略 |
| large | 1 列 | すべての枠 とリセット時刻、クレジット |

## うまくいかないとき

```bash
python3 ai_usage_fetch.py --raw      # 加工前のレスポンスをそのまま表示します
python3 ai_usage_fetch.py --stdout   # ファイルに書き出さず、結果の JSON だけ表示します
tail -n 20 ~/.ai-usage/fetch.log     # launchd での実行結果を確認します
```

> **`--raw` の出力には、Codex 側の `email` / `user_id` / `account_id` が含まれます。**
> issue や SNS に貼り付けるときは、必ず削除してください。

ログは 1 行で状態が分かるようになっています。

```
2026-08-01T21:07:32+09:00 claude=ok codex=ok [token_exp=... icloud=changed dropbox=ok] -> ...
```

- `claude=login_required` — keychain のトークンが失効しています。これを更新できるのは
  **Claude Code の CLI だけ**で、デスクトップアプリやそのスケジュール実行では更新
  されません。そのため、失効したときだけ `claude -p` を 1 回（最大でも 1 時間に 1 回）
  実行して、公式のツールに更新させています
- `codex=login_required` — `~/.codex/auth.json` を確認してください
- `claude=empty` / `codex=empty` — 通信は成功したものの、枠が 1 件も読み取れていません。
  レスポンスのキー名が変わった可能性が高いので、`--raw` で実際の中身を確認してください
- `icloud=skipped` — 前回から中身が変わらなかったため、iCloud 上のファイルを更新して
  いません。これは意図的な動作です（30 分ごとに書き換えると、端末側の同期が追いつかなく
  なるためです）

## バージョン

`0.9.0` です。変更履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

作者の環境では問題なく動いていますが、**作者以外の環境で導入された実績がまだありません。**
開発中には、シェルのロケールが違うだけで `install.sh` が失敗する不具合が見つかりました
（`LANG=C` では成功し、`ja_JP.UTF-8` では失敗するというものです）。このように環境の違い
でしか表面化しない問題が、まだ残っている可能性があります。**別の環境で動作が確認できた
時点で 1.0.0 にします。**

不具合を報告していただく際は、`python3 ai_usage_fetch.py --version` の出力か、
書き出された JSON の `app_version` を添えてください。

## Windows / Linux について

現時点では動きません。対応できていないのは次の 3 点です。いずれも大きな問題ではありません。

1. **Claude の認証情報の読み取り** — `security` コマンド（macOS keychain）を使っています。
   Windows / Linux の Claude Code は `~/.claude/.credentials.json` に保存するはずで、
   **コードはすでにそちらも参照する**ため、そのまま動く可能性があります（未検証です）
2. **定期実行の仕組み** — launchd を使っています。Windows ではタスク スケジューラ、
   Linux では systemd か cron に置き換える必要があります
3. **iCloud への書き出し** — macOS 以外にはそのパスが存在しないため、
   出力先が存在するかどうかを確認する処理が必要です

Codex 側（`~/.codex/auth.json` と rollout JSONL）は OS に依存しません。また
**`AIUsage.js` は HTTPS で JSON を取得するだけ**ですので、iPhone 側は収集側の OS が
何であっても動きます。

対応の Pull Request や動作報告は歓迎します。ただし作者は Windows / Linux で検証できない
ため、実機で確認できる方のご協力が必要です。

## もっと詳しく

- [docs/internals.md](docs/internals.md) — 実際に確認したレスポンスのキー名、出力
  フォーマット、ウィジェットの実装上の判断、iCloud まわりの注意点をまとめています。
  **動かなくなったときは、まずここを読んでください**
- [CLAUDE.md](CLAUDE.md) — 何を試して駄目だったか、何を再検討しないと決めたかの記録です
- [READ_FIRST.md](READ_FIRST.md) — 使う前の注意事項（このページ冒頭の詳しい版です）

## ライセンス

MIT ライセンスです。詳細は [LICENSE](LICENSE) をご覧ください。
