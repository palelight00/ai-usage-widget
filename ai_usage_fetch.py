#!/usr/bin/env python3
"""Claude / Codex のサブスク使用枠を集めて JSON に書き出す。

Claude: keychain の OAuth トークンで https://api.anthropic.com/api/oauth/usage を叩く。
Codex : ~/.codex/auth.json のトークンで backend-api/codex/usage を叩く。失敗したら
        ~/.codex/sessions/**/rollout-*.jsonl の rate_limits にフォールバックする
        （こちらは Codex を使ったときにしか更新されないので古くなりうる）。

出力は iCloud Drive/Scriptable/ai-usage.json。取得に失敗した側は前回の windows を残し、
status を差し替えて stale / last_attempt_at を足す。fetched_at は前回成功時のまま
据え置く（ウィジェット側で「その数値がいつのものか」を出せるように）。

    python3 ai_usage_fetch.py          # 通常実行
    python3 ai_usage_fetch.py --raw    # 生レスポンス / 生イベントを表示して終了
    python3 ai_usage_fetch.py --stdout # 書き出さず結果 JSON を表示
"""

from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# 壊れる前提のツールなので、利用者が「どの版か」を言えるようにしておく。
# AIUsage.js の VERSION と揃えること。
__version__ = "0.9.1"

# --- 実物を見て決めた定数。壊れたら --raw で確認してここを直す -----------------

KEYCHAIN_SERVICE = "Claude Code-credentials"
CLAUDE_CREDENTIALS_FILE = os.path.expanduser("~/.claude/.credentials.json")
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_BETA_HEADER = "oauth-2025-04-20"

# keychain のアクセストークンは約 8 時間で切れる。これを更新するのは CLI だけで、
# デスクトップアプリもそのルーティンも更新しない（自前の Claude Safe Storage を使う。
# 失効中に 6 回以上ルーティンが走っても更新されないことを実測で確認した）。
#
# `claude --version` では駄目で、`claude -p` のように**認証を通る経路**を踏む必要が
# ある（これも実測）。401 のときだけ 1 ターン回して公式に更新させ、再試行する。
# トークンそのものは触らない（自前でリフレッシュしない方針は維持）。
CLAUDE_CLI_CANDIDATES = [
    os.path.expanduser("~/.local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    "claude",
]
CLAUDE_CLI_TIMEOUT = 180
CLAUDE_REFRESH_PROMPT = "ok"  # 消費を最小にする
# 成功すれば約 8 時間もつ。30 分ごとに叩くと無駄打ちになり 429 を招くので間隔を空ける。
CLAUDE_REFRESH_MIN_INTERVAL = 3600

# 中身が変わらなくても、この間隔では 1 回書く（Mac が生きていることを端末に伝える）
ICLOUD_FORCE_WRITE_SECONDS = 2 * 3600

CODEX_AUTH_FILE = os.path.expanduser("~/.codex/auth.json")
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"
CODEX_SESSIONS_DIR = os.path.expanduser("~/.codex/sessions")
CODEX_SCAN_FILES = 12  # 新しい順に何ファイルまで見るか
CODEX_TAIL_BYTES = 3_000_000  # 巨大 JSONL は末尾だけ読む

# 共有リンク用の出力。ウィジェットはこれを HTTPS で取りに行く。
# iCloud と違い、ウィジェット拡張からでも確実に読める。
#
# 既定はリポジトリ内の public/（.gitignore 済み）。Dropbox / Google ドライブ /
# OneDrive など、同期されるフォルダを指すよう環境変数か --public で差し替える。
#   例: AI_USAGE_PUBLIC_PATH="$HOME/Google Drive/My Drive/ai-usage/ai-usage.json"
DEFAULT_PUBLIC_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "public", "ai-usage.json"
)
# install.sh が控えた設定。環境変数を付けずに手で動かしても同じ場所に書けるようにする
# （別々の場所に書くと、古いほうの共有リンクを掴んだまま気づけない）。
PUBLIC_PATH_FILE = os.path.expanduser("~/.ai-usage/public_path")


