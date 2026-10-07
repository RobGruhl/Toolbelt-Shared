#!/usr/bin/env node
// gmh — gmail-harvest. Byte-exact, read-only Gmail export on the operator's own OAuth grant.
//
// Bulk mail reads never pass through a model: `export` writes each message's raw RFC 822 bytes
// straight to disk, one <id>.eml per message, plus a metadata-only index.jsonl. The patterns,
// marked with their SENSIBILITIES.md number:
//   #1  read-only by construction — the only scope ever requested is gmail.readonly, every Gmail
//       request is a GET, and a token carrying any other scope is refused
//   #3  ceilings are exported code constants (MAX_MESSAGES, DEFAULT_MAX, CONCURRENCY, …)
//   #5  `export --explain` resolves credentials and runs the list, then fetches no bodies and
//       writes nothing
//   #6  token verbs (auth / status) and a 600-mode cache outside the tree; a loose file is refused
//   #7  one audit line per verb run, to stderr and a 600-mode log — never tokens, never content
//   #8  plain sentences and exit codes for every failure; per-message failures are recorded
//   #9  bounded concurrency, backoff that honors Retry-After, a consecutive-failure breaker
//   #11 the client secret comes from the macOS Keychain via execFile — never argv, never printed
//
// Exit codes: 0 ok · 1 auth, network, API or per-message failure · 2 bad usage

import { parseArgs } from 'node:util';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- ceilings (code constants — SENSIBILITIES #3) ---------------------------
// Raising one is a reviewed diff, not an argument an agent can pass on a bad day.
export const MAX_MESSAGES = 5000;     // per export / list; a higher --max is refused, not lowered
export const DEFAULT_MAX = 500;       // used when --max is absent
export const CONCURRENCY = 4;         // Gmail answers 429 "Too many concurrent requests for user" above low concurrency
export const TIMEOUT_MS = 30_000;     // per request, AbortSignal
export const MAX_ATTEMPTS = 4;        // per request; backoff on 429 / 5xx / rate-limit 403, honoring Retry-After
export const MAX_RETRY_WAIT_MS = 60_000;
export const BREAKER = 10;            // consecutive per-message failures that stop an export
export const LIST_PAGE = 500;         // users.messages.list maxResults maximum
export const AUTH_WAIT_MS = 5 * 60_000;
export const QUOTA_UNITS_PER_CALL = 5; // messages.list and messages.get each cost 5 per-user quota units

// ---- fixed endpoints and stores ---------------------------------------------
export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const KEYCHAIN_SERVICE = 'google-workspace-oauth';
export const TOKEN_DIR = path.join(homedir(), '.config', 'toolbelt', 'gmail-harvest');
export const AUDIT_DIR = path.join(homedir(), '.local', 'share', 'toolbelt', 'gmail-harvest');
export const AUDIT_LOG = path.join(AUDIT_DIR, 'audit.log');
export const VERBS = ['auth', 'status', 'whoami', 'list', 'export', 'links'];
const VERSION = '0.1.0';
const SELF = realpathSync(fileURLToPath(import.meta.url));
const BELT_ROOT = path.resolve(path.dirname(SELF), '..', '..');
const ID_RE = /^[0-9a-f]{6,32}$/i;
const ACCOUNT_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A failure with a plain sentence and an exit code; `fatal` stops an export outright. */
export class GmhError extends Error {
  constructor(message, { code = 1, fatal = true, status } = {}) {
    super(message);
    this.exitCode = code;
    this.fatal = fatal;
    this.status = status;
  }
}
const usageError = (msg) => new GmhError(msg, { code: 2 });

// ---- argument parsing (pure, exported for tests) ----------------------------

/** Parse argv (without node and script). Throws a usage GmhError (exit 2) on anything malformed. */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: 'string', short: 'a' },
        query: { type: 'string', short: 'q' },
        max: { type: 'string', short: 'n' },
        'ids-file': { type: 'string' },
        eml: { type: 'string' },
        match: { type: 'string' },
        out: { type: 'string', short: 'o' },
        json: { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        live: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    throw usageError(e.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) return { help: true };
  if (v.version) return { version: true };
  const [verb, ...extra] = positionals;
  if (!verb) throw usageError(`no verb — one of: ${VERBS.join(', ')}`);
  if (!VERBS.includes(verb)) throw usageError(`unknown verb "${verb}" — one of: ${VERBS.join(', ')} (gmh has no write verbs)`);
  if (extra.length) throw usageError(`unexpected argument "${extra[0]}" — pass the search as --query "<gmail search>"`);

  const allowed = {
    auth: ['account'],
    status: ['account', 'live', 'json'],
    whoami: ['account', 'json'],
    list: ['account', 'query', 'max', 'json'],
    export: ['account', 'query', 'ids-file', 'out', 'max', 'explain', 'json'],
    links: ['eml', 'match', 'json'],
  }[verb];
  for (const k of ['account', 'query', 'max', 'ids-file', 'out', 'explain', 'live', 'json', 'eml', 'match']) {
    const set = v[k] !== undefined && v[k] !== false;
    if (set && !allowed.includes(k)) throw usageError(`--${k} does not apply to ${verb}`);
  }

  const cli = { verb, json: v.json, explain: v.explain, live: v.live };
  cli.account = v.account === undefined ? null : assertAccount(v.account);
  if (verb === 'list' || verb === 'export') cli.max = clampMax(v.max);
  if (verb === 'list') {
    if (!v.query || !v.query.trim()) throw usageError('list needs --query "<gmail search>" (e.g. --query "newer_than:7d")');
    cli.query = v.query.trim();
  }
  if (verb === 'export') {
    const hasQ = v.query !== undefined;
    const hasF = v['ids-file'] !== undefined;
    if (hasQ === hasF) throw usageError('export needs exactly one of --query "<gmail search>" or --ids-file <file>');
    if (hasQ) {
      if (!v.query.trim()) throw usageError('--query is empty');
      cli.query = v.query.trim();
    } else {
      cli.idsFile = v['ids-file'];
    }
    if (!v.out) throw usageError('export needs --out <dir> (a private directory outside the Toolbelt tree)');
    cli.out = v.out;
  }
  if (verb === 'links') {
    if (!v.eml) throw usageError('links needs --eml <file> (an exported message)');
    cli.eml = v.eml;
    if (v.match !== undefined) {
      try { cli.match = new RegExp(v.match, 'i'); } catch (e) { throw usageError(`--match is not a valid regular expression (${e.message})`); }
    }
  }
  return cli;
}

