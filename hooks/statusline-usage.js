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

// Last genuine user prompt from the session transcript (JSONL), shown on a
// second status row so you can see at a glance what the session was asked to
// do. Skips tool-result turns, meta/sidechain entries, and strips image
// markers, system-reminders and any XML-ish wrappers so only the user's words
// remain. Reads only the tail of very large transcripts to stay fast.
function lastUserPrompt(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    const stat = fs.statSync(transcriptPath);
    const TAIL = 2 * 1024 * 1024; // 2 MB is plenty to hold the latest user turn
    if (stat.size > 8 * 1024 * 1024) {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(TAIL);
      const n = fs.readSync(fd, buf, 0, TAIL, stat.size - TAIL);
      fs.closeSync(fd);
      text = buf.toString('utf8', 0, n);
    } else {
      text = fs.readFileSync(transcriptPath, 'utf8');
    }
  } catch { return null; }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln || ln[0] !== '{') continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    if (o.type !== 'user' || o.isMeta || o.isSidechain) continue;

    const c = o.message?.content;
    let s = '';
    if (typeof c === 'string') s = c;
    else if (Array.isArray(c)) {
      // A user turn with no text block is a tool_result carrier, not a prompt.
      const parts = c.filter(p => p && p.type === 'text' && typeof p.text === 'string');
      if (!parts.length) continue;
      s = parts.map(p => p.text).join(' ');
    } else continue;

    s = s
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/\[Image #\d+\]/g, ' ')
      .replace(/\[Image: source:[^\]]*\]/g, ' ')
      .replace(/<[^>]+>/g, ' ')   // drop remaining tags, keep their inner text
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) continue;

    const MAX = 120;
    return s.length > MAX ? s.slice(0, MAX - 1).trimEnd() + '…' : s;
  }
  return null;
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

// --- Account rotation row (claude-swap / cswap) ---
// Every account registered with `cswap add`, with its 5h/7d usage, read from
// cswap's own cache so the render never calls the API. cswap owns the polling
// budget of /api/oauth/usage; we only nudge it with a detached `cswap list`.
const CSWAP_DIR = process.env.STATUSLINE_CSWAP_DIR || path.join(os.homedir(), '.claude-swap-backup');
const CSWAP_EXE = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'cswap.exe' : 'cswap');
const CSWAP_STAMP = path.join(os.tmpdir(), 'claude-cswap-refresh.stamp');
const CSWAP_REFRESH_S = 240; // cswap itself serves entries younger than 180 s from cache

// Plan kont (Max 20x / Max 5x / Pro), plik zapisuje synchronizacja kont co 5 min.
// Wielkosc limitu wzgledem Max 5x: 20x = 4, 5x = 1, Pro = 0,2; brak danych = 1.
const PLANS_FILE = path.join(os.homedir(), '.claude-konta-plany.json');
function planWeight(plan) {
  const p = String(plan || '').toLowerCase();
  if (p.includes('20x')) return 4;
  if (p.includes('5x')) return 1;
  if (p.includes('pro')) return 0.2;
  return 1;
}

function pctClr(p) { return p >= 90 ? RED : p >= 70 ? YELLOW : GREEN; }

// A window whose reset time already passed is empty, whatever the cache says.
function windowPct(w) {
  if (!w || w.pct == null) return null;
  if (w.resets_at && new Date(w.resets_at).getTime() <= Date.now()) return 0;
  return Math.round(w.pct);
}