def configured_public_path() -> str:
    """--public > 環境変数 > install.sh が控えた設定 > 既定 の順で決める。"""
    from_env = os.environ.get("AI_USAGE_PUBLIC_PATH")
    if from_env:
        return os.path.expanduser(from_env)
    try:
        with open(PUBLIC_PATH_FILE, encoding="utf-8") as fh:
            saved = fh.read().strip()
        if saved:
            return os.path.expanduser(saved)
    except OSError:
        pass
    return DEFAULT_PUBLIC_PATH


PUBLIC_PATH = configured_public_path()

STATE_DIR = os.path.expanduser("~/.ai-usage")
OUTPUT_PATH = os.path.expanduser(
    "~/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents/ai-usage.json"
)

# limits[].kind → 表示ラベル（Mac 側の既定。ウィジェットは端末の言語で作り直す）
CLAUDE_KIND_LABELS = {
    "session": "5時間",
    "weekly_all": "週次",
    "weekly_scoped": "週次",
}

# limits[].kind → 枠の長さ（分）。Claude のレスポンスには入っていないので補う。
# これがあると、表示側が言語に依存せずラベルを組み立てられる。
CLAUDE_KIND_MINUTES = {
    "session": 300,
    "weekly_all": 10080,
    "weekly_scoped": 10080,
}