/** --max: absent → DEFAULT_MAX; above MAX_MESSAGES → refused (SENSIBILITIES #3), never lowered. */
export function clampMax(raw) {
  if (raw === undefined) return DEFAULT_MAX;
  if (!/^\d+$/.test(String(raw))) throw usageError(`--max must be a positive integer, got "${raw}"`);
  const n = parseInt(raw, 10);
  if (n < 1) throw usageError('--max must be at least 1');
  if (n > MAX_MESSAGES) {
    throw usageError(`--max ${n} exceeds the ${MAX_MESSAGES} ceiling (MAX_MESSAGES, a code constant in gmh.mjs — raising it is a deliberate edit, not a flag; split the export by date instead)`);
  }
  return n;
}

/** The account names the token file, so it must be a plain address — nothing path-shaped. */
export function assertAccount(raw) {
  const a = String(raw).trim().toLowerCase();
  if (!ACCOUNT_RE.test(a) || a.includes('..')) throw usageError(`--account "${raw}" is not an email address`);
  return a;
}

/** One Gmail message id per line; blank lines and # comments ignored; deduped, order kept. */
export function parseIdsFile(text) {
  const ids = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.replace(/#.*$/, '').trim();
    if (!s) return;
    if (!ID_RE.test(s)) throw usageError(`ids-file line ${i + 1}: "${s.slice(0, 40)}" is not a Gmail message id (hex)`);
    const id = s.toLowerCase();
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  });
  return ids;
}

// ---- OAuth: PKCE, state, auth URL, scope (pure) -----------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** PKCE S256 pair: a 43-char verifier from 32 random bytes and its SHA-256 challenge. */
export function makePkce(bytes = randomBytes(32)) {
  const verifier = b64url(bytes);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** A random CSRF state for the loopback callback. */
export function makeState(bytes = randomBytes(24)) {
  return b64url(bytes);
}

/** The consent URL. Refuses any scope but gmail.readonly — read-only by construction. */
export function buildAuthUrl({ clientId, redirectUri, challenge, state, loginHint = null, scope = SCOPE }) {
  if (scope !== SCOPE) throw new GmhError(`refusing to request scope "${scope}" — gmh requests exactly ${SCOPE}`);
  if (!clientId || !redirectUri || !challenge || !state) throw new GmhError('buildAuthUrl: clientId, redirectUri, challenge and state are required');
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(redirectUri)) throw new GmhError(`redirect must be a 127.0.0.1 loopback, got ${redirectUri}`);
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${p}`;
}

/** Split a granted-scope string into a set. */
export function scopeSet(scope) {
  return new Set(String(scope ?? '').split(/\s+/).filter(Boolean));
}

/** Refuse any grant whose scope set is not exactly {gmail.readonly}. */
export function assertScopeExact(scope) {
  const s = scopeSet(scope);
  if (s.size === 1 && s.has(SCOPE)) return;
  const got = s.size ? [...s].join(' ') : '(none)';
  throw new GmhError(`granted scope is "${got}" — gmh accepts exactly ${SCOPE} and nothing else. `
    + (s.has(SCOPE) ? 'Google returned extra scopes on this grant; it was not used or saved (see CLAUDE.md, "Auth").' : 'Re-run `gmh auth` and tick the Gmail read box on the consent page.'));
}

/**
 * The loopback callback's query string → {code} | {error} | {ignore}. A request whose state
 * does not match is ignored rather than fatal: something else on the machine may have hit the
 * port, and the real redirect can still arrive.
 */
export function parseCallback(params, expectedState) {
  if (params.get('state') !== expectedState) return { ignore: 'state mismatch' };
  if (params.get('error')) return { error: `consent not granted (${params.get('error')})` };
  const code = params.get('code');
  if (!code) return { ignore: 'no code' };
  return { code };
}

// ---- token cache (SENSIBILITIES #6) -----------------------------------------

export const tokenPath = (account, dir = TOKEN_DIR) => path.join(dir, `${assertAccount(account)}.json`);

/** Read a token file. A group/world-readable file is refused, not read; a wrong scope is refused. */
export function readTokenFile(file) {
  if (!existsSync(file)) throw new GmhError(`no token at ${file} — run \`gmh auth\` first`);
  const mode = statSync(file).mode;
  if ((mode & 0o077) !== 0) {
    throw new GmhError(`${file} is group/world readable (mode ${(mode & 0o777).toString(8)}) — chmod 600 it first (gmh refuses to read a loose-permission token file)`);
  }
  let tok;
  try {
    tok = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new GmhError(`${file} is not valid JSON (${e.message}) — delete it and re-run \`gmh auth\``);
  }
  assertScopeExact(tok.scope);
  return tok;
}

