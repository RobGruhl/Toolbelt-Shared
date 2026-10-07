import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'fs';
import { incrementCounter } from './lib/telemetry.js';
import {
  LOG_PREFIX,
  AUTH_FILE,
  PROFILE_DIR,
  getWorkspaceUrl,
  getApiBase,
  getConfiguredEnterpriseId,
} from './lib/config.js';

// Edge API: an undocumented Slack service the web client uses for user and
// channel search. It is keyed by the org id (E…) on Enterprise Grid and by the
// team id (T…) otherwise; the id is captured from auth.test at login and can be
// pinned with SLACK_ENTERPRISE_ID.
const EDGE_API_HOST = 'https://edgeapi.slack.com/cache/';

// Timeouts and retry configuration
const AUTH_TIMEOUT_MS = 180000;         // 3 minutes for manual login + MFA
const TOKEN_POLL_INTERVAL_MS = 500;     // Poll interval when waiting for token
const TOKEN_MAX_WAIT_MS = 15000;        // Max wait time for token extraction
const API_MAX_RETRIES = 3;              // Max API retry attempts
const API_BASE_DELAY_MS = 1000;         // Base delay for exponential backoff

/**
 * Ids learned from the current session (auth.test at login, or the cache
 * file). The Edge API needs one of them; nothing else does.
 */
const session = { enterpriseId: null, teamId: null };

/**
 * Sleep for specified milliseconds.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find Chrome executable path.
 * Priority: CHROME_PATH env var > auto-detect from multiple locations
 */
function findChrome() {
  // 1. Check environment variable first
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) {
      console.error(`${LOG_PREFIX} Using Chrome from CHROME_PATH: ${process.env.CHROME_PATH}`);
      return process.env.CHROME_PATH;
    }
    console.error(`${LOG_PREFIX} Warning: CHROME_PATH set but not found: ${process.env.CHROME_PATH}`);
  }

  // 2. Platform-specific search paths (in priority order)
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const searchPaths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
    win32: [
      process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean),
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ],
  };

  const paths = searchPaths[process.platform] || [];

  for (const chromePath of paths) {
    if (existsSync(chromePath)) {
      console.error(`${LOG_PREFIX} Found Chrome at: ${chromePath}`);
      return chromePath;
    }
  }

  // Build helpful error message
  const checkedPaths = paths.join('\n  - ');
  throw new Error(
    `Chrome not found. Please install Google Chrome or set CHROME_PATH environment variable.\n\n` +
    `Checked locations:\n  - ${checkedPaths}\n\n` +
    `To use a custom Chrome path, set CHROME_PATH:\n` +
    `  export CHROME_PATH="/path/to/chrome"  # macOS/Linux\n` +
    `  $env:CHROME_PATH="C:\\path\\to\\chrome.exe"  # Windows PowerShell`
  );
}

/** Host part of the configured workspace, used to tag and validate the cache. */
function workspaceHost() {
  return new URL(getWorkspaceUrl()).hostname;
}

/**
 * Save auth data (cookies + token + the ids the session belongs to) to file.
 */
function saveAuthToFile(cookies, token, ids = {}) {
  try {
    // This file holds a live xoxc token and session cookies, so it is owner-only.  `mode`
    // applies on creation; chmodSync covers a cache an earlier version already left at 644.
    const data = {
      workspace: workspaceHost(),
      cookies,
      token,
      teamId: ids.teamId || null,
      enterpriseId: ids.enterpriseId || null,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(AUTH_FILE, 0o600);
    console.error(`${LOG_PREFIX} Saved ${cookies.length} cookies and token to ${AUTH_FILE}`);
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to save auth to file:`, e.message);
  }
}

/**
 * Load auth data from file. A cache written for a different workspace is
 * ignored (not deleted): the configuration changed under it, and a login
 * against the new workspace will overwrite it.
 */
function loadAuthFromFile() {
  if (!existsSync(AUTH_FILE)) {
    console.error(`${LOG_PREFIX} No auth file found`);
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    const host = workspaceHost();
    if (data.workspace && data.workspace !== host) {
      console.error(`${LOG_PREFIX} Cached session is for ${data.workspace}, but the configured workspace is ${host} — ignoring the cache`);
      return null;
    }
    console.error(`${LOG_PREFIX} Loaded ${data.cookies?.length || 0} cookies from file`);
    return data;
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to load auth from file:`, e.message);
    return null;
  }
}

