# はじめに読んでください

Claude と Codex のサブスク使用枠を Mac で集めて JSON に書き出し、
iPhone の Scriptable ウィジェットに表示するツールです。

**個人が自分用に作ったもの**をそのまま渡しています。動作の保証はありません。
使う前に、下の「重要な注意」に必ず目を通してください。

## 重要な注意

### 1. 非公開エンドポイントを使っています

| | エンドポイント | 位置づけ |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` | Claude Code が内部で使う非公開 OAuth |
| Codex | `chatgpt.com/backend-api/codex/usage` | ChatGPT の内部バックエンド API |

いずれも公式に文書化されたものではありません。**予告なく変わって動かなくなります。**
自分のアカウントで自分の使用量を読むだけの用途を想定しています。
各サービスの利用規約は自分で確認してください。

### 2. ローカルの認証情報を読みます

- Claude: macOS keychain の `Claude Code-credentials`
- Codex: `~/.codex/auth.json`

**読み取るだけで、Mac の外には一切出しません。**書き出す JSON に含まれるのは
使用率・リセット時刻・状態だけです。とはいえ認証情報に触れるスクリプトなので、
**実行前に `ai_usage_fetch.py` を自分の目で読んでください。**500 行ほどで読めます。

### 3. 401 のとき `claude -p` を 1 回実行します

keychain のアクセストークンは約 8 時間で切れます。これを更新するのは Claude Code の
**CLI だけ**で、デスクトップアプリもそのルーティンも更新しません。そのため失効時のみ
`claude -p ok` を 1 回走らせて公式に更新させています（1 時間に 1 回まで）。
ごく少量ですが使用枠を消費します。不要なら `nudge_claude_cli()` の呼び出しを外してください。

### 4. 作者の環境に合わせた作りです

- UI の文字列は**すべて日本語**です
- Claude は Max、Codex は team プランで確認しています。他プランでの動作は未確認です
- macOS 26 系 / Apple Silicon / Python 3 で動かしています

## 使い方

```bash
./install.sh          # launchd に 30 分間隔で登録
./install.sh uninstall # 解除
```

`AIUsage.js` を iCloud Drive の `Scriptable/` に置き、ホーム画面に Scriptable
ウィジェットを追加して Script に `AIUsage` を指定します。

動作確認は次の 2 つです。

```bash
python3 ai_usage_fetch.py --raw     # 生レスポンスを見る（構造が変わったとき用）
python3 ai_usage_fetch.py --stdout  # 書き出さずに結果 JSON を見る
```

**`--raw` の出力には Codex 側の `email` / `user_id` / `account_id` が含まれます。**
issue や SNS に貼るときは消してください。

## iPhone のウィジェットは Dropbox 共有リンクから取ります

**iCloud 経由は使えません。**ウィジェット拡張からは iCloud のオンデマンド・ダウンロードを
起こせず、ファイルが端末に降りていないと読めません。ショートカット経由なら読めますが、
それでも中身が数時間前ということがありました（実測）。

そのため取得経路は次の順です。**① が本命**で、これで解決しています。

1. **Dropbox 共有リンク（HTTPS）** — 外出先・セルラーでも動く
2. iCloud ファイル
3. 端末内の控え（`ai-usage-cache.json`）

### セットアップ

1. Mac 側は `public/ai-usage.json` にも書き出します（`.gitignore` 済み）。
   このファイルを **Dropbox / Google ドライブ / OneDrive など同期されるフォルダ**に置き、
   「リンクを知っている全員」の共有リンクを作ります。
   出力先は環境変数か引数で変えられます。
   ```bash
   AI_USAGE_PUBLIC_PATH="$HOME/Google Drive/My Drive/ai-usage/ai-usage.json" python3 ai_usage_fetch.py
   python3 ai_usage_fetch.py --public "$HOME/Dropbox/ai-usage/ai-usage.json"
   ```
   Dropbox・Google ドライブ・OneDrive の共有リンクは、貼るだけで直リンクに変換されます。
   自前の HTTP サーバーや GitHub raw の URL もそのまま使えます。
2. iPhone の Scriptable で `AIUsage` を 1 回実行すると入力欄が出るので、リンクを貼ります。
   保存すると**その場で 1 回取得して成否を知らせます**
3. リンクは **Keychain（`ai-usage-url`）** に保存され、スクリプトには書き込まれません

**リンクをスクリプトに直書きしないでください。**`AIUsage.js` は配布されるので、
直書きすると配布先にリンクが渡ります。変更するときは Scriptable で
`Keychain.remove("ai-usage-url")` を実行してから、アプリ内で 1 回動かすと再入力できます。

**共有リンクは URL を知っていれば誰でも読めます。**中身は使用率・リセット時刻・状態のみで
認証情報は含みませんが、公開範囲としてはそういう性質だと理解して使ってください。
Dropbox を使いたくない場合は、LAN 内に小さな HTTP サーバーを立てて同じ JSON を配る形でも
動きます（この配布物にサーバーは含まれていません）。

## 詳しい仕様

`README.md` に、実際に確認したキー名・出力フォーマット・ウィジェットのレイアウト方針・
ハマりどころを書いてあります。壊れたときはまずそこを読んでください。
`CLAUDE.md` は設計上の決定事項と、再検討しないと決めた項目の記録です。