HTTP_TIMEOUT = 20


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def to_iso(value) -> str | None:
    """unix 秒 / ISO 文字列のどちらでも ISO8601 に揃える。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).astimezone().isoformat(
            timespec="seconds"
        )
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().isoformat(
                timespec="seconds"
            )
        except ValueError:
            return value
    return None


def window_label(minutes) -> str:
    """window_minutes から日本語ラベルを作る。"""
    if not isinstance(minutes, (int, float)) or minutes <= 0:
        return "使用枠"
    if minutes % 10080 == 0:
        return "週次" if minutes == 10080 else f"{int(minutes // 10080)}週"
    if minutes % 1440 == 0:
        return f"{int(minutes // 1440)}日"
    if minutes % 60 == 0:
        return f"{int(minutes // 60)}時間"
    return f"{int(minutes)}分"


# --- Claude -------------------------------------------------------------------


def read_claude_credentials() -> dict | None:
    """keychain → ファイルの順で OAuth 認証情報を探す。

    keychain が読めても中にトークンが無いことがある（構造変化・別用途の項目）。
    その場合はファイル側まで見に行く。最後の候補は「トークンは無いが読めたもの」。
    """
    candidates = []

    try:
        proc = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            candidates.append(json.loads(proc.stdout))
    except (OSError, ValueError, subprocess.SubprocessError):
        pass

    try:
        with open(CLAUDE_CREDENTIALS_FILE, encoding="utf-8") as fh:
            candidates.append(json.load(fh))
    except (OSError, ValueError):
        pass

    for cred in candidates:
        if extract_access_token(cred):
            return cred
    return candidates[0] if candidates else None


def extract_access_token(cred) -> str | None:
    """claudeAiOauth.accessToken を優先しつつ、構造が変わっても拾えるよう再帰探索する。"""
    if not isinstance(cred, dict):
        return None
    oauth = cred.get("claudeAiOauth")
    if isinstance(oauth, dict) and isinstance(oauth.get("accessToken"), str) and oauth["accessToken"]:
        return oauth["accessToken"]

    for key in ("accessToken", "access_token", "token"):
        value = cred.get(key)
        if isinstance(value, str) and value:
            return value
    for value in cred.values():
        if isinstance(value, dict):
            found = extract_access_token(value)
            if found:
                return found
    return None


def fetch_claude_raw() -> tuple[dict | None, dict | None, str]:
    """(raw JSON, credentials, status) を返す。"""
    cred = read_claude_credentials()
    token = extract_access_token(cred)
    if not token:
        return None, cred, "login_required"

    req = urllib.request.Request(
        CLAUDE_USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": CLAUDE_BETA_HEADER,
            "Content-Type": "application/json",
            "User-Agent": "ai-usage-widget/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode()), cred, "ok"
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return None, cred, "login_required"
        return None, cred, f"http_{exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, cred, f"error:{type(exc).__name__}"


def refresh_stamp_path() -> str:
    return os.path.join(STATE_DIR, "cli_refresh.stamp")


def refreshed_recently() -> bool:
    """直近に CLI を叩いたばかりなら、もう一度叩かない。"""
    try:
        return (time.time() - os.path.getmtime(refresh_stamp_path())) < CLAUDE_REFRESH_MIN_INTERVAL
    except OSError:
        return False


def mark_refresh_attempt() -> None:
    """試行した事実を先に記録する（途中で固まっても間隔が守られるように）。"""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(refresh_stamp_path(), "w", encoding="utf-8") as fh:
            fh.write(now_iso() + "\n")
    except OSError:
        pass


def nudge_claude_cli() -> bool:
    """Claude Code CLI で 1 ターン回し、keychain のトークンを更新させる。

    公式ツールに更新させて、その結果を keychain から読み直すだけ。
    こちらでリフレッシュトークンは使わない。
    """
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except OSError:
        pass
    for path in CLAUDE_CLI_CANDIDATES:
        try:
            proc = subprocess.run(
                [path, "-p", CLAUDE_REFRESH_PROMPT],
                capture_output=True,
                text=True,
                timeout=CLAUDE_CLI_TIMEOUT,
                cwd=STATE_DIR,  # プロジェクトの CLAUDE.md を読ませない
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode == 0:
            return True
    return False


def token_expires_at(cred) -> str | None:
    """keychain に入っている期限。ログに出して失効を追えるようにする。"""
    if not isinstance(cred, dict):
        return None
    oauth = cred.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        return None
    value = oauth.get("expiresAt")
    if isinstance(value, (int, float)):
        return to_iso(value / 1000)  # ミリ秒
    return None


def parse_claude(raw: dict, cred: dict | None) -> dict:
    """limits[] を正とし、無ければ five_hour / seven_day にフォールバックする。"""
    windows = []

    for item in raw.get("limits") or []:
        if not isinstance(item, dict):
            continue
        percent = item.get("percent")
        if not isinstance(percent, (int, float)):
            continue
        label = CLAUDE_KIND_LABELS.get(item.get("kind"), item.get("kind") or "使用枠")
        scope = item.get("scope") or {}
        model = (scope.get("model") or {}).get("display_name") if isinstance(scope, dict) else None
        if model:
            label = f"{label}({model})"
        # label は日本語。表示側で組み立て直せるよう、素材も別に持たせる
        # （ウィジェットは端末の言語に合わせてラベルを作る）。
        windows.append(
            {
                "key": item.get("kind"),
                "label": label,
                "scope_model": model,
                "window_minutes": CLAUDE_KIND_MINUTES.get(item.get("kind")),
                "percent": float(percent),
                "resets_at": to_iso(item.get("resets_at")),
                "severity": item.get("severity"),
                "is_active": bool(item.get("is_active")),
            }
        )

    if not windows:
        for key, label in (("five_hour", "5時間"), ("seven_day", "週次")):
            block = raw.get(key)
            if not isinstance(block, dict):
                continue
            percent = block.get("utilization")
            if not isinstance(percent, (int, float)):
                continue
            windows.append(
                {
                    "key": key,
                    "label": label,
                    "scope_model": None,
                    "window_minutes": 300 if key == "five_hour" else 10080,
                    "percent": float(percent),
                    "resets_at": to_iso(block.get("resets_at")),
                    "severity": None,
                    "is_active": None,
                }
            )

    result = {
        "status": "ok",
        "fetched_at": now_iso(),
        "windows": windows,
    }

    oauth = (cred or {}).get("claudeAiOauth") if isinstance(cred, dict) else None
    if isinstance(oauth, dict):
        result["plan"] = oauth.get("subscriptionType")

    extra = raw.get("extra_usage")
    if isinstance(extra, dict) and extra.get("is_enabled"):
        percent = extra.get("utilization")
        used = extra.get("used_credits")
        limit = extra.get("monthly_limit")
        # 使用量が 0 のとき utilization は null で返る（月初に実測）。
        # 0% も表示すべき情報なので、使用量と上限から自分で出す。
        if not isinstance(percent, (int, float)) and isinstance(used, (int, float)):
            if isinstance(limit, (int, float)) and limit > 0:
                percent = used / limit * 100
        result["extra_usage"] = {
            "percent": float(percent) if isinstance(percent, (int, float)) else None,
            "used": extra.get("used_credits"),
            "limit": extra.get("monthly_limit"),
            "currency": extra.get("currency"),
            "decimal_places": extra.get("decimal_places"),
        }
    return result


# --- Codex --------------------------------------------------------------------


def codex_token_expires_at() -> str | None:
    """auth.json の access_token（JWT）から失効時刻を取る。

    Claude が約 8 時間なのに対し Codex は約 10 日と長い。しかも更新するのは
    `codex` CLI だけで、デスクトップアプリは触らない（実測）。そのため切れても
    誰も気づかず、JSONL の古い値を配ったまま何日も走りうる（183 時間踏んだ）。
    予兆を掴むためにログへ出す。トークン本体は読むだけで外には出さない。
    """
    try:
        with open(CODEX_AUTH_FILE, encoding="utf-8") as fh:
            auth = json.load(fh)
    except (OSError, ValueError):
        return None

    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    token = tokens.get("access_token") if isinstance(tokens, dict) else None
    if not isinstance(token, str):
        return None

    parts = token.split(".")
    if len(parts) < 2:
        return None  # JWT でなければ期限は読めない。壊さず諦める
    body = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(body))
    except (ValueError, TypeError):
        return None
    if not isinstance(claims, dict):
        return None

    exp = claims.get("exp")
    return to_iso(exp) if isinstance(exp, (int, float)) else None


def fetch_codex_raw() -> tuple[dict | None, str]:
    """内部エンドポイントから現在値を取る。(raw JSON, status)。"""
    try:
        with open(CODEX_AUTH_FILE, encoding="utf-8") as fh:
            auth = json.load(fh)
    except (OSError, ValueError):
        return None, "login_required"

    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    tokens = tokens if isinstance(tokens, dict) else {}
    token = tokens.get("access_token") or (auth.get("access_token") if isinstance(auth, dict) else None)
    if not isinstance(token, str) or not token:
        return None, "login_required"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "ai-usage-widget/1.0",
    }
    account_id = tokens.get("account_id")
    if isinstance(account_id, str) and account_id:
        headers["chatgpt-account-id"] = account_id

    req = urllib.request.Request(CODEX_USAGE_URL, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode()), "ok"
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return None, "login_required"
        return None, f"http_{exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, f"error:{type(exc).__name__}"


def parse_codex_api(raw: dict) -> dict:
    """backend-api/codex/usage のレスポンスを共通形に落とす。"""
    limit = raw.get("rate_limit")
    limit = limit if isinstance(limit, dict) else {}
    windows = []

    for slot, key in (("primary", "primary_window"), ("secondary", "secondary_window")):
        block = limit.get(key)
        if not isinstance(block, dict):
            continue
        percent = block.get("used_percent")
        if not isinstance(percent, (int, float)):
            continue
        seconds = block.get("limit_window_seconds")
        minutes = seconds / 60 if isinstance(seconds, (int, float)) else None
        windows.append(
            {
                "key": slot,
                "label": window_label(minutes),
                "percent": float(percent),
                "resets_at": to_iso(block.get("reset_at")),
                "window_minutes": minutes,
            }
        )

    result = {
        "status": "ok",
        "fetched_at": now_iso(),
        "observed_at": now_iso(),  # API は常に現在値
        "observed_age_seconds": 0,
        "source": "api",
        "plan": raw.get("plan_type"),
        "windows": windows,
    }
    if limit.get("limit_reached"):
        result["limit_reached"] = True

    credits = raw.get("credits")
    if isinstance(credits, dict) and credits.get("has_credits"):
        # 実物を見たことがない（has_credits は常に false だった）。
        # balance の単位が不明なので、判断材料になりそうな項目もまとめて残す。
        result["credits"] = {
            "balance": credits.get("balance"),
            "unlimited": bool(credits.get("unlimited")),
            "overage_limit_reached": bool(credits.get("overage_limit_reached")),
            "approx_local_messages": credits.get("approx_local_messages"),
            "approx_cloud_messages": credits.get("approx_cloud_messages"),
        }
    return result


def codex_rollout_files() -> list[str]:
    files = glob.glob(os.path.join(CODEX_SESSIONS_DIR, "**", "rollout-*.jsonl"), recursive=True)
    return sorted(files, key=os.path.getmtime, reverse=True)


def iter_tail_lines(path: str):
    """末尾 CODEX_TAIL_BYTES を新しい行から順に返す。"""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            start = max(0, size - CODEX_TAIL_BYTES)
            fh.seek(start)
            chunk = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return
    lines = chunk.split("\n")
    if start > 0 and lines:
        lines = lines[1:]  # 途中で切れた行を捨てる
    for line in reversed(lines):
        line = line.strip()
        if line:
            yield line


def find_latest_codex_event() -> tuple[dict | None, str | None]:
    """いちばん新しい rate_limits イベントと、その出所ファイルを返す。"""
    best = None
    best_file = None
    for path in codex_rollout_files()[:CODEX_SCAN_FILES]:
        for line in iter_tail_lines(path):
            if "rate_limits" not in line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            limits = (event.get("payload") or {}).get("rate_limits")
            if not isinstance(limits, dict):
                continue
            stamp = event.get("timestamp") or ""
            if best is None or stamp > (best.get("timestamp") or ""):
                best, best_file = event, path
            break  # このファイルでいちばん新しい 1 件だけで十分
    return best, best_file


def parse_codex(event: dict, source_file: str | None) -> dict:
    limits = (event.get("payload") or {}).get("rate_limits") or {}
    windows = []

    for slot in ("primary", "secondary"):
        block = limits.get(slot)
        if not isinstance(block, dict):
            continue
        percent = block.get("used_percent")
        if not isinstance(percent, (int, float)):
            continue
        windows.append(
            {
                "key": slot,
                "label": window_label(block.get("window_minutes")),
                "percent": float(percent),
                "resets_at": to_iso(block.get("resets_at")),
                "window_minutes": block.get("window_minutes"),
            }
        )

    observed = to_iso(event.get("timestamp"))
    age = None
    if observed:
        try:
            age = int((datetime.now(timezone.utc) - datetime.fromisoformat(observed)).total_seconds())
        except ValueError:
            age = None

    result = {
        "status": "ok",
        "fetched_at": now_iso(),
        "observed_at": observed,
        "observed_age_seconds": age,
        "source": os.path.basename(source_file) if source_file else None,
        "plan": limits.get("plan_type"),
        "windows": windows,
    }

    credits = limits.get("credits")
    if isinstance(credits, dict) and credits.get("has_credits"):
        result["credits"] = {
            "balance": credits.get("balance"),
            "unlimited": bool(credits.get("unlimited")),
        }
    return result


# --- 出力 ---------------------------------------------------------------------


def load_previous(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def carry_over(previous: dict, name: str, status: str) -> dict:
    """取得に失敗した側。前回値を残し status だけ更新する。"""
    kept = previous.get(name)
    if isinstance(kept, dict) and kept.get("windows"):
        stale = dict(kept)
        stale["status"] = status
        stale["stale"] = True
        stale["last_attempt_at"] = now_iso()
        # 前回が JSONL 経由だった場合の api_status が残ると、今回の失敗理由と
        # 混ざる。理由は status が持っているので落とす。
        stale.pop("api_status", None)
        return stale
    return {"status": status, "fetched_at": None, "last_attempt_at": now_iso(), "windows": []}


def write_atomic(path: str, payload: dict) -> None:
    """一時ファイル経由で置き換える。ローカルのキャッシュ向け。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def content_signature(payload: dict) -> str:
    """毎回変わる時刻類を除いた「意味のある中身」の指紋。

    30 分ごとに無条件で書き換えると、iCloud が端末へ配り終える前に次の版が来る。
    中身が同じなら書かないことで、追いつく機会を作る。
    """

    def meaningful(section):
        if not isinstance(section, dict):
            return None
        return {
            "status": section.get("status"),
            "plan": section.get("plan"),
            "source": section.get("source"),
            "stale": section.get("stale"),
            "windows": [
                {k: w.get(k) for k in ("key", "label", "percent", "resets_at")}
                for w in (section.get("windows") or [])
                if isinstance(w, dict)
            ],
            "extra_usage": section.get("extra_usage"),
            "credits": section.get("credits"),
        }

    return json.dumps(
        {"claude": meaningful(payload.get("claude")), "codex": meaningful(payload.get("codex"))},
        ensure_ascii=False,
        sort_keys=True,
    )