function refreshCswapInBackground() {
  try {
    const last = parseInt(fs.readFileSync(CSWAP_STAMP, 'utf8'), 10);
    if (Date.now() - last < CSWAP_REFRESH_S * 1000) return;
  } catch {}
  if (!fs.existsSync(CSWAP_EXE)) return;
  try { fs.writeFileSync(CSWAP_STAMP, String(Date.now())); } catch {}
  try {
    const child = spawn(CSWAP_EXE, ['list', '--json'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}

// Returns the row string, or null when fewer than two accounts are registered.
function accountsRow(activeEmail, live, modelId) {
  let seq, cache;
  try { seq = JSON.parse(fs.readFileSync(path.join(CSWAP_DIR, 'sequence.json'), 'utf8')); } catch { return null; }
  try { cache = JSON.parse(fs.readFileSync(path.join(CSWAP_DIR, 'cache', 'usage.json'), 'utf8')).accounts || {}; } catch { cache = {}; }
  const nums = (seq.sequence || []).map(String).filter(n => seq.accounts && seq.accounts[n]);
  if (nums.length < 2) return null;

  let plans = {};
  try { plans = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8')); } catch {}
  const planOf = e => { for (const k of Object.keys(plans)) if (k.toLowerCase() === String(e).toLowerCase()) return plans[k].plan; return null; };
  const model = (modelId || '').toLowerCase();
  const now = Date.now();
  let oldest = 0;
  const rows = nums.map(n => {
    const email = seq.accounts[n].email || '?';
    const active = !!activeEmail && email.toLowerCase() === activeEmail.toLowerCase();
    const c = cache[n] || {};
    const g = c.lastGood || {};
    let h5 = windowPct(g.five_hour), d7 = windowPct(g.seven_day);
    let d7Reset = g.seven_day && g.seven_day.resets_at;
    // The live payload is fresher than any cache for the logged-in account.
    if (active && live) {
      if (live.h5 != null) h5 = live.h5;
      if (live.d7 != null) { d7 = live.d7; d7Reset = live.d7Reset || d7Reset; }
    }
    // Per-model weekly cap (e.g. "Fable 100%") blocks the account for that model.
    let scoped = null;
    for (const s of g.scoped || []) {
      const p = windowPct(s);
      if (p != null && (!scoped || p > scoped.pct)) scoped = { name: s.name || '?', pct: p };
    }
    const scopedHits = scoped && model && model.includes(String(scoped.name).toLowerCase());
    const eff7 = Math.max(d7 ?? 0, scopedHits ? scoped.pct : 0);
    if (!active && c.fetchedAt) oldest = Math.max(oldest, now / 1000 - c.fetchedAt);
    if (!active && !c.fetchedAt) oldest = Infinity;
    const plan = planOf(email);
    return { n, email, active, h5, d7, eff7, d7Reset, scoped, plan, w: planWeight(plan) };
  });

  // Balancing: the account whose weekly quota would otherwise go to waste soonest
  // wins, i.e. the most headroom per hour left until its 7d reset, scaled by plan
  // size (Max 20x holds 4x the quota of Max 5x). An account
  // with its 5h window nearly full is skipped (it would stall within minutes).
  let best = null;
  for (const r of rows) {
    if (r.d7 == null || (r.h5 ?? 0) >= 90 || r.eff7 >= 98) continue;
    const hrs = r.d7Reset ? Math.max(1, (new Date(r.d7Reset).getTime() - now) / 3600000) : 168;
    const score = (100 - r.eff7) * r.w / hrs;
    if (!best || score > best.score) best = { ...r, score };
  }

  const parts = rows.map(r => {
    const name = r.email.split('@')[0];
    const pl = r.plan && r.w < 4 ? ` ${DIM}(${r.plan.replace(/^Max\s*/i, '')})${RESET}` : '';
    const tag = (r.active ? `${BOLD}● ${name}${RESET}` : `${DIM}○${RESET} ${name}`) + pl;
    const v5 = r.h5 == null ? `${DIM}5h ?${RESET}` : `${pctClr(r.h5)}5h ${r.h5}%${RESET}`;
    const v7 = r.d7 == null ? `${DIM}7d ?${RESET}` : `${pctClr(r.d7)}7d ${r.d7}%${RESET}`;
    const sc = r.scoped && r.scoped.pct >= 80 ? ` ${pctClr(r.scoped.pct)}${r.scoped.name} ${r.scoped.pct}%${RESET}` : '';
    return `${tag} ${v5} ${v7}${sc}`;
  });

  let row = `${DIM}⇄${RESET} ` + parts.join(` ${DIM}·${RESET} `);
  if (best && !best.active) row += ` ${CYAN}→ cswap switch ${best.n}${RESET}`;
  if (oldest > 1800) row += ` ${DIM}(dane ${oldest === Infinity ? 'brak' : fmtTime(Math.floor(oldest / 60))})${RESET}`;
  return row;
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

    // Effort level: Claude Code sends it as {level: "..."} (2.1.x); older paths
    // may send a bare string. Fall back to the configured value in settings.json.
    const effRaw = d.effort;
    const effort = (effRaw && typeof effRaw === 'object' ? effRaw.level : effRaw)
      || d.effortLevel || d.model?.effort || readEffort();
    const effClr = effort === 'xhigh' ? RED : effort === 'high' ? ORANGE : effort === 'medium' ? YELLOW : effort === 'low' ? GREEN : DIM;
    const effTag = effort ? ` ${effClr}⚡${effort}${RESET}` : '';

    let line = `${BOLD}${model}${RESET}${effTag} | ${ctxClr}${bar(pct, 6)} ${pct}%${RESET}`;

    // Read cached usage data (instant, no HTTP)
    // Prefer live rate_limits from the payload: always the currently logged-in
    // account, so switching accounts shows correct numbers immediately.
    let { data: usage, stale, age } = readCache();
    const rl = d.rate_limits;
    if (rl && (rl.five_hour || rl.seven_day)) {
      const conv = w => w && w.used_percentage != null
        ? { utilization: w.used_percentage, resets_at: new Date(w.resets_at * 1000).toISOString() } : null;
      usage = { five_hour: conv(rl.five_hour), seven_day: conv(rl.seven_day) };
      stale = false; age = 0;
    }

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

    // Logged-in account (switching accounts rewrites ~/.claude.json). A session
    // started with CLAUDE_CONFIG_DIR (e.g. `cswap run N`) keeps its login there.
    let activeEmail = null;
    try {
      const cfgBase = process.env.CLAUDE_CONFIG_DIR || os.homedir();
      const acc = JSON.parse(fs.readFileSync(path.join(cfgBase, '.claude.json'), 'utf8')).oauthAccount;
      if (acc && acc.emailAddress) { activeEmail = acc.emailAddress; line += ` | ${DIM}👤${RESET} ${acc.emailAddress}`; }
    } catch {}

    // Working directory + git branch/dirty state (the "where we're working" part)
    const cwd = d.workspace?.current_dir || d.cwd;
    if (cwd) line += ` | ${CYAN}${cwd}${RESET}`;
    const git = gitInfo(cwd);
    if (git) line += ` ${MAGENTA}⎇ ${git.branch}${RESET}${git.dirty ? ` ${YELLOW}*${RESET}` : ''}`;

    console.log(line);

    // Rotation row: all cswap accounts side by side.
    try {
      const live = rl ? {
        h5: rl.five_hour?.used_percentage != null ? Math.round(rl.five_hour.used_percentage) : null,
        d7: rl.seven_day?.used_percentage != null ? Math.round(rl.seven_day.used_percentage) : null,
        d7Reset: rl.seven_day?.resets_at ? new Date(rl.seven_day.resets_at * 1000).toISOString() : null
      } : null;
      const accRow = accountsRow(activeEmail, live, d.model?.id);
      if (accRow) { console.log(accRow); refreshCswapInBackground(); }
    } catch {}

    // Second row: the last thing this session was asked to do.
    const prompt = lastUserPrompt(d.transcript_path);
    if (prompt) console.log(`${DIM}↳ ${prompt}${RESET}`);

    // If cache is stale, refresh in background for next run
    if (stale) refreshCacheInBackground();

  } catch { console.log('Claude'); }
});