/** Write a token file atomically: dir 0700, file 0600. */
export function writeTokenFile(file, tok) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tok, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Accounts with a token file, sorted. */
export function listAccounts(dir = TOKEN_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    .filter((a) => ACCOUNT_RE.test(a)).sort();
}

/** --account, else the only cached account; several or none is a plain sentence. */
export function pickAccount(account, dir = TOKEN_DIR) {
  if (account) return account;
  const all = listAccounts(dir);
  if (all.length === 1) return all[0];
  if (!all.length) throw new GmhError('no Gmail account authorized — run `gmh auth --account <you@example.com>`');
  throw new GmhError(`${all.length} accounts authorized (${all.join(', ')}) — pass --account`);
}

// ---- OAuth client (SENSIBILITIES #11) ---------------------------------------

/** The client id is the Keychain item's account field: `"acct"<blob>="…"`. */
export function parseKeychainAccount(text) {
  const m = /"acct"<blob>="([^"]*)"/.exec(String(text));
  return m && m[1] ? m[1] : null;
}

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Client id + secret: the Keychain item shared with connectors/google-workspace, else the
 * GOOGLE_OAUTH_CLIENT_ID / _SECRET environment. Read with execFile, so the secret is never on
 * argv and never in a shell; it is held in memory and never printed.
 */
export async function resolveClient({ env = process.env, run = execFileP } = {}) {
  try {
    const meta = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE]);
    const clientId = parseKeychainAccount(`${meta.stdout}\n${meta.stderr}`);
    const sec = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
    const clientSecret = sec.stdout.replace(/\r?\n$/, '');
    if (clientId && clientSecret) return { clientId, clientSecret, source: `keychain (${KEYCHAIN_SERVICE})` };
  } catch {
    /* no item, or no Keychain on this platform — fall through to the environment */
  }
  const id = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (id && secret) return { clientId: id, clientSecret: secret, source: 'environment' };
  throw new GmhError(`no OAuth client — store the Desktop-app client in the Keychain: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "<client id>" -w   (prompts for the secret; never on argv)`);
}

/** Keychain item presence only — no -w, so the secret never leaves the Keychain. */
async function keychainPresent(run = execFileP) {
  try { await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE]); return true; } catch { return false; }
}

// ---- export helpers (pure) --------------------------------------------------

/** Gmail's `raw` (base64url) → the exact RFC 822 bytes. Refuses anything that would not round-trip. */
export function decodeRaw(raw) {
  if (typeof raw !== 'string' || raw === '') throw new GmhError('message has no raw body', { fatal: false });
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(raw)) throw new GmhError('raw body is not base64url', { fatal: false });
  const buf = Buffer.from(raw, 'base64url');
  if (buf.toString('base64url') !== raw.replace(/=+$/, '')) throw new GmhError('raw body does not round-trip (truncated base64url)', { fatal: false });
  return buf;
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * index.jsonl → the latest record per id. Malformed lines are counted, never fatal: the index is
 * append-only and a crash can leave a torn last line.
 */
export function readIndex(text) {
  const records = new Map();
  let malformed = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.id === 'string') records.set(r.id, r);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/**
 * Which ids still need fetching. An id is done when its latest index record is a success and
 * <id>.eml exists with exactly the recorded byte count; anything else is fetched again.
 * `sizeOf(id)` returns the .eml size or null — injectable so tests need no filesystem.
 */
export function resumePlan(ids, records, sizeOf) {
  const todo = [];
  const skipped = [];
  for (const id of ids) {
    const r = records.get(id);
    const ok = r && !r.error && typeof r.sha256 === 'string' && Number.isInteger(r.bytes) && sizeOf(id) === r.bytes;
    (ok ? skipped : todo).push(id);
  }
  return { todo, skipped };
}

/**
 * The export directory must be private and outside the belt: never `/`, never $HOME itself,
 * never inside the Toolbelt tree (exported mail must never land where a commit or a grep can
 * reach it). Symlinks are resolved through the nearest existing ancestor.
 */
export function checkOutDir(dir, { home = homedir(), roots = beltRoots(), cwd = process.cwd() } = {}) {
  const abs = path.resolve(cwd, String(dir).replace(/^~(?=$|\/)/, home));
  const real = realpathNearest(abs);
  const realHome = realpathNearest(path.resolve(home));
  if (real === path.parse(real).root) throw usageError('--out / refused — name a dedicated directory for the export');
  if (real === realHome) throw usageError('--out is your home directory itself — name a dedicated subdirectory');
  for (const r of roots) {
    const rr = realpathNearest(path.resolve(r));
    if (real === rr || real.startsWith(rr + path.sep)) {
      throw usageError(`--out ${abs} is inside the Toolbelt tree (${r}) — exported mail is private data and never lands in the belt; pick a directory outside it`);
    }
  }
  return abs;
}

