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
> it.** It is about 800 lines and deliberately plain.
>
> Built by one person for their own use. **No warranty.**
> See [READ_FIRST.md](READ_FIRST.md) for the full version of this notice (Japanese).

## What it looks like

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/widget-large-dark.jpg">
    <img src="docs/images/widget-large-light.jpg" width="330" alt="Large widget showing Claude at 31% of the 5-hour window, 10% weekly and 1% weekly (Fable), Codex at 77% weekly, with a line under each bar giving both the time until reset and the date, such as in 58m (08/15 21:59)">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/widget-medium-small-dark.jpg">
    <img src="docs/images/widget-medium-small-light.jpg" width="330" alt="Medium widget with Claude and Codex side by side in two columns, each row showing a compact reset timestamp to the left of the percentage, and the small widget in a single column without timestamps">
  </picture>
</p>

Large on the left; medium (top) and small (bottom) on the right.
The screenshots are from a Japanese device — on other devices the widget is in English.
The images follow your device theme, switching between light and dark.
See [Widget layout](#widget-layout) for what each size shows.

## Requirements

**The collector is macOS only. The widget is iOS.** Windows and Linux are not supported —
see [below](#windows-and-linux).

| | What you need |
|---|---|
| Collector | **macOS** (always-on, sleep disabled recommended), Python 3 |
| | Claude Code CLI and the `codex` CLI (**strongly recommended** — used to recover expired tokens) |
| Widget | **iPhone / iPad** + [Scriptable](https://scriptable.app/) |
| Transport | Somewhere you can create a share link: Dropbox, Google Drive, OneDrive, or your own HTTP server |

> ### ⚠️ It reads the CLI's credentials
>
> **If you only ever use the desktop apps, this will eventually stop fetching your usage.**
>
> The apps and the CLIs keep credentials in different places, and this tool reads the CLI
> side. No amount of app usage refreshes the files below.
>
> | | What this tool reads | What can refresh it |
> |---|---|---|
> | Claude | keychain item `Claude Code-credentials` | **the Claude Code CLI only** |
> | Codex | `~/.codex/auth.json` | **the `codex` CLI only** |
>
> Both measured. Claude returned `login_required` 53 times over 27 hours with the app
> running; Codex stayed expired for 183 hours with the app running.
> **Scheduled runs inside the app do not refresh them either.**
>
> **With the CLIs installed, recovery is automatic** — on detecting an expiry the collector
> makes a single call (`claude -p` for Claude, `codex exec` for Codex; at most hourly, each
> consuming one turn). Without them, you have to log in by hand every time a token expires.
>
> Token lifetimes: **about 8 hours for Claude, about 10 days for Codex.** The longer Codex
> lifetime makes an expiry easy to miss — it can serve stale numbers for days.

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

The widget tries, in order, and takes whichever has the newest `generated_at`:

1. **Share link over HTTPS** — works anywhere, including cellular
2. **iCloud file**
3. **On-device cache**

This ordering matters: **a widget extension on iOS cannot trigger an on-demand iCloud
download**, so relying on iCloud alone leaves the widget showing stale data. That is why
the share link is the primary path.

## Setup

### 1. Mac

```bash
AI_USAGE_PUBLIC_PATH="$HOME/Dropbox/ai-usage/ai-usage.json" ./install.sh
```

This registers a launchd job (`local.ai-usage`) that runs every 30 minutes and points
directly at the script in this repository — nothing is copied. `~/.ai-usage/` holds the
cache and logs. To remove it: `./install.sh uninstall`.

Point `AI_USAGE_PUBLIC_PATH` at a path inside a folder that syncs to a cloud service. The
value given at install time is embedded in the launchd job and also saved to
`~/.ai-usage/public_path`, so **running `python3 ai_usage_fetch.py` by hand later writes to
the same file.**

Without it, the output path is `public/ai-usage.json` inside the repository. If you then
set `AI_USAGE_PUBLIC_PATH` for manual runs only, launchd and manual runs write to different
files and the share link keeps pointing at the stale one. **To change the output path,
re-run `./install.sh` with the environment variable set.**

### 2. Share link

Create a link to that `ai-usage.json` with **"anyone with the link"** access. Paste the
link exactly as the service gives it to you — converting it to a direct download is handled
for you.

| Service | Link you paste | Converted to |
|---|---|---|
| Dropbox | `.../ai-usage.json?rlkey=…&dl=0` | `dl=1` |
| Google Drive | `.../file/d/<ID>/view?usp=sharing` | `drive.usercontent.google.com/download?id=<ID>` |
| OneDrive / SharePoint | `https://1drv.ms/...` | `download=1` appended |
| Your own HTTP server | as-is | no conversion |
| GitHub raw / Gist raw | as-is | no conversion |

Any other service works too, as long as the URL returns the raw JSON. Links that require
authentication will not work. If a registered URL returns something other than JSON, the
widget falls through to iCloud and then to the on-device cache.

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

The prompt appears only when no link is stored, or when the stored one could not be
fetched. Otherwise, running it in the app just shows the preview.

To change a link that already works, run `AIUsage` from Shortcuts with `setup` as the
parameter. The current value is pre-filled; save an empty field to clear it and fall back
to iCloud.

## Widget layout

Claude and Codex are grouped separately, with a heading, a divider and a per-service colour
(Claude orange, Codex blue). Bars use the service colour normally, amber above 50% and red
above 80%.

Layout differs by size, because small and medium are only 158pt tall: small drops the
reset times and shows bars only, medium uses its width for two columns.

| Size | Layout | Contents |
|---|---|---|
| small | 1 column | Claude 2 windows + Codex 2 windows (`weekly_scoped` omitted — it is a subset of weekly; no reset times) |
| medium | **2 columns** (Claude \| Codex) | All windows + reset times (compact `MM/DD HH:MM`, inline) |
| large | 1 column | All windows + time until reset with date (`in 3d (08/20 13:02)`) + credits |

The credits line appears only when extra-credit information is available — the screenshots
above do not show it.

See [What it looks like](#what-it-looks-like) for screenshots.

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
- `codex=login_required` — check `~/.codex/auth.json`. This only appears when **both**
  the API and the JSONL fallback fail.
- `codex_api=...` present — **the API failed and old JSONL values are being served.**
  `codex` itself still reads `ok`, so this field is the only clue. `codex_age=183h`
  tells you how old the served values are.

  ```
  claude=ok codex=ok [codex_api=login_required codex_age=183h ...]
  ```

  **The JSONL only grows when you actually run a turn in Codex** — leaving the app
  open adds nothing, so the same values can be served for days. The only fix is to
  restore the API, i.e. log in again.
- `codex_exp=...` — when the Codex token expires. It lasts about **10 days**, and only
  the `codex` CLI refreshes it — **the desktop app does not** (leaving the app running
  will not keep it alive).
- `codex_cli_refresh` — an expiry was detected, so `codex exec` was run once to let the
  official tool rewrite `auth.json` (at most hourly). Same mechanism as `cli_refresh` on
  the Claude side. **If this keeps appearing alongside `codex_api=login_required`**, the
  token cannot be restored automatically — run `codex login` in a terminal.
- `claude=empty` / `codex=empty` — the request succeeded but no windows could be read. A key
  name changed. Look at `--raw`.
- `icloud=skipped` — the contents did not change, so the iCloud file was left alone. This is
  deliberate: rewriting it every 30 minutes prevents devices from ever catching up.

## Version

`0.14.2`. See [CHANGELOG.md](CHANGELOG.md).

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

- [docs/internals.en.md](docs/internals.en.md) — the exact response keys observed, the
  output format, widget implementation decisions and the iCloud pitfalls.
  **Read this when it breaks.**
- [CLAUDE.md](CLAUDE.md) — a working log of what was tried, what failed, and what was
  decided not to revisit. Japanese only.
- [READ_FIRST.md](READ_FIRST.md) — the notice at the top of this page, in full. Japanese only.

## License

MIT. See [LICENSE](LICENSE).