/**
 * Delete the auth file (called on auth failure).
 */
export function deleteAuthFile() {
  try {
    if (existsSync(AUTH_FILE)) {
      unlinkSync(AUTH_FILE);
      console.error(`${LOG_PREFIX} Deleted auth file`);
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to delete auth file:`, e.message);
  }
}

/**
 * Wait for successful auth - we know we're authenticated when we reach app.slack.com
 * Checks all browser tabs since Slack may open in a new tab
 */
async function waitForAuthComplete(browser, timeoutMs) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    // Check all open pages/tabs - Slack may open app.slack.com in a new tab
    const pages = await browser.pages();
    for (const p of pages) {
      const url = p.url();
      if (url.startsWith('https://app.slack.com')) {
        console.error(`${LOG_PREFIX} Auth complete, reached: ${url}`);
        return p;  // Return the page with app.slack.com
      }
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for authentication after ${timeoutMs}ms`);
}

/**
 * Extract API token from the page.
 * Tries multiple sources and waits for token to become available.
 */
async function extractApiToken(page, maxWaitMs = TOKEN_MAX_WAIT_MS) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const token = await page.evaluate(() => {
      // Primary: boot_data (modern Slack client)
      if (window.boot_data?.api_token) {
        return window.boot_data.api_token;
      }

      // Fallback 1: TS.boot_data (legacy Slack client format)
      if (window.TS?.boot_data?.api_token) {
        return window.TS.boot_data.api_token;
      }

      // Fallback 2: localStorage (older session storage format)
      try {
        const config = localStorage.getItem('localConfig_v2');
        if (config) {
          const parsed = JSON.parse(config);
          if (parsed.teams) {
            for (const teamId in parsed.teams) {
              if (parsed.teams[teamId]?.token) {
                return parsed.teams[teamId].token;
              }
            }
          }
          if (parsed.api_token) return parsed.api_token;
        }
      } catch (e) {
        // Ignore parse errors
      }

      // Fallback 3: Scrape from page HTML (last resort)
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const match = text.match(/"api_token"\s*:\s*"(xoxc-[^"]+)"/);
        if (match) return match[1];
      }

      return null;
    });

    if (token) {
      return token;
    }

    // Wait a bit and retry
    await sleep(TOKEN_POLL_INTERVAL_MS);
  }

  return null;
}

/**
 * Remember the session's org/team ids so the Edge API can be addressed.
 */
function rememberSessionIds(ids = {}) {
  if (ids.enterpriseId) session.enterpriseId = ids.enterpriseId;
  if (ids.teamId) session.teamId = ids.teamId;
}

/**
 * Get authentication cookies and token from browser session.
 *
 * The login flow is identity-provider agnostic: Chrome opens the configured
 * workspace URL, the operator signs in however their company does (SSO, MFA,
 * password), and the tool waits until a tab reaches app.slack.com. Nothing
 * here knows or cares which IdP is behind the sign-in page.
 */