function realpathNearest(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function beltRoots(env = process.env) {
  const roots = new Set([BELT_ROOT, path.join(homedir(), 'Toolbelt')]);
  if (env.TOOLBELT) roots.add(env.TOOLBELT);
  return [...roots];
}

/** Retry wait: Retry-After (seconds or HTTP date) when present, else 1s·2^(n-1) + jitter; capped. */
export function retryDelayMs(attempt, retryAfter = null, { now = Date.now(), rand = Math.random } = {}) {
  if (retryAfter != null && retryAfter !== '') {
    const s = Number(retryAfter);
    const ms = Number.isFinite(s) ? s * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms)) return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, ms));
  }
  return Math.min(MAX_RETRY_WAIT_MS, 1000 * 2 ** (attempt - 1) + Math.floor(rand() * 250));
}

/** Retryable: 429, 5xx, and Gmail's rate-limit 403s (rateLimitExceeded / userRateLimitExceeded). */
export function isRetryable(status, reason = '') {
  return status === 429 || status >= 500 || (status === 403 && /ratelimitexceeded/i.test(reason));
}

// ---- audit (SENSIBILITIES #7) -----------------------------------------------

/** One grep-able line: timestamp and key=value fields. Never tokens, never message content. */
export function auditLine(fields, now = new Date()) {
  const parts = [`[gmh audit] ${now.toISOString()}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${typeof v === 'number' ? v : JSON.stringify(String(v))}`);
  }
  return parts.join(' ');
}

function audit(fields) {
  const line = auditLine(fields);
  console.error(line);
  try {
    mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
    chmodSync(AUDIT_DIR, 0o700);
    appendFileSync(AUDIT_LOG, `${line}\n`, { mode: 0o600 });
    chmodSync(AUDIT_LOG, 0o600);
  } catch (e) {
    console.error(`gmh: could not append to ${AUDIT_LOG} (${e.message}) — the stderr line above is the only record`);
  }
}

// ---- network: OAuth token endpoint ------------------------------------------

async function postToken(form) {
  let res;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GmhError(`cannot reach ${TOKEN_ENDPOINT} (${e.name === 'TimeoutError' ? 'timeout' : e.cause?.code ?? e.message}) — are you online?`);
  }
  let body = {};
  try { body = await res.json(); } catch { /* reported below */ }
  if (res.ok && body.access_token) return body;
  if (body.error === 'invalid_grant') {
    throw new GmhError('Google refused the refresh token (invalid_grant) — re-run `gmh auth`. '
      + 'While the OAuth consent screen is in Testing status Google expires refresh tokens 7 days after consent; move the consent screen to Production to stop that.');
  }
  throw new GmhError(`Google token endpoint answered HTTP ${res.status}${body.error ? ` (${body.error}${body.error_description ? `: ${body.error_description}` : ''})` : ''}`);
}

/**
 * A live session for one account: a current access token, refreshed ahead of expiry or on a
 * 401. `persist: false` (the --explain path) keeps a refreshed token in memory only.
 */
async function openSession(account, { persist = true } = {}) {
  const file = tokenPath(account);
  let tok = readTokenFile(file);
  let client = null;
  let inflight = null;

  async function refresh() {
    if (!tok.refresh_token) throw new GmhError(`${file} has no refresh token — re-run \`gmh auth\``);
    client ??= await resolveClient();
    const body = await postToken({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    assertScopeExact(body.scope ?? tok.scope);
    tok = {
      ...tok,
      access_token: body.access_token,
      expiry: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      scope: body.scope ?? tok.scope,
      ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
      refreshed_at: new Date().toISOString(),
    };
    if (persist) writeTokenFile(file, tok);
  }

  return {
    account,
    async accessToken() {
      const left = Date.parse(tok.expiry ?? 0) - Date.now();
      if (!tok.access_token || !(left > 60_000)) {
        inflight ??= refresh().finally(() => { inflight = null; });
        await inflight;
      }
      return tok.access_token;
    },
    async forceRefresh() {
      inflight ??= refresh().finally(() => { inflight = null; });
      await inflight;
    },
  };
}

// ---- network: the one Gmail path (GET only) ---------------------------------

/** Every Gmail read goes through here: timeout, retries with backoff, one refresh on 401. */
async function gmailGet(session, pathAndQuery) {
  let refreshed = false;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await session.accessToken();
    let res;
    try {
      res = await fetch(`${GMAIL_API}${pathAndQuery}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      lastErr = new GmhError(`network error reaching Gmail (${e.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS / 1000}s` : e.cause?.code ?? e.message})`, { fatal: false });
      if (attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt)); continue; }
      throw lastErr;
    }
    if (res.ok) return res.json();
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await session.forceRefresh();
      attempt--; // a refreshed token is not a retry of a failing server
      continue;
    }
    if (isRetryable(res.status, reason) && attempt < MAX_ATTEMPTS) {
      await sleep(retryDelayMs(attempt, res.headers.get('retry-after')));
      continue;
    }
    if (res.status === 401) throw new GmhError('Gmail rejected the access token after a refresh (HTTP 401) — re-run `gmh auth`');
    if (res.status === 404) throw new GmhError('not found (deleted, or not in this mailbox)', { fatal: false, status: 404 });
    if (res.status === 403 && !isRetryable(403, reason)) {
      throw new GmhError(`Gmail refused the call (HTTP 403 ${reason}): ${msg} — is the Gmail API enabled in the OAuth client's Cloud project?`);
    }
    if (res.status === 400) throw new GmhError(`Gmail rejected the request (HTTP 400): ${msg}`, { fatal: false, status: 400 });
    throw new GmhError(`Gmail HTTP ${res.status} ${reason} after ${attempt} attempt(s): ${msg}`, { fatal: false, status: res.status });
  }
  throw lastErr ?? new GmhError('Gmail request failed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** users.messages.list, paginated at LIST_PAGE, stopping at `max`. Reports whether more matched. */
async function listIds(session, query, max) {
  const out = [];
  const seen = new Set();
  let pageToken = null;
  let pages = 0;
  let estimate = null;
  do {
    const p = new URLSearchParams({ q: query, maxResults: String(Math.min(LIST_PAGE, max - out.length)) });
    if (pageToken) p.set('pageToken', pageToken);
    const body = await gmailGet(session, `/messages?${p}`);
    pages++;
    if (estimate === null) estimate = body.resultSizeEstimate ?? null;
    for (const m of body.messages ?? []) {
      if (!ID_RE.test(m.id ?? '') || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ id: m.id, threadId: m.threadId });
      if (out.length >= max) break;
    }
    pageToken = body.nextPageToken ?? null;
  } while (pageToken && out.length < max);
  return { messages: out, more: Boolean(pageToken) && out.length >= max, pages, estimate };
}

