#!/bin/bash
# ai-usage のインストーラ。
#
#   ./install.sh            30 分ごとの launchd ジョブを登録して 1 回実行する
#   ./install.sh uninstall  ジョブを外す（スクリプトと JSON は残す）
#
# launchd はこのリポジトリ内の ai_usage_fetch.py を直接指す（コピーしない）。
# ~/.ai-usage/ はキャッシュとログ専用。

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$REPO_DIR/ai_usage_fetch.py"
LABEL="local.ai-usage"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="$HOME/.ai-usage"
INTERVAL=1800 # 秒
# 共有リンク用の出力先。install 時にこの環境変数を渡すと plist に埋め込む。
#   AI_USAGE_PUBLIC_PATH="$HOME/Dropbox/ai-usage/ai-usage.json" ./install.sh
PUBLIC_PATH="${AI_USAGE_PUBLIC_PATH:-}"

uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "アンインストールしました: $LABEL"
}

if [[ "${1:-}" == "uninstall" ]]; then
  uninstall
  exit 0
fi

[[ -f "$SCRIPT" ]] || { echo "見つかりません: $SCRIPT" >&2; exit 1; }

PYTHON="$(command -v python3)"
[[ -n "$PYTHON" ]] || { echo "python3 が見つかりません" >&2; exit 1; }

mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
chmod +x "$SCRIPT"

# 既存ジョブがあれば先に外す（パス変更に追従させるため）
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# パスに空白や非 ASCII が入るので、plist は python で生成してエスケープを任せる
"$PYTHON" - "$PLIST" "$LABEL" "$PYTHON" "$SCRIPT" "$STATE_DIR" "$INTERVAL" "$PUBLIC_PATH" <<'PY'
import plistlib, sys

plist_path, label, python, script, state_dir, interval, public_path = sys.argv[1:8]

# launchd の PATH は最小限なので、claude を探せるよう明示する
# （失効時のトークン更新に CLI を使うため）
env = {
    "LANG": "ja_JP.UTF-8",
    "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
}
if public_path:
    env["AI_USAGE_PUBLIC_PATH"] = public_path

plist = {
    "Label": label,
    "ProgramArguments": [python, script],
    "StartInterval": int(interval),
    "RunAtLoad": True,
    "StandardOutPath": f"{state_dir}/fetch.log",
    "StandardErrorPath": f"{state_dir}/fetch.err.log",
    "ProcessType": "Background",
    "EnvironmentVariables": env,
}
with open(plist_path, "wb") as fh:
    plistlib.dump(plist, fh)
PY

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "登録しました: $LABEL（${INTERVAL} 秒ごと）"
echo "  plist : $PLIST"
echo "  script: $SCRIPT"
[ -n "$PUBLIC_PATH" ] && echo "  public: $PUBLIC_PATH"
echo "  log   : $STATE_DIR/fetch.log"
echo
sleep 2
tail -n 5 "$STATE_DIR/fetch.log" 2>/dev/null || echo "（ログはまだありません）"