export async function getAuthCookies(forceVisible = false) {
  // Resolve configuration first: a missing workspace must fail here, plainly,
  // before any browser opens.
  const workspaceUrl = getWorkspaceUrl();

  // Try loading from file first (no browser needed)
  if (!forceVisible) {
    const fileAuth = loadAuthFromFile();
    if (fileAuth && fileAuth.cookies?.length > 0 && fileAuth.token) {
      console.error(`${LOG_PREFIX} Using auth from file (no browser needed)`);
      rememberSessionIds(fileAuth);
      return fileAuth;
    }
  }

  const chromePath = findChrome();

  // Always show a visible browser when authenticating: SSO and MFA need a
  // person, and a headless window cannot be completed by one.
  console.error(`${LOG_PREFIX} Using profile directory: ${PROFILE_DIR}`);
  console.error(`${LOG_PREFIX} Starting browser (visible, for your sign-in)...`);

  // A test profile (SLACK_CLI_PROFILE containing "slack-cli-test") runs incognito
  // so nothing persists; the normal path keeps the SSO session in PROFILE_DIR.
  const isTestMode = PROFILE_DIR.includes('slack-cli-test');

  // Loaded here, not at module top: puppeteer-core is needed only to open a
  // browser, so the unit tests and every cached-session read run with no
  // node_modules at all.
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: isTestMode ? [
      '--window-size=1280,800',
      '--incognito',  // True clean slate for testing
    ] : [
      '--window-size=1280,800',
      `--user-data-dir=${PROFILE_DIR}`,
    ],
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Start at the workspace URL - this triggers the company's sign-in and redirects to app.slack.com on success
    console.error(`${LOG_PREFIX} Navigating to ${workspaceUrl}...`);
    await page.goto(workspaceUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });

    console.error(`${LOG_PREFIX} Waiting for sign-in to complete (timeout: ${AUTH_TIMEOUT_MS}ms)...`);
    // waitForAuthComplete checks all tabs and returns the page with app.slack.com
    const authPage = await waitForAuthComplete(browser, AUTH_TIMEOUT_MS);

    const currentUrl = authPage.url();
    console.error(`${LOG_PREFIX} Reached app.slack.com: ${currentUrl}`);

    // Extract API token from the authenticated page (polls until token is available)
    console.error(`${LOG_PREFIX} Extracting API token...`);
    const token = await extractApiToken(authPage);
    if (!token) {
      console.error(`${LOG_PREFIX} Warning: Could not extract API token from page`);
      console.error(`${LOG_PREFIX} API calls may fail without a valid token`);
    } else {
      console.error(`${LOG_PREFIX} Extracted API token (${token.length} chars)`);
    }

    // Get cookies via CDP session from the authenticated page
    const client = await authPage.createCDPSession();
    const { cookies: allCookies } = await client.send('Network.getAllCookies');
    console.error(`${LOG_PREFIX} Got ${allCookies.length} total cookies`);

    // Filter to Slack domains
    const targetCookies = allCookies.filter(
      c => c.domain.includes('slack.com') || c.domain.includes('slack-edge.com')
    );
    console.error(`${LOG_PREFIX} ${targetCookies.length} cookies for Slack domains`);

    // Learn which org/team this session belongs to, for the Edge API. Best-effort:
    // a failure here leaves the ids null and the Edge API says what it needs.
    let ids = {};
    if (token) {
      try {
        const me = await callSlackApi('auth.test', {}, targetCookies, token);
        ids = { teamId: me.team_id || null, enterpriseId: me.enterprise_id || null };
        rememberSessionIds(ids);
      } catch (e) {
        console.error(`${LOG_PREFIX} auth.test after login failed (${e.message}); Edge API discovery may need SLACK_ENTERPRISE_ID`);
      }
    }

    const authData = { cookies: targetCookies, token, ...ids };
    saveAuthToFile(targetCookies, token, ids);
    return authData;
  } finally {
    console.error(`${LOG_PREFIX} Closing browser...`);
    await browser.close();
    console.error(`${LOG_PREFIX} Browser closed`);
  }
}

/**
 * Format cookies for use in HTTP requests.
 */