// ---- verbs ------------------------------------------------------------------

async function cmdAuth(cli) {
  const client = await resolveClient();
  const { verifier, challenge } = makePkce();
  const state = makeState();
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const url = buildAuthUrl({ clientId: client.clientId, redirectUri, challenge, state, loginHint: cli.account });

  console.error(`gmh: opening Google consent for ${SCOPE} (read-only; nothing else is requested)`);
  console.error(`gmh: if no browser opens, visit:\n${url}`);
  execFile('open', [url], () => {});

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new GmhError(`no consent within ${AUTH_WAIT_MS / 60_000} minutes — re-run \`gmh auth\``)), AUTH_WAIT_MS);
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        if (u.pathname !== '/') { res.writeHead(404).end(); return; }
        const r = parseCallback(u.searchParams, state);
        if (r.ignore) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('gmh: not the callback this run is waiting for.\n'); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end(r.error ? `gmh: ${r.error}. You can close this tab.\n` : 'gmh: consent received. You can close this tab and return to the terminal.\n');
        clearTimeout(timer);
        if (r.error) reject(new GmhError(r.error)); else resolve(r.code);
      });
    });
  } finally {
    server.close();
  }

  const body = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  assertScopeExact(body.scope);
  if (!body.refresh_token) throw new GmhError('Google returned no refresh token — re-run `gmh auth` (the consent must complete with prompt=consent)');

  const now = new Date();
  const tok = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type ?? 'Bearer',
    expiry: new Date(now.getTime() + (body.expires_in ?? 3600) * 1000).toISOString(),
    scope: body.scope,
    client_id: client.clientId,
    consented_at: now.toISOString(),
  };
  const probe = { accessToken: async () => tok.access_token, forceRefresh: async () => { throw new GmhError('fresh token rejected by Gmail'); } };
  const profile = await gmailGet(probe, '/profile');
  const email = assertAccount(profile.emailAddress);
  if (cli.account && cli.account !== email) {
    throw new GmhError(`consent was granted by ${email}, not ${cli.account} — nothing saved; re-run and pick ${cli.account} in the browser`);
  }
  tok.account = email;
  const file = tokenPath(email);
  writeTokenFile(file, tok);
  console.log(`authorized ${email} — scope ${SCOPE} only · token cached at ${file} (mode 600) · client from ${client.source}`);
  audit({ verb: 'auth', account: email, result: 'ok' });
}

async function cmdStatus(cli) {
  const accounts = cli.account ? [cli.account] : listAccounts();
  const report = {
    mode: 'read-only',
    scope: SCOPE,
    client: (await keychainPresent()) ? `keychain item ${KEYCHAIN_SERVICE} present`
      : process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET ? 'environment (GOOGLE_OAUTH_CLIENT_ID/_SECRET)'
        : `missing — security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "<client id>" -w`,
    token_dir: TOKEN_DIR,
    accounts: [],
  };
  let problems = 0;
  for (const a of accounts) {
    const file = tokenPath(a);
    const row = { account: a, file };
    if (!existsSync(file)) {
      row.state = 'no token — run `gmh auth --account ' + a + '`';
      problems++;
    } else {
      const mode = statSync(file).mode & 0o777;
      row.mode = mode.toString(8);
      try {
        const tok = readTokenFile(file);
        const left = Date.parse(tok.expiry ?? 0) - Date.now();
        row.scope = 'gmail.readonly (exact)';
        row.access = left > 0 ? `valid ${Math.round(left / 60_000)}m more` : 'expired — renewed by the refresh grant on the next call';
        row.refresh_token = tok.refresh_token ? 'present' : 'missing — re-run `gmh auth`';
        row.consented_at = tok.consented_at ?? null;
        if (tok.consented_at) {
          row.testing_mode_expiry = new Date(Date.parse(tok.consented_at) + 7 * 86_400_000).toISOString()
            + ' (only if the consent screen is in Testing status)';
        }
        if (!tok.refresh_token) problems++;
      } catch (e) {
        row.state = `REFUSED: ${e.message}`;
        problems++;
      }
    }
    if (cli.live && !row.state) {
      try {
        const s = await openSession(a);
        const p = await gmailGet(s, '/profile');
        row.live = `ok — ${p.emailAddress}, ${p.messagesTotal} messages`;
      } catch (e) {
        row.live = `FAILED: ${e.message}`;
        problems++;
      }
    }
    report.accounts.push(row);
  }
  if (!accounts.length) problems++;
  audit({ verb: 'status', account: cli.account ?? undefined, live: cli.live ? 'yes' : 'no', count: accounts.length, failures: problems });
  if (cli.json) { console.log(JSON.stringify(report, null, 2)); return problems ? 1 : 0; }
  const lines = [
    `gmh ${VERSION} — ${report.mode}: scope ${SCOPE} only; no write code exists`,
    `client     ${report.client}`,
    `tokens     ${TOKEN_DIR}`,
  ];
  if (!accounts.length) lines.push('account    none authorized — run `gmh auth --account <you@example.com>`');
  for (const r of report.accounts) {
    lines.push(`account    ${r.account}  (${r.file}${r.mode ? `, mode ${r.mode}` : ''})`);
    if (r.state) lines.push(`  state    ${r.state}`);
    if (r.scope) lines.push(`  scope    ${r.scope}`, `  access   ${r.access}`, `  refresh  ${r.refresh_token}`);
    if (r.testing_mode_expiry) lines.push(`  consent  ${r.consented_at} · refresh token dies ${r.testing_mode_expiry}`);
    if (r.live) lines.push(`  live     ${r.live}`);
  }
  if (!cli.live) lines.push('(no network call made; --live reads users/me/profile)');
  console.log(lines.join('\n'));
  return problems ? 1 : 0;
}