def write_in_place(path: str, payload: dict) -> None:
    """既存ファイルを開いたまま上書きする。iCloud 向け。

    os.replace() は毎回ファイルを作り直す（inode が変わる）ので、iCloud からは
    「削除 + 新規作成」に見える。端末側のローカルコピーが 30 分ごとに無効化され、
    ウィジェットが読むたびにダウンロード待ちになってしまう。
    1.5KB 程度なので 1 回の write で十分に不可分。
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    # "w" は開いた瞬間に長さ 0 にする。その状態を iCloud が拾うと端末側で
    # 空ファイルとして見える。"r+" で上書きしてから余りを切り詰める。
    #
    # フォールバックは「ファイルが無い」ときだけにする。権限エラーや File Provider の
    # 一時エラーで "w" に落ちると inode が変わり、inode を保つ目的が崩れる。
    created = False
    try:
        fh = open(path, "r+", encoding="utf-8")
    except FileNotFoundError:
        fh = open(path, "w", encoding="utf-8")
        created = True
    with fh:
        fh.write(body)
        fh.truncate()
        fh.flush()
        os.fsync(fh.fileno())

    # write と truncate は不可分ではない。壊れたまま iCloud に上がらないよう読み返す。
    try:
        with open(path, encoding="utf-8") as check:
            json.load(check)
    except (OSError, ValueError):
        with open(path, "w", encoding="utf-8") as retry:
            retry.write(body)
            retry.flush()
            os.fsync(retry.fileno())
        created = True

    if created:
        print(f"{now_iso()} note: {os.path.basename(path)} を作り直した（inode が変わる）")


def dump_raw() -> int:
    print("=== Claude: GET", CLAUDE_USAGE_URL, "===")
    raw, cred, status = fetch_claude_raw()
    print("status:", status)
    if raw is not None:
        print(json.dumps(raw, ensure_ascii=False, indent=2))
    elif status == "login_required":
        print("トークンが見つからない / 失効。以下を確認する:")
        print(f'  security find-generic-password -s "{KEYCHAIN_SERVICE}" -w | head -c 80')
        print(f"  ls -l {CLAUDE_CREDENTIALS_FILE}")

    print("\n=== Codex: GET", CODEX_USAGE_URL, "===")
    codex_raw, codex_status = fetch_codex_raw()
    print("status:", codex_status)
    if codex_raw is not None:
        print(json.dumps(codex_raw, ensure_ascii=False, indent=2))
    else:
        print(f"トークンを確認する: {CODEX_AUTH_FILE} の tokens.access_token")

    print("\n=== Codex: フォールバック（最新 rate_limits イベント）===")
    event, source = find_latest_codex_event()
    if event is None:
        print("イベントなし。JSONL は Codex で実際にターンを回さないと増えない")
        print("（アプリ起動や /status だけでは増えない）。API 側の復旧を優先する。")
    else:
        print("source:", source)
        print(json.dumps(event, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=f"ai-usage {__version__}")
    parser.add_argument("--raw", action="store_true", help="生レスポンス / 生イベントを表示して終了")
    parser.add_argument("--stdout", action="store_true", help="ファイルに書かず結果 JSON を表示")
    parser.add_argument("--out", default=OUTPUT_PATH, help="出力先 JSON のパス")
    parser.add_argument(
        "--public",
        default=PUBLIC_PATH,
        help="共有リンク用の出力先（Dropbox / Google ドライブなど同期フォルダ内）",
    )
    args = parser.parse_args()

    if args.raw:
        return dump_raw()

    previous = load_previous(args.out) or load_previous(os.path.join(STATE_DIR, "last.json"))

    raw, cred, claude_status = fetch_claude_raw()

    # 失効していたら CLI に更新させて 1 度だけやり直す（間隔を空けて無駄打ちを防ぐ）
    nudged = False
    if raw is None and claude_status == "login_required" and not refreshed_recently():
        mark_refresh_attempt()
        nudged = nudge_claude_cli()
        if nudged:
            raw, cred, claude_status = fetch_claude_raw()

    if raw is not None:
        try:
            claude = parse_claude(raw, cred)
        except Exception as exc:  # 想定外の構造変化で全体を落とさない
            claude = carry_over(previous, "claude", f"parse_error:{type(exc).__name__}")
        else:
            # 200 でも 1 件も取れないのはキー名が変わったということ。
            # 「正常・データなし」で前回値を潰さない。
            if not claude.get("windows"):
                claude = carry_over(previous, "claude", "empty")
    else:
        claude = carry_over(previous, "claude", claude_status)

    if nudged:
        claude["cli_refresh"] = True  # CLI に更新させたことを記録
    expires = token_expires_at(cred)
    if expires:
        claude["token_expires_at"] = expires

    # Codex はまず内部エンドポイント（常に現在値）、駄目なら JSONL（古くなりうる）
    codex = None
    codex_raw, codex_status = fetch_codex_raw()
    if codex_raw is not None:
        try:
            parsed = parse_codex_api(codex_raw)
        except Exception as exc:
            codex_status = f"parse_error:{type(exc).__name__}"
        else:
            if parsed.get("windows"):
                codex = parsed
            else:
                codex_status = "empty"  # 200 だが枠が読めない = 構造変化

    if codex is None:
        event, source = find_latest_codex_event()
        if event is None:
            # ここに来る時点で codex_status は必ず失敗を表している
            # （API 成功かつ枠あり = codex is not None、枠なし = "empty"）
            codex = carry_over(previous, "codex", codex_status)
        else:
            try:
                fallback = parse_codex(event, source)
            except Exception as exc:
                fallback = carry_over(previous, "codex", f"parse_error:{type(exc).__name__}")
            else:
                if fallback.get("windows"):
                    fallback["api_status"] = codex_status  # なぜ API を使わなかったか
                    # JSONL は「実データだが現在値ではない」。ターンを回さないと
                    # 1 件も増えないので、API が落ちたまま何日も同じ値を配りうる。
                    # 表示側に古いと伝えないと、通常の明るさで描かれてしまう。
                    fallback["stale"] = True
                else:
                    fallback = carry_over(previous, "codex", "empty")
            codex = fallback

    # どの経路で取れたかに関わらず、資格情報の期限は auth.json が持っている
    codex_expires = codex_token_expires_at()
    if codex_expires:
        codex["token_expires_at"] = codex_expires

    payload = {
        "schema": 1,
        "app_version": __version__,
        "generated_at": now_iso(),
        "claude": claude,
        "codex": codex,
    }

    if args.stdout:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    # ローカルの正本は必ず更新する（配信するならこちらが元になる）
    os.makedirs(STATE_DIR, exist_ok=True)
    write_atomic(os.path.join(STATE_DIR, "last.json"), payload)

    # Dropbox 側は毎回更新する。Dropbox はプッシュ型で、iCloud のような
    # 「配り終わる前に次が来る」問題が出ないため、間引く必要がない。
    try:
        write_atomic(os.path.expanduser(args.public), payload)
        public_state = "ok"
    except OSError as exc:
        public_state = f"error:{type(exc).__name__}"

    # iCloud は中身が変わったときだけ書く。変化が無いのに書き換えると、
    # 端末側のコピーが配り終わる前に無効化され、いつまでも追いつかない。
    # ただし Mac の死活が分かるよう、無変化でも一定時間で 1 回は書く。
    changed = content_signature(payload) != content_signature(previous)
    try:
        aged = (time.time() - os.path.getmtime(args.out)) > ICLOUD_FORCE_WRITE_SECONDS
    except OSError:
        aged = True
    if changed or aged:
        write_in_place(args.out, payload)  # iCloud は inode を保つ書き方でないと同期が滞る
        written = "changed" if changed else "periodic"
    else:
        written = "skipped"

    ok = claude.get("status") == "ok" and codex.get("status") == "ok"
    extra = []
    if nudged:
        extra.append("cli_refresh")
    if claude.get("token_expires_at"):
        extra.append(f"token_exp={claude['token_expires_at']}")
    # JSONL に落ちた回も codex=ok のままなので、これが無いと事後に追えない
    # （実際、API が 183 時間落ちていた間のログが全行 codex=ok だった）。
    if codex.get("api_status"):
        extra.append(f"codex_api={codex['api_status']}")
        age = codex.get("observed_age_seconds")
        if isinstance(age, (int, float)) and age >= 3600:
            extra.append(f"codex_age={int(age // 3600)}h")
    if codex.get("token_expires_at"):
        extra.append(f"codex_exp={codex['token_expires_at']}")
    extra.append(f"icloud={written}")
    extra.append(f"dropbox={public_state}")
    suffix = f" [{' '.join(extra)}]" if extra else ""
    print(
        f"{now_iso()} claude={claude.get('status')} codex={codex.get('status')}{suffix}"
        f" -> {args.out}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
