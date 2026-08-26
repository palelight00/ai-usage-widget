**English** | [日本語](internals.md)

# Internals and implementation notes

**This file exists so the tool can be repaired when it breaks.** For installing and running
it, see [README.en.md](../README.en.md). [CLAUDE.md](../CLAUDE.md) is the working log of
design decisions and dead ends (Japanese only).

The undocumented endpoints and the JSONL structure can change without notice. What follows
was verified against real responses on 2026-07-26; when it no longer matches, run
`python3 ai_usage_fetch.py --raw` and look at the real thing. The places to fix are the
constants at the top of `ai_usage_fetch.py`, or `parse_claude` / `parse_codex_api` (API) /
`parse_codex` (JSONL).

## Data sources

### Claude

The OAuth token lives in the **macOS keychain item `Claude Code-credentials`**.
`~/.claude/.credentials.json` does not exist in this environment (the code checks both).

```
security find-generic-password -s "Claude Code-credentials" -w
→ {"claudeAiOauth": {"accessToken": "...", "subscriptionType": "max", ...}, ...}
```

`GET https://api.anthropic.com/api/oauth/usage` (`Authorization: Bearer`,
`anthropic-beta: oauth-2025-04-20`) returns 200 with:

| Key used | Contents |
|---|---|
| `limits[]` | `kind` (`session` / `weekly_all` / `weekly_scoped`), `percent`, `resets_at`, `severity`, `is_active`, `scope.model.display_name` |
| `five_hour` / `seven_day` | `utilization` (%), `resets_at`. Fallback when `limits[]` is empty |
| `extra_usage` | `is_enabled`, `utilization`, `used_credits`, `monthly_limit`, `currency`, `decimal_places` |

Both `percent` and `utilization` are 0–100 percentages, not 0–1 ratios.
401/403 are treated as `login_required`.

A re-capture on 2026-08-26 showed `limits[]` entries gaining a `group` field
(`session` / `weekly`) and the top level gaining a `spend` block plus many mostly-null
experimental keys. The keys actually used are unchanged, so parsing is unaffected.

**`extra_usage.utilization` comes back null when nothing has been used** (observed at the
start of a month). 0% is information worth showing, so it is computed from `used_credits`
and `monthly_limit` instead.

### Codex (primary: internal endpoint)

Uses `tokens.access_token` and `tokens.account_id` from `~/.codex/auth.json`.

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

(Captured 2026-08-26. The response also carries `user_id` / `account_id` / `email` —
personal data, so not reproduced here — plus mostly-null keys such as
`code_review_rate_limit` / `additional_rate_limits` / `spend_control` / `promo`.
None of them are used.)

- `limit_window_seconds` is in **seconds** (the JSONL uses `window_minutes` — different unit).
- `reset_at` is unix seconds.
- **ChatGPT gained a 5-hour limit in 2026-08.** On 2026-07-26 the capture showed
  `primary_window` = weekly and `secondary_window: null`; by 2026-08-26 it had become
  `primary_window` = 5-hour (18000 s) and `secondary_window` = weekly (the sample above).
  **The slot contents have demonstrably swapped once already**, so which slot carries which
  is never assumed: the window is identified by `limit_window_seconds`, and the output
  `windows` are sorted by window length (5-hour → weekly, `sort_codex_windows()`).
- `/backend-api/wham/usage` returns the same response (an alias — switch to it if one disappears).
- 401/403 are `login_required`. **Whatever the failure, it falls back to the JSONL below**,
  because the last known values are still recorded there even when the token has expired.
  The API failure reason is preserved in `api_status` in the output.
- The order is **API → JSONL → previous values**. If the JSONL is readable it is used and
  `status` stays `ok` — real but stale data beats carrying the previous result forward.
  Carrying forward only happens when both the API and the JSONL fail.

`credits` had `has_credits: false` for a long time, but **`has_credits: true` was first
observed on 2026-08-26** (around when the 5-hour limit arrived). `balance` /
`approx_local_messages` / `approx_cloud_messages` were all still null and `unlimited` /
`overage_limit_reached` false, so **no meaningful value has been seen yet** — in this shape
the widget shows the fallback "credits available" line. The unit of `balance` is unknown,
so the candidate fields are still kept in the output as evidence. The
`rate_limit_reset_credits` block (`available_count` etc.) that appeared at the same time
looks like credits for resetting a window; it stays unused until its meaning is clear.

### Codex (fallback: rollout JSONL)

Each line of `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` is one event. Lines with
`payload.type == "token_count"` carry `rate_limits`:

```json
{"timestamp":"...","type":"event_msg","payload":{"type":"token_count","info":{...},
 "rate_limits":{"limit_id":"codex","primary":{"used_percent":15.0,
 "window_minutes":10080,"resets_at":1785618902},"secondary":null,
 "credits":{"has_credits":false,...},"plan_type":"team"}}}
```

- `resets_at` is **unix seconds** (Claude uses ISO strings).
- The window type is decided from `window_minutes` (`300` = 5-hour, `10080` = weekly).
  Until the 5-hour limit arrived in 2026-08, the team plan had `secondary: null` and only
  the weekly window. **Do not assume `primary` is the 5-hour window** (as on the API path,
  the output is re-sorted by window length).
- Some files are tens of MB, so only the last 3 MB is read, across the 12 newest files.
- **The openai/codex development source compresses rollouts older than 7 days to `.zst`**
  (by mtime, via a background job at startup; verified in the source on 2026-08-26). This
  script only reads plain `.jsonl`, so once that ships, **the fallback covers roughly the
  last week**. However, **on the author's machine (same day) rollouts from 2026-06 were
  still uncompressed** — the installed release apparently does not do this yet, so today's
  "no events" means "no recent turns", not compression. Values older than a week are
  barely worth showing anyway, so `.zst` is not decompressed.
- The line format, location and embedded `rate_limits` are unchanged in the current source
  (`sessions/YYYY/MM/DD/rollout-*.jsonl`, `token_count` events, `used_percent` /
  `window_minutes` / unix-seconds `resets_at`; checked the same day). Note the JSONL
  `credits.balance` is a **string** (`Option<String>`), so the number-only amount display
  falls back to the generic "credits available" line (never seen populated).

**The JSONL only updates when Codex is actually used.** `rate_limits` is recorded as part
of an API response, so merely having the app open adds nothing (observed: all 6 entries in
one session landed within about 100 seconds of an actual turn). `.codex-global-state.json`
does not carry usage numbers either. **So "open codex and run `/status`" does not fix
anything** — recover the API path instead.

Because of this the output carries `observed_at` / `observed_age_seconds`, and the widget
notes the age on medium / large sizes when every `status` is `ok` and the data is over an
hour old (a bad `status` takes display priority). Via the endpoint it is
`source: "api"` / `observed_age_seconds: 0`.