async function cmdWhoami(cli) {
  const account = pickAccount(cli.account);
  const s = await openSession(account);
  const p = await gmailGet(s, '/profile');
  audit({ verb: 'whoami', account });
  if (cli.json) { console.log(JSON.stringify(p, null, 2)); return 0; }
  console.log([
    `email      ${p.emailAddress}`,
    `messages   ${p.messagesTotal}`,
    `threads    ${p.threadsTotal}`,
    `historyId  ${p.historyId}`,
  ].join('\n'));
  return 0;
}

async function cmdList(cli) {
  const account = pickAccount(cli.account);
  const s = await openSession(account);
  const r = await listIds(s, cli.query, cli.max);
  audit({ verb: 'list', account, query: cli.query, count: r.messages.length, more: r.more ? 'yes' : 'no' });
  const tail = `${r.messages.length} message id(s) for ${JSON.stringify(cli.query)} (max ${cli.max}, ceiling ${MAX_MESSAGES})`
    + (r.more ? ` — MORE matched and were not listed (Gmail estimates ~${r.estimate}); raise --max or narrow the query` : '');
  if (cli.json) {
    console.log(JSON.stringify(r.messages));
    console.error(tail);
    return 0;
  }
  if (!r.messages.length) {
    console.log(`0 messages matched ${JSON.stringify(cli.query)} in ${account} — spam and trash are excluded; check the query in the Gmail web UI before concluding there is no such mail`);
    return 0;
  }
  console.log(r.messages.map((m) => `${m.id}  ${m.threadId}`).join('\n'));
  console.error(tail);
  return 0;
}