export function formatCookiesForHeader(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * Make an authenticated API request with exponential retry.
 * Shared helper for both Slack API and Edge API calls.
 *
 * @param {string} url - Full URL to call
 * @param {object} options - Fetch options (method, headers, body)
 * @param {Array} cookies - Auth cookies
 * @param {string} apiName - API name for logging (e.g., "Slack API", "Edge API")
 */
async function makeApiRequest(url, options, cookies, apiName, opts = {}) {
  const cookieHeader = formatCookiesForHeader(cookies);
  let lastError;
  const { verbose = false } = opts;

  for (let attempt = 1; attempt <= API_MAX_RETRIES; attempt++) {
    try {
      if (verbose) {
        console.error(`[API] ${apiName} - ${url} - ${new Date().toISOString()}`);
      }

      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Cookie: cookieHeader,
        },
      });

      // Auth errors - don't retry, throw immediately
      if (response.status === 401 || response.status === 403) {
        throw new Error('AUTH_EXPIRED');
      }

      // Rate limit - handle with backoff
      if (response.status === 429) {
        incrementCounter('rateLimitHits');
        incrementCounter('retries');
        // Cap Retry-After at 60s so a misbehaving header can't stall us forever.
        const retryAfterRaw = parseInt(response.headers.get('retry-after') || '5', 10);
        const retryAfter = Math.min(retryAfterRaw, 60) * 1000;
        console.error(`[RATE LIMIT] Hit rate limit. Waiting ${retryAfter}ms before retry ${attempt}/${API_MAX_RETRIES}`);
        await sleep(retryAfter);
        continue;
      }

      // Server errors (5xx) - retry
      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      // Other client errors (4xx except auth) - don't retry
      if (!response.ok) {
        throw new Error(`${apiName} request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Slack API returns ok: false for errors even with 200 status
      if (data.ok === false) {
        if (data.error === 'invalid_auth' || data.error === 'not_authed' || data.error === 'token_revoked') {
          throw new Error('AUTH_EXPIRED');
        }
        if (data.error === 'ratelimited') {
          incrementCounter('rateLimitHits');
          incrementCounter('retries');
          const retryAfter = Math.min(data.retry_after || 5, 60) * 1000;
          console.error(`[RATE LIMIT] Hit rate limit. Waiting ${retryAfter}ms before retry ${attempt}/${API_MAX_RETRIES}`);
          await sleep(retryAfter);
          continue;
        }
        throw new Error(`${apiName} error: ${data.error}`);
      }

      incrementCounter('okCalls');
      return data;
    } catch (error) {
      lastError = error;

      // Don't retry auth errors
      if (error.message === 'AUTH_EXPIRED') {
        incrementCounter('failedCalls');
        throw error;
      }

      // Don't retry on final attempt
      if (attempt === API_MAX_RETRIES) {
        incrementCounter('failedCalls');
        console.error(`${LOG_PREFIX} ${apiName}: All ${API_MAX_RETRIES} attempts failed`);
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      incrementCounter('retries');
      const delayMs = API_BASE_DELAY_MS * (1 << (attempt - 1));
      console.error(`${LOG_PREFIX} ${apiName} attempt ${attempt}/${API_MAX_RETRIES} failed: ${error.message}. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  incrementCounter('failedCalls');
  throw lastError;
}

/**
 * Make an authenticated request to the Slack API.
 * Uses form-encoded body format.
 */
export async function callSlackApi(endpoint, params, cookies, token, opts = {}) {
  const formData = new URLSearchParams();
  formData.append('token', token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      formData.append(key, String(value));
    }
  }

  return makeApiRequest(
    `${getApiBase()}${endpoint}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    },
    cookies,
    'Slack API',
    opts
  );
}

/**
 * The id the Edge API is addressed by: the configured SLACK_ENTERPRISE_ID,
 * else the org id auth.test reported at login (Enterprise Grid), else the
 * team id (a single workspace). Throws a plain message when none is known.
 */
export function getEdgeCacheId() {
  const configured = getConfiguredEnterpriseId();
  if (configured) return configured;
  if (session.enterpriseId) return session.enterpriseId;
  if (session.teamId) return session.teamId;
  throw new Error(
    'Edge API unavailable: no org/team id is known for this session. ' +
    'Run `node cli.js login` (the id is captured from auth.test), or set SLACK_ENTERPRISE_ID ' +
    'to your Enterprise Grid org id (E…) or workspace team id (T…).'
  );
}

/**
 * Make an authenticated request to the Slack Edge API.
 * Uses JSON body format.
 */
export async function callEdgeApi(endpoint, body, cookies, token, opts = {}) {
  const cacheId = getEdgeCacheId();
  return makeApiRequest(
    `${EDGE_API_HOST}${cacheId}/${endpoint}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
    },
    cookies,
    'Edge API',
    opts
  );
}

