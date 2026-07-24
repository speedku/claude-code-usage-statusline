# Claude Code — Usage Statusline

A fast, CloudPilot-style status line for [Claude Code](https://claude.com/claude-code) that shows your model, context window usage, your **5-hour** and **7-day** rate-limit utilization (with reset countdowns and color-coded warnings), plus the working directory, git branch and session time.

```
Opus 4 ⚡xhigh | ████░░ 32% | 5h: 3% ↻ 3h | 7d: 13% ↻ 4d | ~/code/app ⎇ main * ⏱ 12m
```

- **Model** + configured effort level (`⚡xhigh`/`high`/`medium`/`low`)
- **Context window** used (bar + %), green → yellow → red as it fills
- **5h** and **7d** usage utilization with `↻` countdown to reset
- Colors warn when you're burning quota faster than time elapsed
- **Working directory** (cyan) so you always know where the session is rooted
- **Git branch** (`⎇`) with a `*` when there are uncommitted tracked changes
- **Session time** (`⏱`) elapsed so far, when Claude Code reports it

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

## Requirements

- [Claude Code](https://claude.com/claude-code) (logged in)
- Node.js 18+ (already required by Claude Code)

## Troubleshooting

| You see | Fix |
|---------|-----|
| `| run: claude logout && claude login` | No usage cache yet / not authenticated. Log in, wait one refresh cycle. |
| `(stale …)` marker | Background refresh hasn't succeeded recently. Check `claude-statusline-refresh.log` in your temp dir. |
| Only model + context, no 5h/7d | Cache empty on first run — give it a few seconds, render again. |

Cache lives at `<tmp>/claude-usage-cache.json`; refresh debug log at `<tmp>/claude-statusline-refresh.log`.

## Notes

- The status line re-reads `effortLevel` from `settings.json` on each render, so it tracks your effort changes live.
- Usage data comes from Claude Code's own OAuth usage endpoint — same numbers Claude Code uses internally.
- The git **branch** is read straight from `.git/HEAD` (instant, no subprocess). The `*` dirty marker runs `git status --porcelain -uno` (tracked files only) with a hard 800 ms timeout, so even a huge repo can never stall a render — if it times out or git is missing, the branch still shows without the marker.
- **Session time** is taken from `cost.total_duration_ms` in the status line payload; it only appears on Claude Code versions that provide it.
- Inspired by the "CloudPilot" status line style.

## License

MIT — see [LICENSE](LICENSE).