## Output format

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
    "windows": [
      {"key":"primary","label":"5時間","percent":8.0,"resets_at":"...","window_minutes":300},
      {"key":"secondary","label":"週次","percent":15.0,"resets_at":"...","window_minutes":10080}
    ]
  }
}
```

Codex `windows` are sorted by window length (short → long). `key` merely echoes the slot
name from the response — **which `key` carries which window is not guaranteed** (judge by
length).

`status` is one of `ok` / `empty` / `login_required` / `http_<code>` /
`error:<type>` / `parse_error:<type>`. `empty` means **the request succeeded but not a
single window could be read** — a sign that a key name changed.

**The side that failed keeps its previous `windows`, gains `stale: true` and
`last_attempt_at`, and has its status replaced (`fetched_at` is left alone).** One service
going down does not stop the other from updating. The exit code is "0 if both are `ok`,
otherwise 1" — **but only on a normal run that writes output.** `--stdout` and `--raw`
always return 0, since they are for inspection.

## Changing the output path

The output path is resolved in this order:

1. The `--public <path>` argument
2. The `AI_USAGE_PUBLIC_PATH` environment variable
3. `~/.ai-usage/public_path` (recorded by `install.sh`)
4. Default: `public/ai-usage.json` inside the repository (git-ignored)

Passing it at install time records it in 3, so **running the script by hand writes to the
same place**.

```bash
AI_USAGE_PUBLIC_PATH="$HOME/Dropbox/ai-usage/ai-usage.json" ./install.sh
```

Without this you get **two outputs**: launchd writes to the path you gave it, manual runs
write to `public/` in the repository. It is easy to keep pointing a share link at the stale
one without noticing.

## How the display language works

The widget reads `Device.language()` and draws in Japanese on Japanese devices, English
otherwise. All wording lives in `STRINGS` (`ja` / `en`); adding a language means adding an
entry there.

Window labels (`5時間` / `週次` / `Weekly (Fable)`) **deliberately ignore the `label` field
in the JSON from the Mac.** `windowLabel()` builds them in the device language from `key` /
`window_minutes` / `scope_model`. `label` is kept only as a compatibility shim for older
JSON (which still renders, with Japanese labels).

The Mac-side logs and `--raw` output stay in Japanese — only the operator sees them.

## Widget implementation decisions

### Layout

Claude and Codex are grouped separately, with a heading, a divider and a per-service colour
(Claude orange, Codex blue). Bars use the service colour normally, amber above 50% and red
above 80% — so the colour carries both identity and warning.

**The layout changes per size.** small and medium are only 158pt tall. medium cannot fit
all windows plus reset times vertically, so it uses its 338pt width for two columns. small
drops the reset times and shows bars only, fitting the four windows other than
`weekly_scoped` (Claude 2 + Codex 2) in one column.

**The four bars in small are confirmed to fit on the author's device (a large-screen
iPhone).** When Codex gained its second window in 2026-08, small briefly narrowed Codex to
its longest window (0.13.0), but that hid an approaching 5-hour limit, so 0.14.0 reverted
it. If it overflows on a smaller device, trim the spacing and fonts in `SIZE.small`.

Dimensions are centralised in `SIZE` (fonts, padding) and `contentWidthFor()` (bar width).
If more windows are added and it overflows, trim there. A bar cannot be filled
proportionally without an explicit width, so the real width is estimated from the screen
and clamped.

Credits can come from either Claude (`extra_usage`) or Codex (`credits`), so **the service
name and a coloured dot are always attached** — never show a credit line whose owner is
ambiguous. Since the Codex side has never been seen populated, it picks from whatever is
available: unlimited → messages left → balance → "credits available".

### iCloud pitfalls

**Only write to iCloud when the contents changed.** Rewriting unconditionally every 30
minutes means a new version arrives before the previous one finishes propagating, and
devices never catch up (observed: the iPhone received a two-hour-old version).
`content_signature()` compares a fingerprint with timestamps removed and writes only on
change. Even unchanged, it writes once every `ICLOUD_FORCE_WRITE_SECONDS` (2 hours) so the
Mac being alive is still visible. The log field `icloud=changed/periodic/skipped` shows
which happened. The widget's `STALE_AFTER_MINUTES` (150) is aligned to that 2 hours.

**Never replace the iCloud file with `os.replace()`.** A changed inode looks like "delete +
create" to iCloud, which invalidates the device-local copy every 30 minutes. The widget
then waits on a download every time it reads, misses, and falls back to the cache (this
really did stop syncing). `write_in_place()` overwrites the same inode. The local
`last.json` is still updated atomically every run — that one is the source of truth.

**The widget extension does not retry iCloud.** It cannot trigger a download, so retrying
only burns execution time. Only Shortcuts and in-app runs wait.

**Take the candidate with the largest `generated_at`.** iCloud can hand back an older copy,
and "use whatever loaded first" would roll the cache backwards. The cache is updated only
when strictly newer (rewriting it with the same generation would freshen `cached_at` alone
and misreport the age).

**`JSON.parse(null)` returns `null` instead of throwing.** When iCloud has evicted the
file, `readString()` returns `null`; passing that through makes the drawing code touch
`null` and crash (this happened). Loads are accepted as "null unless it is an object", and
fall back to the on-device cache (`ai-usage-cache.json`, local rather than iCloud). The
entry point also has a `try/catch` so failures show text instead of a red error screen.

**`refreshAfterDate` is set 30 minutes out.** It is not binding, but it narrows the window
where the cache is fresh and the display is not.

For share links, `dl=0` is rewritten to `dl=1` and a varying query parameter is appended so
a stale CDN copy is not picked up. Timeout is 3 seconds with no retry, since widget
execution time is short.

## Periodic refresh on iPhone (an iCloud-only fallback)

> **Not needed** once a share link is registered — this is for setups that can only use
> iCloud. If you already configured it, leaving it in place is harmless (it just refreshes
> the cache).

**A widget extension cannot trigger an on-demand iCloud download.** If the file is not on
the device it cannot be read, and the cache is shown instead (observed: unreadable for 4
hours). **A Shortcuts extension can read it**, so let Shortcuts refresh the cache.

`AIUsage.js` behaves differently depending on how it is invoked:

| Invoked from | Behaviour |
|---|---|
| Shortcuts / Siri | No UI; reads iCloud and only updates the on-device cache |
| Widget | Draws from the cache (or iCloud) |
| Scriptable app | Shows a preview (disable with `PREVIEW_IN_APP`) |

Shortcuts app → Automation → Time of Day → turn off "Run Immediately" and "Notify When
Run" → a single **`Run Script`** action.

- Script: `AIUsage`
- Parameter: **leave empty** (only pass `setup` when you want to change the link)
- **Run In App: OFF** (ON brings the app to the foreground)
- Show When Run: OFF

**Do not add `Refresh All Widgets`.** It launches Scriptable and brings the app forward.
Without it, iOS still picks up the newest cache the next time it redraws the widget.

To refresh more often, create the same automation at several times of day.
The red line at the bottom of the widget (`cache · N min ago`) tells you the cache is in use.

## Reference

- Claude Code statusline `rate_limits` spec (official): https://code.claude.com/docs/en/statusline