/**
 * Resolve a username/display name to a Slack user.
 *
 * Returns { userId, slackId, displayName } on success, or { error, suggestions }
 * on failure. `userId` is the account's Slack username (the `name` field),
 * which is what search.messages' `from:` filter takes; `slackId` is the U… id.
 * Some companies provision usernames as employee numbers, so `userId` may be
 * numeric.
 */
export async function resolveUsername(username, cookies, token) {
  const response = await callEdgeApi('users/search', { query: username, count: 10 }, cookies, token);

  const results = response.results || [];

  if (results.length === 0) {
    return { error: `No user found matching '${username}'` };
  }

  // Check for exact match on display_name or first_name (case-insensitive)
  const exactMatch = results.find(u => {
    const query = username.toLowerCase();
    const displayName = u.profile?.display_name?.toLowerCase();
    const firstName = u.profile?.first_name?.toLowerCase();
    return displayName === query || firstName === query;
  });

  if (exactMatch) {
    return {
      userId: exactMatch.name,
      slackId: exactMatch.id,
      displayName: exactMatch.profile?.display_name || exactMatch.profile?.real_name || exactMatch.name
    };
  }

  // If only one result, assume it's correct
  if (results.length === 1) {
    const user = results[0];
    return {
      userId: user.name,
      slackId: user.id,
      displayName: user.profile?.display_name || user.profile?.real_name || user.name
    };
  }

  // Multiple results, no exact match - return suggestions
  const suggestions = results.slice(0, 5).map(u => {
    const display = u.profile?.display_name || u.profile?.real_name || u.name;
    return `${display} (${u.name})`;
  });

  return {
    error: `Multiple users match '${username}': ${suggestions.join(', ')}`,
    suggestions,
  };
}

/**
 * Look up a user by username, display name, or real name.
 * Returns full user profile including status.
 */
export async function lookupUser(query, cookies, token) {
  const response = await callEdgeApi('users/search', { query, count: 10 }, cookies, token);
  const results = response.results || [];

  if (results.length === 0) {
    return { error: `No user found matching '${query}'` };
  }

  // Find exact match on display_name, first_name, or username
  const queryLower = query.toLowerCase();
  const exactMatch = results.find(u => {
    const displayName = u.profile?.display_name?.toLowerCase();
    const firstName = u.profile?.first_name?.toLowerCase();
    const username = u.name;
    return displayName === queryLower || firstName === queryLower || username === query;
  });

  if (exactMatch || results.length === 1) {
    return { user: exactMatch || results[0] };
  }

  // Multiple results - return all for user to choose
  return {
    users: results.map(u => ({
      id: u.id,
      username: u.name,
      displayName: u.profile?.display_name || u.profile?.real_name || u.name,
      realName: u.real_name,
      title: u.profile?.title,
      deleted: u.deleted,
    })),
  };
}

/**
 * Get the current authenticated user's info.
 * Returns { userId, slackId, teamId, team, enterpriseId }
 */
