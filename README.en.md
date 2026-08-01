**English** | [日本語](README.md)

# AI Usage Widget

See how much of your Claude and Codex subscription limits you have used, from your iPhone
home screen. A macOS script collects the numbers every 30 minutes and writes a small JSON;
a [Scriptable](https://scriptable.app/) widget on iOS fetches and draws it.

The widget follows the device language — Japanese on Japanese devices, English otherwise.

> ### ⚠️ Read this before using
>
> **This tool uses two undocumented endpoints.**
>
> | | Endpoint |
> |---|---|
> | Claude | `api.anthropic.com/api/oauth/usage` |
> | Codex | `chatgpt.com/backend-api/codex/usage` |
>
> Neither is officially documented. **They can change without notice and stop working.**
> Check the terms of service of each provider yourself.
>
> **It reads local credentials** — the macOS keychain item `Claude Code-credentials` and
> `~/.codex/auth.json`. **It only reads them; nothing leaves your Mac.** The JSON it writes
> contains usage percentages, reset times and status — nothing else. Even so, this is a
> script that touches your credentials: **read `ai_usage_fetch.py` yourself before running
> it.** It is about 700 lines and deliberately plain.
>
> Built by one person for their own use. **No warranty.**

## Requirements

**The collector is macOS only. The widget is iOS.** Windows and Linux are not supported —
see [below](#windows-and-linux).

| | What you need |
|---|---|
| Collector | **macOS** (always-on, sleep disabled recommended), Python 3 |
| | Claude Code CLI (optional but recommended — used to recover an expired token) |
| Widget | **iPhone / iPad** + [Scriptable](https://scriptable.app/) |
| Transport | Somewhere you can create a share link: Dropbox, Google Drive, OneDrive, or your own HTTP server |

**Verified on Claude Max and Codex team plans only.** Other plans are untested — the shape
of `limits[]` and Codex's `secondary_window` may differ.

## How it works

```
Mac (always on)
├─ ai_usage_fetch.py … Claude via OAuth endpoint, Codex via internal API
│                      (falls back to ~/.codex rollout logs only on failure)
├─ launchd runs it every 30 minutes
└─ writes: share folder + iCloud Drive/Scriptable/ai-usage.json
iPhone
└─ AIUsage.js (Scriptable widget) fetches and draws it
```

The widget tries, in order:

1. **Share link over HTTPS** — works anywhere, including cellular
2. **iCloud file**
3. **On-device cache**

It takes whichever has the newest `generated_at`. This ordering matters: **a widget
extension on iOS cannot trigger an on-demand iCloud download**, so relying on iCloud alone
leaves the widget showing stale data. That is why the share link is the primary path.

## Setup

### 1. Mac

```bash
AI_USAGE_PUBLIC_PATH="$HOME/Dropbox/ai-usage/ai-usage.json" ./install.sh
```

This registers a launchd job (`local.ai-usage`) that runs every 30 minutes and points
directly at the script in this repository. `~/.ai-usage/` holds the cache and logs.
To remove it: `./install.sh uninstall`.

Point `AI_USAGE_PUBLIC_PATH` at a folder that syncs to a cloud service. Passing it at
install time also records it, so running the script by hand writes to the same place.

### 2. Share link

Create a link to that `ai-usage.json` with **"anyone with the link"** access.
Dropbox, Google Drive and OneDrive links are all converted to a direct-download URL
automatically. A URL from your own HTTP server or GitHub raw works as-is.

> **The share link is readable by anyone who has the URL.** The contents are only usage
> percentages, reset times and status — no credentials — but understand that this is the
> exposure you are choosing.

### 3. iPhone

Put `AIUsage.js` in `Scriptable/` on iCloud Drive, add a Scriptable widget to the home
screen and select `AIUsage` as the script.

Then run `AIUsage` once **inside the Scriptable app**. It asks for the share link and
**fetches it once to confirm it works**. The link is stored in the Scriptable Keychain
(`ai-usage-url`), never written into the script.

> **Do not hard-code the link into `AIUsage.js`.** That file is meant to be shared; a
> hard-coded link would travel with it.

It only asks when something needs attention — when no link is stored, or when the stored one
cannot be fetched. Running it in the app otherwise just shows the preview.

To change a link that already works, run `AIUsage` from Shortcuts with `setup` as the
parameter. The current value is pre-filled; save an empty field to clear it and fall back
to iCloud.

## Widget layout

Claude and Codex are grouped separately, with a heading, a divider and a per-service colour
(Claude orange, Codex blue). Bars use the service colour normally, amber above 50% and red
above 80%.

Layout differs by size, because small and medium are only 158pt tall:

| Size | Layout | Contents |
|---|---|---|
| small | 1 column | Claude 2 windows + Codex. `weekly_scoped` omitted (it is a subset of weekly) |
| medium | **2 columns** (Claude \| Codex) | All windows, no reset times |
| large | 1 column | All windows + reset times + credits |

## Troubleshooting

```bash
python3 ai_usage_fetch.py --raw      # raw responses and raw events
python3 ai_usage_fetch.py --stdout   # resulting JSON without writing
tail -n 20 ~/.ai-usage/fetch.log     # what launchd has been doing
```

> **`--raw` output includes your Codex `email`, `user_id` and `account_id`.**
> Strip them before pasting into an issue.

The log line tells you a lot:

```
2026-08-01T21:07:32+09:00 claude=ok codex=ok [token_exp=... icloud=changed dropbox=ok] -> ...
```

- `claude=login_required` — the keychain token expired. **Only the Claude Code CLI refreshes
  it**; the desktop app and its scheduled routines do not. The script runs `claude -p` once
  (at most hourly) to let the official tool refresh it.
- `claude=empty` — the request succeeded but no windows could be read. A key name changed.
  Look at `--raw`.
- `icloud=skipped` — the contents did not change, so the iCloud file was left alone. This is
  deliberate: rewriting it every 30 minutes prevents devices from ever catching up.

## Version

`0.9.0`. See [CHANGELOG.md](CHANGELOG.md).

It runs reliably for the author, but **nobody else has installed it yet**, so it is 0.9.
During development a bug was found where `install.sh` failed under a Japanese locale but
worked under `LANG=C` — problems that only appear on someone else's machine are likely to
remain. **It becomes 1.0.0 once it is confirmed working in another environment.**

When reporting a problem, include the output of `python3 ai_usage_fetch.py --version`, or
the `app_version` field in the JSON.

## Windows and Linux

Not supported today. Three things are in the way, none of them large:

1. **Claude credentials** — the script uses `security` (macOS keychain). On Windows and
   Linux, Claude Code should store them in `~/.claude/.credentials.json`, and **the code
   already looks there as a fallback**, so it may just work (untested).
2. **Scheduling** — launchd. Windows would need Task Scheduler; Linux systemd or cron.
3. **iCloud output** — that path does not exist off macOS; it needs an existence check.

Codex (`~/.codex/auth.json`, rollout JSONL) does not depend on the OS, and **`AIUsage.js`
only fetches JSON over HTTPS**, so the phone side does not care what collected the data.

Pull requests and reports are welcome, but the author cannot test on Windows or Linux, so
this needs someone who can.

## More detail

This file covers installing and running the tool. The Japanese [README.md](README.md) also
documents the exact response keys, the output format, and the reasoning behind the design.
[CLAUDE.md](CLAUDE.md) is a working log of what was tried, what failed, and what was decided
not to revisit — useful before changing anything. Both are Japanese only.

## License

MIT. See [LICENSE](LICENSE).