async function cmdExport(cli) {
  const out = checkOutDir(cli.out);
  const account = pickAccount(cli.account);
  const indexPath = path.join(out, 'index.jsonl');
  const source = cli.query ? { query: cli.query } : { ids_file: path.resolve(cli.idsFile) };

  // Ids first — a list call for a query, the file for --ids-file — so --explain can count them.
  let ids;
  let more = false;
  let estimate = null;
  let listPages = 0;
  let session;
  if (cli.idsFile) {
    if (!existsSync(cli.idsFile)) throw usageError(`--ids-file ${cli.idsFile} does not exist`);
    ids = parseIdsFile(readFileSync(cli.idsFile, 'utf8'));
    if (ids.length > cli.max) {
      throw usageError(`--ids-file has ${ids.length} ids, above --max ${cli.max} (default ${DEFAULT_MAX}, ceiling ${MAX_MESSAGES}) — pass --max ${Math.min(ids.length, MAX_MESSAGES)} or split the file`);
    }
    session = await openSession(account, { persist: !cli.explain });
    await session.accessToken(); // proves the credential chain before any body is fetched
  } else {
    session = await openSession(account, { persist: !cli.explain });
    const r = await listIds(session, cli.query, cli.max);
    ids = r.messages.map((m) => m.id);
    more = r.more;
    estimate = r.estimate;
    listPages = r.pages;
  }

  const index = existsSync(indexPath) ? readIndex(readFileSync(indexPath, 'utf8')) : { records: new Map(), malformed: 0 };
  const sizeOf = (id) => { try { return statSync(path.join(out, `${id}.eml`)).size; } catch { return null; } };
  const plan = resumePlan(ids, index.records, sizeOf);

  if (cli.explain) {
    const lines = [
      'gmh export --explain — pre-flight: no message bodies fetched, nothing written',
      `account    ${account} · scope ${SCOPE} (read-only)`,
      cli.query
        ? `query      ${JSON.stringify(cli.query)} → ${ids.length} match(es)${more ? ` and MORE (Gmail estimates ~${estimate}); an export stops at --max ${cli.max}` : ''}`
        : `ids-file   ${source.ids_file} → ${ids.length} id(s)`,
      `ceiling    --max ${cli.max} (default ${DEFAULT_MAX}, hard ceiling MAX_MESSAGES ${MAX_MESSAGES})`,
      `out        ${out}${existsSync(out) ? '' : ' (would be created, mode 700)'}`,
      `resume     ${plan.skipped.length} already exported in index.jsonl (skipped) · ${plan.todo.length} to fetch`,
      `calls      ${listPages} messages.list page(s) spent on this pre-flight · ${plan.todo.length} messages.get (format=raw) · ~${(listPages + plan.todo.length) * QUOTA_UNITS_PER_CALL} quota units`,
      `pace       concurrency ${CONCURRENCY} · timeout ${TIMEOUT_MS / 1000}s · up to ${MAX_ATTEMPTS} attempts with backoff`,
      'exported mail is private data: the .eml files carry full bodies and attachments',
    ];
    console.log(lines.join('\n'));
    audit({ verb: 'export', mode: 'explain', account, ...source, count: ids.length, bytes: 0, failures: 0, out });
    return 0;
  }

  mkdirSync(out, { recursive: true, mode: 0o700 });
  if (!statSync(out).isDirectory()) throw usageError(`--out ${out} is not a directory`);
  if ((statSync(out).mode & 0o077) !== 0) console.error(`gmh: warning — ${out} is group/world accessible; exported mail is private data (chmod 700 it)`);
  console.error(`gmh: exporting ${plan.todo.length} message(s) to ${out} (${plan.skipped.length} already present) — exported mail is private data; keep it out of repos and shared folders`);
  if (index.malformed) console.error(`gmh: ${index.malformed} malformed line(s) in index.jsonl ignored`);
  if (more) console.error(`gmh: the query matched MORE than --max ${cli.max} (Gmail estimates ~${estimate}); only the first ${cli.max} are exported — raise --max (ceiling ${MAX_MESSAGES}) or split the query by date`);

  let exported = 0;
  let failed = 0;
  let bytes = 0;
  let consecutive = 0;
  let fatal = null;
  let next = 0;
  const appendIndex = (rec) => appendFileSync(indexPath, `${JSON.stringify(rec)}\n`, { mode: 0o600 });

  async function one(id) {
    try {
      const m = await gmailGet(session, `/messages/${id}?format=raw`);
      if (m.id !== id) throw new GmhError(`Gmail answered for id ${m.id}, not ${id}`, { fatal: false });
      const buf = decodeRaw(m.raw);
      const file = path.join(out, `${id}.eml`);
      const tmp = `${file}.part`;
      writeFileSync(tmp, buf, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      appendIndex({
        id, threadId: m.threadId, labelIds: m.labelIds ?? [], internalDate: m.internalDate,
        sizeEstimate: m.sizeEstimate, historyId: m.historyId, sha256: sha256(buf), bytes: buf.length,
        exported_at: new Date().toISOString(),
      });
      exported++;
      bytes += buf.length;
      consecutive = 0;
      if ((exported + failed) % 100 === 0) console.error(`gmh: ${exported + failed}/${plan.todo.length} done (${failed} failed)`);
    } catch (e) {
      if (e instanceof GmhError && e.fatal) { fatal ??= e; return; }
      appendIndex({ id, error: e.message, failed_at: new Date().toISOString() });
      failed++;
      consecutive++;
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, plan.todo.length) }, async () => {
    while (next < plan.todo.length && !fatal && consecutive < BREAKER) await one(plan.todo[next++]);
  });
  await Promise.all(workers);
  const notAttempted = plan.todo.length - exported - failed;

  const summary = {
    account, out, ...source, matched: ids.length, more_matched: more, exported, skipped: plan.skipped.length,
    failed, not_attempted: notAttempted, bytes,
  };
  audit({ verb: 'export', account, ...source, count: exported, bytes, failures: failed, skipped: plan.skipped.length, not_attempted: notAttempted || undefined, out, result: fatal ? 'aborted' : 'done' });
  if (cli.json) console.log(JSON.stringify(summary));
  else {
    console.log(`exported ${exported} · skipped ${plan.skipped.length} (already present) · failed ${failed}${notAttempted ? ` · NOT ATTEMPTED ${notAttempted}` : ''} · ${bytes} bytes → ${out}`);
    if (!ids.length) console.log(`0 messages matched — spam and trash are excluded; check ${cli.query ? 'the query in the Gmail web UI' : 'the ids file'} before concluding there is no such mail`);
  }
  if (fatal) throw fatal;
  if (consecutive >= BREAKER) console.error(`gmh: stopped after ${BREAKER} consecutive failures; failures are in index.jsonl as {id, error}; re-run the same command to resume`);
  if (failed) console.error(`gmh: ${failed} message(s) failed — recorded in ${indexPath} as {id, error}; re-run the same command to retry them`);
  return failed || notAttempted ? 1 : 0;
}

// ---- links: exact hrefs from one exported message (local, no network) --------
// Agents must not retype URLs out of mail (a token or tracking path changes silently). `links`
// walks the MIME tree itself (no dependency), decodes the HTML part and prints anchor text → href
// exactly as the sender wrote it; plain-text-only mail falls back to bare URLs.

function splitHead(buf) {
  const s = buf.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const body = m ? buf.subarray(Buffer.byteLength(s.slice(0, m.index + m[0].length), 'latin1')) : Buffer.alloc(0);
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(i + 1).trim(); }
  }
  return { headers, body };
}