export async function getCurrentUser(cookies, token) {
  const response = await callSlackApi('auth.test', {}, cookies, token);

  if (!response.ok) {
    throw new Error(`Failed to get current user: ${response.error}`);
  }

  rememberSessionIds({ teamId: response.team_id, enterpriseId: response.enterprise_id });

  return {
    userId: response.user,            // Slack username (what `from:` searches take)
    slackId: response.user_id,        // Slack user ID (U...)
    teamId: response.team_id,
    team: response.team,
    enterpriseId: response.enterprise_id || null,
  };
}

/**
 * List channels the user is a member of.
 * Uses conversations.list API which returns private channels.
 *
 * On Enterprise Grid workspaces this method may be admin-restricted
 * (`enterprise_is_restricted`); callers fall back to keyword discovery
 * through the Edge API when it is.
 *
 * @param {Array} cookies - Auth cookies
 * @param {string} token - API token
 * @param {object} opts - Options
 * @param {string} opts.types - Channel types: 'public_channel,private_channel,mpim,im'
 * @param {number} opts.limit - Max results per page (default: 200)
 * @param {boolean} opts.excludeArchived - Exclude archived channels (default: true)
 */
export async function listUserChannels(cookies, token, opts = {}) {
  const {
    types = 'public_channel,private_channel',
    limit = 200,
    excludeArchived = true,
  } = opts;

  const allChannels = [];
  let cursor = null;

  do {
    const params = {
      types,
      limit,
      exclude_archived: excludeArchived,
    };
    if (cursor) {
      params.cursor = cursor;
    }

    const response = await callSlackApi('conversations.list', params, cookies, token);

    if (response.channels) {
      allChannels.push(...response.channels);
    }

    cursor = response.response_metadata?.next_cursor || null;
  } while (cursor);

  return allChannels;
}

/**
 * Get user's reactions (messages they've reacted to).
 * Uses reactions.list API.
 */
export async function getUserReactions(cookies, token, opts = {}) {
  const { limit = 100, cursor = null } = opts;

  const params = { limit };
  if (cursor) {
    params.cursor = cursor;
  }

  return callSlackApi('reactions.list', params, cookies, token);
}

/**
 * Resolve channel name or ID to channel ID.
 * If input looks like a channel ID (C..., G..., D...), returns it directly.
 * Otherwise searches for the channel by name: Edge `channels/search` first
 * (works everywhere the Edge API is reachable), then `conversations.list`
 * (finds private channels; may be admin-restricted on Enterprise Grid).
 */
export async function resolveChannel(channelInput, cookies, token) {
  // Detect channel ID pattern (starts with C, G, or D followed by alphanumeric)
  const isChannelId = /^[CGD][A-Z0-9]+$/i.test(channelInput);

  if (isChannelId) {
    return { channelId: channelInput.toUpperCase(), channelName: null };
  }

  // Clean up channel name (remove # if present)
  const cleanChannelName = channelInput.replace(/^#/, '');

  // Try Edge API first (for public channels)
  try {
    const channelSearch = await callEdgeApi('channels/search', { query: cleanChannelName, count: 5 }, cookies, token);

    if (channelSearch.results && channelSearch.results.length > 0) {
      const exactMatch = channelSearch.results.find(c => c.name.toLowerCase() === cleanChannelName.toLowerCase());
      const channel = exactMatch || channelSearch.results[0];
      return { channelId: channel.id, channelName: channel.name };
    }
  } catch (e) {
    // Edge API might not find private channels, continue to fallback
  }

  // Fallback: search through user's channels (includes private)
  const userChannels = await listUserChannels(cookies, token, { types: 'public_channel,private_channel' });
  const matchedChannel = userChannels.find(c => c.name.toLowerCase() === cleanChannelName.toLowerCase());

  if (matchedChannel) {
    return { channelId: matchedChannel.id, channelName: matchedChannel.name };
  }

  throw new Error(`Channel "${channelInput}" not found. You may not be a member of this channel; private channels usually need the C… id rather than the #name.`);
}
