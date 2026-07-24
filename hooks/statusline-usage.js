#!/usr/bin/env node
// CloudPilot-style: "Opus 4 | ████░░ 32% | 5h: 3% ↻ 3h | 7d: 13% ↻ 4d | <cwd> ⎇ branch"
// FAST: Always outputs immediately from cache. Refreshes cache in background.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const CACHE_FILE = path.join(os.tmpdir(), 'claude-usage-cache.json');
const LOCK_FILE = CACHE_FILE + '.lock';
const CACHE_TTL = 120; // seconds before background refresh
const RATE_LIMIT_COOLDOWN = 300; // 5 min cooldown after rate limit

const RESET = '\x1b[0m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';
const DIM = '\x1b[2m', BOLD = '\x1b[1m', ORANGE = '\x1b[38;5;208m';
const CYAN = '\x1b[36m', MAGENTA = '\x1b[35m';

function minsUntil(ts) { return ts ? Math.max(0, Math.floor((new Date(ts).getTime() - Date.now()) / 60000)) : 0; }
function fmtTime(m) {
  if (m <= 0) return 'now';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mn = m % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mn > 0 ? `${h}h ${mn}m` : `${h}h`;
  return `${mn}m`;
}
// Compact duration from milliseconds: "34s" / "5m" / "1h 2m"
function fmtDur(ms) {
  if (typeof ms !== 'number' || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
function bar(pct, w) {
  const f = Math.round(Math.min(100, Math.max(0, pct)) / 100 * w);
  return '█'.repeat(f) + '░'.repeat(w - f);
}
function rateClr(pct, rem, total) {
  const elapsed = Math.max(0, total - rem);
  const diff = pct - (total > 0 ? Math.floor(elapsed * 100 / total) : 0);
  if (diff <= 0) return GREEN;
  if (diff <= 5) return YELLOW;
  if (diff <= 15) return ORANGE;
  return RED;
}
function modelName(id, name) {
  if (!id) return name || 'Claude';
  const i = id.toLowerCase();
  if (i.includes('opus-4')) return 'Opus 4';
  if (i.includes('opus')) return 'Opus';
  if (i.includes('sonnet-4')) return 'Sonnet 4';
  if (i.includes('sonnet')) return 'Sonnet';
  if (i.includes('haiku')) return 'Haiku';
  return (name || 'Claude').replace(/^Claude\s+/i, '');
}

// Read configured effort level from settings.json (re-read each render so it
// tracks setting changes). Returns 'high' | 'medium' | 'low' | null.
function readEffort() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const e = s.effortLevel;
    return (typeof e === 'string' && e.trim()) ? e.trim() : null;
  } catch { return null; }
}

