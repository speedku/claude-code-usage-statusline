#!/usr/bin/env node
// Background cache refresher for statusline. Spawned detached, runs once, exits.
// Reads OAuth token from credentials, calls usage API, writes cache.
// If token is expired, attempts refresh via Claude Code's OAuth flow.
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');

const CACHE_FILE = path.join(os.tmpdir(), 'claude-usage-cache.json');
const CREDS_FILE = (() => {
  const profilePath = path.join(os.homedir(), '.claude-profiles', 'default', '.credentials.json');
  const legacyPath = path.join(os.homedir(), '.claude', '.credentials.json');
  // Pick the most recently modified credentials file
  let profileMtime = 0, legacyMtime = 0;
  try { profileMtime = fs.statSync(profilePath).mtimeMs; } catch {}
  try { legacyMtime = fs.statSync(legacyPath).mtimeMs; } catch {}
  if (profileMtime === 0 && legacyMtime === 0) return legacyPath;
  return legacyMtime >= profileMtime ? legacyPath : profilePath;
})();
const LOG_FILE = path.join(os.tmpdir(), 'claude-statusline-refresh.log');

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
    // Keep log file small
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 50000) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, content.slice(-20000));
    }
  } catch {}
}

function httpReq(url, opts, body) {
  return new Promise(resolve => {
    const req = https.request(url, { ...opts, timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: null, raw: d }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

function getTokenFromClaude() {
  // Try to get a fresh token by running `claude auth status` which may trigger refresh
  try {
    const result = execSync('claude auth status --json 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const parsed = JSON.parse(result);
    if (parsed.loggedIn) {
      // Re-read credentials file - Claude may have refreshed the token
      const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).claudeAiOauth;
      return creds?.accessToken || null;
    }
  } catch {}
  return null;
}

async function main() {
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).claudeAiOauth;
  } catch (e) {
    log('Cannot read credentials: ' + e.message);
    process.exit(0);
  }
  if (!creds?.accessToken) {
    log('No access token found');
    process.exit(0);
  }

  let token = creds.accessToken;

  // Try usage API with current token
  let usage = await httpReq('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
  });

  log(`Usage API: status=${usage.status}`);

  // Rate limited - keep old cache, don't attempt refresh
  if (usage.status === 429) {
    log('Rate limited - keeping existing cache');
    try { fs.writeFileSync(CACHE_FILE + '.lock', Date.now().toString()); } catch {}
    process.exit(0);
  }

  // If token expired, try refresh
  if (usage.status === 401 || usage.status === 403) {
    log('Token may be expired, attempting refresh...');

    // Method 1: Use refresh_token with known endpoints
    if (creds.refreshToken) {
      // Try multiple known OAuth token endpoints
      const endpoints = [
        'https://console.anthropic.com/v1/oauth/token',
        'https://auth.anthropic.com/oauth/token',
      ];

      for (const endpoint of endpoints) {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
        }).toString();

        const r = await httpReq(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
        }, body);

        log(`Refresh via ${endpoint}: status=${r.status}`);

        if (r.data?.access_token) {
          token = r.data.access_token;
          try {
            const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
            c.claudeAiOauth.accessToken = r.data.access_token;
            if (r.data.expires_in) c.claudeAiOauth.expiresAt = new Date(Date.now() + r.data.expires_in * 1000).toISOString();
            if (r.data.refresh_token) c.claudeAiOauth.refreshToken = r.data.refresh_token;
            fs.writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2));
            log('Token refreshed and saved');
          } catch (e) { log('Failed to save token: ' + e.message); }

          // Retry usage with new token
          usage = await httpReq('https://api.anthropic.com/api/oauth/usage', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
          });
          log(`Usage after refresh: status=${usage.status}`);
          break;
        }
      }
    }

    // Method 2: Try triggering Claude CLI to refresh
    if (!usage.data?.five_hour) {
      log('Refresh token failed, trying claude auth...');
      const freshToken = getTokenFromClaude();
      if (freshToken && freshToken !== creds.accessToken) {
        log('Got fresh token from claude CLI');
        usage = await httpReq('https://api.anthropic.com/api/oauth/usage', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${freshToken}`, 'anthropic-beta': 'oauth-2025-04-20' }
        });
        log(`Usage after CLI refresh: status=${usage.status}`);
      }
    }
  }

  // Save successful response
  if (usage.status === 200 && usage.data && !usage.data.error) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(usage.data));
    log('Cache updated successfully');
  } else {
    log('Failed to get usage data: ' + JSON.stringify(usage));
    // Write error marker to cache so statusline knows
    const existing = readExistingCache();
    if (existing) {
      existing._stale = true;
      existing._lastError = usage.status || 'unknown';
      existing._lastAttempt = new Date().toISOString();
      fs.writeFileSync(CACHE_FILE, JSON.stringify(existing));
    }
  }
}

function readExistingCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch { return null; }
}

main().catch((e) => { log('Fatal: ' + e.message); }).finally(() => process.exit(0));
