# Claude Code — Usage Statusline

> **Instalacja przez Claude Code (Windows, kilka kont):** wklej Claude polecenie
> `Przeczytaj https://raw.githubusercontent.com/speedku/claude-code-usage-statusline/master/SETUP-CLAUDE.md i wykonaj instrukcję krok po kroku na tym komputerze.`

A fast, CloudPilot-style status line for [Claude Code](https://claude.com/claude-code) that shows your model, context window usage, your **5-hour** and **7-day** rate-limit utilization (with reset countdowns and color-coded warnings), the working directory and git branch, plus a second row with the **last prompt** of the session.

```
Opus 4 ⚡xhigh | ████░░ 32% | 5h: 3% ↻ 3h | 7d: 13% ↻ 4d | ~/code/app ⎇ main *
↳ refactor the auth middleware to use the new token cache
```

- **Model** + effort level (`⚡xhigh`/`high`/`medium`/`low`)
- **Context window** used (bar + %), green → yellow → red as it fills
- **5h** and **7d** usage utilization with `↻` countdown to reset
- Colors warn when you're burning quota faster than time elapsed
- **Working directory** (cyan) so you always know where the session is rooted
- **Git branch** (`⎇`) with a `*` when there are uncommitted tracked changes
- **Last prompt** (`↳`, second row) — the most recent thing you asked the session to do, so you can tell at a glance what a window is working on

## How it works

Two small Node scripts, zero dependencies (Node built-ins only):

| File | Role |
|------|------|
| `statusline-usage.js` | Runs on every status line render. Reads a cached usage file and prints **instantly** — never blocks on the network. |
| `statusline-refresh.js` | Spawned detached in the background when the cache is stale. Calls the Claude usage API and updates the cache for the next render. |

The refresh script reads your **local** Claude Code OAuth token from `~/.claude/.credentials.json` (or `~/.claude-profiles/default/.credentials.json`) at runtime and auto-refreshes it when expired. No token or secret is stored in the code — it only works on a machine where you're already logged into Claude Code.

## Install

1. Copy both scripts into your Claude Code hooks directory:

   ```
   ~/.claude/hooks/statusline-usage.js
   ~/.claude/hooks/statusline-refresh.js
   ```

   (On Windows that's `C:\Users\<you>\.claude\hooks\`.)

   Both files **must live in the same folder** — `statusline-usage.js` spawns `statusline-refresh.js` from its own directory.

2. Point Claude Code at the script. Add this to `~/.claude/settings.json`:

   **macOS / Linux:**
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"$HOME/.claude/hooks/statusline-usage.js\""
     }
   }
   ```

   **Windows:**
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"C:\\Users\\<you>\\.claude\\hooks\\statusline-usage.js\""
     }
   }
   ```

3. Make sure you're logged in (`claude` → it uses your existing session). Restart Claude Code. The first render shows the model + context immediately; usage numbers appear a couple seconds later once the background refresh populates the cache.

## Multiple accounts (optional, via claude-swap)