// Git branch (instant, read straight from .git/HEAD) plus a dirty flag.
// Branch never blocks; the dirty check is a short, guarded git call that is
// skipped on timeout or when git is unavailable, so the hot path stays fast.
function gitInfo(startDir) {
  if (!startDir) return null;
  try {
    // Walk up from cwd to locate the repo's .git (dir for a normal repo,
    // file for a worktree/submodule pointing elsewhere via "gitdir: ...").
    let dir = startDir, gitPath = null;
    for (let i = 0; i < 40; i++) {
      const p = path.join(dir, '.git');
      if (fs.existsSync(p)) { gitPath = p; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!gitPath) return null;

    let gitDir = gitPath;
    if (fs.statSync(gitPath).isFile()) {
      const m = fs.readFileSync(gitPath, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
      if (m) gitDir = path.resolve(dir, m[1]);
    }

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    const branch = ref ? ref[1] : head.slice(0, 7); // detached HEAD -> short sha

    // Dirty check: tracked files only (-uno skips the slow untracked scan),
    // hard timeout so a huge repo can never stall the statusline render.
    let dirty = false;
    try {
      const out = execSync('git status --porcelain -uno', {
        cwd: dir, timeout: 800, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
      });
      dirty = out.trim().length > 0;
    } catch { /* timeout / git missing: show branch without dirty marker */ }

    return { branch, dirty };
  } catch { return null; }
}

// Read cache synchronously - NEVER blocks
function readCache() {
  try {
    const stat = fs.statSync(CACHE_FILE);
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const age = (Date.now() - stat.mtimeMs) / 1000;
    return { data, stale: age > CACHE_TTL, age };
  } catch { return { data: null, stale: true, age: Infinity }; }
}

// Check if we're in rate limit cooldown
function isRateLimited() {
  try {
    const lockTime = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    return (Date.now() - lockTime) < (RATE_LIMIT_COOLDOWN * 1000);
  } catch { return false; }
}

// Spawn detached background process to refresh cache (fire-and-forget)
function refreshCacheInBackground() {
  if (isRateLimited()) return; // Don't hammer API during cooldown
  const refreshScript = path.join(__dirname, 'statusline-refresh.js');
  if (!fs.existsSync(refreshScript)) return;
  const child = spawn('node', [refreshScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

// --- MAIN: Read stdin, output IMMEDIATELY, refresh in background if stale ---
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(input || '{}');
    const model = modelName(d.model?.id, d.model?.display_name);
    const pct = Math.round(d.context_window?.used_percentage || 0);
    const ctxClr = pct >= 80 ? RED : pct >= 50 ? YELLOW : GREEN;

    // Effort level: prefer a live field from stdin if Claude Code ever provides
    // one, otherwise fall back to the configured value in settings.json.
    const effort = d.effortLevel || d.effort || d.model?.effort || readEffort();
    const effClr = effort === 'xhigh' ? RED : effort === 'high' ? ORANGE : effort === 'medium' ? YELLOW : effort === 'low' ? GREEN : DIM;
    const effTag = effort ? ` ${effClr}⚡${effort}${RESET}` : '';

    let line = `${BOLD}${model}${RESET}${effTag} | ${ctxClr}${bar(pct, 6)} ${pct}%${RESET}`;

    // Read cached usage data (instant, no HTTP)
    const { data: usage, stale, age } = readCache();

    if (usage && !usage.error) {
      const isVeryStale = age > 3600; // >1 hour old
      const staleMarker = isVeryStale ? `${DIM}?${RESET}` : '';

      const fh = usage.five_hour;
      if (fh?.utilization != null) {
        const p = Math.round(fh.utilization), rem = minsUntil(fh.resets_at);
        line += ` | ${rateClr(p, rem, 300)}5h: ${p}%${RESET} ${DIM}↻ ${fmtTime(rem)}${RESET}${staleMarker}`;
      }
      const sd = usage.seven_day;
      if (sd?.utilization != null) {
        const p = Math.round(sd.utilization), rem = minsUntil(sd.resets_at);
        line += ` | ${rateClr(p, rem, 10080)}7d: ${p}%${RESET} ${DIM}↻ ${fmtTime(rem)}${RESET}${staleMarker}`;
      }

      // Show warning if data is very stale
      if (isVeryStale) {
        line += ` ${DIM}(stale ${fmtTime(Math.floor(age / 60))})${RESET}`;
      }
    } else {
      // No cache at all - show hint
      line += ` ${DIM}| run: claude logout && claude login${RESET}`;
    }

    // Working directory + git branch/dirty state (the "where we're working" part)
    const cwd = d.workspace?.current_dir || d.cwd;
    if (cwd) line += ` | ${CYAN}${cwd}${RESET}`;
    const git = gitInfo(cwd);
    if (git) line += ` ${MAGENTA}⎇ ${git.branch}${RESET}${git.dirty ? ` ${YELLOW}*${RESET}` : ''}`;

    // Session working time so far (only if Claude Code provides cost data).
    const dur = fmtDur(d.cost?.total_duration_ms);
    if (dur) line += ` ${DIM}⏱ ${dur}${RESET}`;

    console.log(line);

    // If cache is stale, refresh in background for next run
    if (stale) refreshCacheInBackground();

  } catch { console.log('Claude'); }
});