function param(value, name) {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value ?? '');
  return m ? (m[1] ?? m[2]) : null;
}

export function decodeQuotedPrintable(buf) {
  const s = buf.toString('latin1').replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function decodeText(buf, headers) {
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const bytes = cte === 'base64' ? Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
    : cte === 'quoted-printable' ? decodeQuotedPrintable(buf) : buf;
  const charset = param(headers['content-type'], 'charset') ?? 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** The first text/html and text/plain parts of a raw message (Buffer), decoded to strings. */
export function mimeTexts(buf, depth = 0) {
  const { headers, body } = splitHead(buf);
  const type = (headers['content-type'] ?? 'text/plain').toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(headers['content-type'], 'boundary');
    const out = { html: null, text: null };
    if (!boundary) return out;
    const s = body.toString('latin1');
    for (const chunk of s.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break;
      const part = mimeTexts(Buffer.from(chunk.replace(/^\r?\n/, ''), 'latin1'), depth + 1);
      out.html ??= part.html;
      out.text ??= part.text;
    }
    return out;
  }
  if (/attachment/i.test(headers['content-disposition'] ?? '')) return { html: null, text: null };
  if (type.startsWith('text/html')) return { html: decodeText(body, headers), text: null };
  if (type.startsWith('text/plain')) return { html: null, text: decodeText(body, headers) };
  return { html: null, text: null };
}

const ENTITIES = { amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const unentity = (s) => s.replace(/&(amp|quot|#39|apos|lt|gt|nbsp);/g, (_, e) => ENTITIES[e]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** [{text, href}] for every http(s)/mailto anchor, in document order; bare URLs for text-only mail. */
export function extractLinks(buf) {
  const { html, text } = mimeTexts(buf);
  const links = [];
  if (html) {
    for (const a of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = unentity(a[2].trim());
      if (!/^(https?:|mailto:)/i.test(href)) continue;
      const label = unentity(a[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      links.push({ text: label || '(image)', href });
    }
  } else if (text) {
    for (const u of text.matchAll(/https?:\/\/[^\s<>")]+/g)) links.push({ text: '(plain text)', href: u[0] });
  }
  return links;
}

async function cmdLinks(cli) {
  let buf;
  try { buf = readFileSync(cli.eml); } catch (e) { throw new GmhError(`cannot read ${cli.eml} (${e.code ?? e.message})`); }
  const all = extractLinks(buf);
  const out = cli.match ? all.filter((l) => cli.match.test(l.text) || cli.match.test(l.href)) : all;
  if (cli.json) console.log(JSON.stringify(out));
  else for (const l of out) console.log(`${l.text.slice(0, 60)}\t${l.href}`);
  return 0;
}

// ---- main -------------------------------------------------------------------

function usage() {
  return [
    'usage: gmh auth [--account EMAIL]                  browser consent for gmail.readonly (interactive)',
    '       gmh status [--account EMAIL] [--live] [--json]  token presence, scope, expiry (no network unless --live)',
    '       gmh whoami [--account EMAIL] [--json]       users/me/profile',
    '       gmh list --query Q [--max N] [--json]       message ids + threadIds',
    '       gmh export (--query Q | --ids-file F) --out DIR [--max N] [--explain] [--json]',
    '                                                   raw RFC 822 bytes → DIR/<id>.eml + DIR/index.jsonl; resumable',
    '       gmh links --eml FILE [--match RE] [--json]    exact anchor text → href from one exported message (local, no network)',
    `ceilings: --max default ${DEFAULT_MAX}, ceiling ${MAX_MESSAGES} · concurrency ${CONCURRENCY} · timeout ${TIMEOUT_MS / 1000}s · ${MAX_ATTEMPTS} attempts`,
    `auth: scope ${SCOPE} only · client from Keychain ${KEYCHAIN_SERVICE} (else GOOGLE_OAUTH_CLIENT_ID/_SECRET) · tokens ${TOKEN_DIR}`,
    'no write verbs exist · exit: 0 ok · 1 auth/network/API/per-message failure · 2 bad usage',
  ].join('\n');
}

async function run() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`gmh: ${e.message}\n${usage()}`);
    return 2;
  }
  if (cli.help) { console.log(usage()); return 0; }
  if (cli.version) { console.log(`gmh ${VERSION}`); return 0; }
  try {
    if (cli.verb === 'auth') { await cmdAuth(cli); return 0; }
    if (cli.verb === 'status') return await cmdStatus(cli);
    if (cli.verb === 'whoami') return await cmdWhoami(cli);
    if (cli.verb === 'list') return await cmdList(cli);
    if (cli.verb === 'links') return await cmdLinks(cli);
    return await cmdExport(cli);
  } catch (e) {
    const known = e instanceof GmhError;
    const msg = known ? e.message : `internal: ${e.message}`;
    console.error(`gmh: ${msg}`);
    if (!(known && e.exitCode === 2)) audit({ verb: cli.verb, account: cli.account ?? undefined, result: 'error', error: msg.slice(0, 300) });
    return known ? e.exitCode : 1;
  }
}

// Run only when invoked directly (also through a PATH symlink), so the helpers stay importable.
let direct = false;
try { direct = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === SELF; } catch { /* not a file path */ }
if (direct) run().then((code) => { process.exitCode = code; });