If you rotate several Claude subscriptions, this repo works together with [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`): the status line shows every account's limits, and two small Windows tools in `tools/` start Claude on the right account and add accounts safely.

### The one rule: never `/login` or `/logout` in your normal Claude window

`/login` re-logs the whole profile and invalidates the account you are leaving, so the copy claude-swap keeps of it dies ("re-login needed"). `/logout` revokes the token outright. Measured the hard way: two of four accounts died while adding them one after another with `/login`. Each account needs its own profile, chosen when a session starts, never switched inside it.

### Setup

```bash
uv tool install claude-swap     # or: pipx install claude-swap
```

Copy `tools/claude-best.ps1`, `tools/claude-best.cmd` and `tools/claude-add-account.cmd` to a folder on your PATH (e.g. `~/.local/bin`, where uv puts `cswap`).

Register each account **in a separate terminal** with the next free slot number:

```bat
claude-add-account.cmd 1
claude-add-account.cmd 2
```

It opens Claude in an empty temporary profile (`CLAUDE_CONFIG_DIR`), you log in there and type `/exit`, then it runs `cswap add --slot N` and deletes the temporary folder. Nothing else gets logged out. Use the same command to repair an account that shows "re-login needed".

### Daily use

| Command | What it does |
|---|---|
| `claude-best` | Starts Claude on the account with the most headroom, in this terminal only (`cswap run N`). Other terminals keep their accounts. |
| `claude-best -n` | Only prints the account table and the choice. |
| `claude-best --resume` | Extra arguments are passed on to `claude`. |
| `claude-best --model fable` | Also skips accounts whose limit for that model is used up. |
| `cswap run 2` | Claude on a specific account, in this terminal only. |
| `cswap list` | All accounts with 5h / 7d / per-model limits. |

To change account, `/exit` and start again with `claude-best` or `cswap run N`. `cswap switch N` also works, but it changes the account for every open terminal at once.

**How `claude-best` picks:** remaining weekly (7d) percentage divided by hours until that weekly reset. The account whose quota would go to waste soonest wins. Skipped: 5h window at 90%+, 7d at 98%+, accounts needing re-login, and (with `--model X`) accounts with that model's cap at 98%+.

### The status line row

With two or more accounts registered, the status line gets an extra row:

```
⇄ ● work 5h 14% 7d 89% Fable 100% · ○ personal 5h 40% 7d 55% · ○ team 5h 95% 7d 20% · ○ spare 5h 0% 7d 70% → cswap switch 4
```

- `●` is the account of this session (live numbers from the payload; sessions started with `cswap run` are recognised through `CLAUDE_CONFIG_DIR`), `○` the others (from cswap's cache in `~/.claude-swap-backup/cache/usage.json`).
- A per-model weekly cap (e.g. `Fable 100%`) is shown when it reaches 80%.
- `→ cswap switch N` suggests an account using the same rule as `claude-best`.
- The status line never calls the usage API for other accounts itself. At most every 4 minutes it launches a detached `cswap list --json`, and cswap keeps to the usage endpoint's budget (about 30 requests per hour per account).
- `(dane …)` marks cswap data older than 30 minutes.

## Requirements

- [Claude Code](https://claude.com/claude-code) (logged in)
- Node.js 18+ (already required by Claude Code)

## Troubleshooting

| You see | Fix |
|---------|-----|
| `| limity po pierwszej odpowiedzi` | No usage data yet: 5h/7d arrive with the first API response of the session. Send one message and wait for the next render. |
| `(stale …)` marker | Background refresh hasn't succeeded recently. Check `claude-statusline-refresh.log` in your temp dir. |
| Only model + context, no 5h/7d | Cache empty on first run — give it a few seconds, render again. |

Cache lives at `<tmp>/claude-usage-cache.json`; refresh debug log at `<tmp>/claude-statusline-refresh.log`.

## Notes

- The effort level comes from the payload's `effort.level` when present, falling back to `effortLevel` in `settings.json` (re-read each render, so it tracks changes live).
- Usage data comes from Claude Code's own OAuth usage endpoint — same numbers Claude Code uses internally.
- The git **branch** is read straight from `.git/HEAD` (instant, no subprocess). The `*` dirty marker runs `git status --porcelain -uno` (tracked files only) with a hard 800 ms timeout, so even a huge repo can never stall a render — if it times out or git is missing, the branch still shows without the marker.
- The **last prompt** row reads `transcript_path` from the status line payload and scans the transcript JSONL from the end for the most recent genuine user turn. It skips tool-result turns and meta/sidechain entries, strips image markers, `<system-reminder>` blocks and any XML-ish wrappers, then truncates to 120 chars. Very large transcripts are read tail-only (last 2 MB) so the render stays fast. The row is omitted entirely when there's no prompt yet.
- Inspired by the "CloudPilot" status line style.

## License

MIT — see [LICENSE](LICENSE).
