#!/usr/bin/env node
// omh — outlook-harvest. Read-only, byte-exact export of a personal Outlook.com / Hotmail mailbox
// through Microsoft Graph on the operator's own grant (delegated Mail.Read only). Each message's
// MIME bytes (`/messages/{id}/$value`) go straight to <id>.eml with a metadata-only index.jsonl in
// the same shape as gmh's, so gmh/gmf/jev-test consumers read an omh export unchanged.
//
// The patterns, marked with their SENSIBILITIES.md number:
//   #1  read-only by construction — the only Graph permission ever requested is Mail.Read; every
//       Graph request is a GET; a token whose Graph scopes are not exactly {Mail.Read} is refused
//   #3  ceilings are exported code constants
//   #5  `export --explain` pre-flights (lists, counts, writes nothing)
//   #6  tokens in ~/.config/toolbelt/outlook-harvest/<account>.json, dir 700 / file 600, loose
//       permissions refused
//   #7  one audit line per verb run, to stderr and a 600-mode log — counts, never content
//   #8  plain sentences and exit codes
//
// Auth is the OAuth 2.0 device-code flow against the `consumers` authority with a public client
// the operator registered (no secret exists): `omh auth` prints a code; the human enters it at
// microsoft.com/devicelogin on any device (a phone works) and consents to Mail.Read.
//
// Exit codes: 0 ok · 1 auth, network, API or any per-message failure · 2 bad usage

import { parseArgs } from 'node:util';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- ceilings (code constants — SENSIBILITIES #3) ---------------------------
export const MAX_MESSAGES = 5000;
export const DEFAULT_MAX = 500;
export const CONCURRENCY = 4;          // Graph throttles per mailbox; low concurrency stays well under it
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 4;         // 429 / 5xx, honoring Retry-After
export const MAX_RETRY_WAIT_MS = 60_000;
export const BREAKER = 10;             // consecutive per-message failures that stop an export
export const LIST_PAGE = 100;

// ---- fixed endpoints and stores ---------------------------------------------
export const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const GRAPH = 'https://graph.microsoft.com/v1.0/me';
export const GRAPH_SCOPE = 'Mail.Read';
export const REQUEST_SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access openid profile';
const OIDC = new Set(['openid', 'profile', 'email', 'offline_access']);
export const CONF_DIR = path.join(homedir(), '.config', 'toolbelt', 'outlook-harvest');
export const CLIENT_FILE = path.join(CONF_DIR, 'client.json');
export const AUDIT_DIR = path.join(homedir(), '.local', 'share', 'toolbelt', 'outlook-harvest');
export const AUDIT_LOG = path.join(AUDIT_DIR, 'audit.log');
export const VERBS = ['auth', 'status', 'whoami', 'list', 'export'];
const VERSION = '0.1.0';
const SELF = realpathSync(fileURLToPath(import.meta.url));
const BELT_ROOT = path.resolve(path.dirname(SELF), '..', '..');
const ACCOUNT_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const CLIENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class OmhError extends Error {
  constructor(message, { code = 1, fatal = true, status } = {}) {
    super(message);
    this.exitCode = code;
    this.fatal = fatal;
    this.status = status;
  }
}
const usageError = (msg) => new OmhError(msg, { code: 2 });

// ---- argument parsing (pure) -------------------------------------------------

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: 'string', short: 'a' },
        'client-id': { type: 'string' },
        folder: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        search: { type: 'string' },
        max: { type: 'string', short: 'n' },
        out: { type: 'string', short: 'o' },
        json: { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
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
  if (!VERBS.includes(verb)) throw usageError(`unknown verb "${verb}" — one of: ${VERBS.join(', ')} (omh has no write verbs)`);
  if (extra.length) throw usageError(`unexpected argument "${extra[0]}"`);
  const allowed = {
    auth: ['client-id'],
    status: ['account', 'json'],
    whoami: ['account', 'json'],
    list: ['account', 'folder', 'since', 'until', 'search', 'max', 'json'],
    export: ['account', 'folder', 'since', 'until', 'search', 'max', 'out', 'explain', 'json'],
  }[verb];
  for (const k of ['account', 'client-id', 'folder', 'since', 'until', 'search', 'max', 'out', 'explain', 'json']) {
    const set = v[k] !== undefined && v[k] !== false;
    if (set && !allowed.includes(k)) throw usageError(`--${k} does not apply to ${verb}`);
  }
  const cli = { verb, json: v.json, explain: v.explain };
  cli.account = v.account === undefined ? null : assertAccount(v.account);
  if (v['client-id'] !== undefined) {
    if (!CLIENT_RE.test(v['client-id'])) throw usageError('--client-id must be the Application (client) ID GUID from the app registration');
    cli.clientId = v['client-id'].toLowerCase();
  }
  if (verb === 'list' || verb === 'export') {
    cli.max = clampMax(v.max);
    for (const k of ['since', 'until']) if (v[k] !== undefined && !DATE_RE.test(v[k])) throw usageError(`--${k} must be YYYY-MM-DD`);
    if (v.search !== undefined && (v.since || v.until)) throw usageError('--search cannot be combined with --since/--until (Graph does not allow $search with $filter); pick one');
    cli.folder = v.folder ?? 'all';
    cli.since = v.since ?? null;
    cli.until = v.until ?? null;
    cli.search = v.search ?? null;
  }
  if (verb === 'export') {
    if (!v.out) throw usageError('export needs --out <dir> (a private directory outside the Toolbelt tree)');
    cli.out = v.out;
  }
  return cli;
}

export function clampMax(raw) {
  if (raw === undefined) return DEFAULT_MAX;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) throw usageError(`--max must be a positive integer, got "${raw}"`);
  const n = Number(raw);
  if (n > MAX_MESSAGES) throw usageError(`--max ${n} is above the ceiling of ${MAX_MESSAGES} (MAX_MESSAGES, a code constant) — split the window`);
  return n;
}

export function assertAccount(raw) {
  const a = String(raw).trim().toLowerCase();
  if (!ACCOUNT_RE.test(a)) throw usageError(`"${raw}" is not an email address`);
  return a;
}

// ---- scopes and tokens (SENSIBILITIES #1, #6) --------------------------------

/** The Graph permissions in a token's scope string, prefix-stripped and lowercased; OIDC scopes ignored. */
export function graphScopes(scope) {
  return new Set(String(scope ?? '').split(/\s+/).filter(Boolean)
    .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase())
    .filter((s) => !OIDC.has(s)));
}

export function assertScopeExact(scope) {
  const g = graphScopes(scope);
  if (g.size !== 1 || !g.has(GRAPH_SCOPE.toLowerCase())) {
    throw new OmhError(`granted Graph permissions are {${[...g].join(', ')}}, not exactly {${GRAPH_SCOPE}} — refused; remove extra permissions from the app registration and re-run \`omh auth\``);
  }
}

/** The account label from an id_token (TLS-delivered by the token endpoint; used only to name the file). */
export function accountFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return assertAccount(payload.preferred_username ?? payload.email ?? '');
  } catch {
    throw new OmhError('the sign-in returned no usable account name (id_token preferred_username) — re-run `omh auth`');
  }
}

export const tokenPath = (account, dir = CONF_DIR) => path.join(dir, `${assertAccount(account)}.json`);

export function readPrivateJson(file, what) {
  if (!existsSync(file)) throw new OmhError(`no ${what} at ${file} — run \`omh auth\` first`);
  const mode = statSync(file).mode;
  if ((mode & 0o077) !== 0) throw new OmhError(`${file} is group/world readable (mode ${(mode & 0o777).toString(8)}) — chmod 600 it first`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new OmhError(`${file} is not valid JSON (${e.message})`); }
}

export function writePrivateJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function listAccounts(dir = CONF_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSafe(dir).filter((f) => f.endsWith('.json') && f !== 'client.json').map((f) => f.slice(0, -5)).filter((a) => ACCOUNT_RE.test(a));
}
function readdirSafe(dir) { try { return readdirSync(dir); } catch { return []; } }

export function pickAccount(account, dir = CONF_DIR) {
  if (account) return account;
  const all = listAccounts(dir);
  if (all.length === 1) return all[0];
  if (!all.length) throw new OmhError('no authorized account — run `omh auth --client-id <id>` first');
  throw usageError(`several accounts are authorized (${all.join(', ')}) — pass --account`);
}

export function resolveClientId(cli, { env = process.env, file = CLIENT_FILE } = {}) {
  if (cli.clientId) return cli.clientId;
  if (env.OUTLOOK_CLIENT_ID) {
    if (!CLIENT_RE.test(env.OUTLOOK_CLIENT_ID)) throw usageError('OUTLOOK_CLIENT_ID is not a GUID');
    return env.OUTLOOK_CLIENT_ID.toLowerCase();
  }
  if (existsSync(file)) return readPrivateJson(file, 'client file').client_id;
  throw usageError('no client id — pass `omh auth --client-id <Application (client) ID>` once (it is saved), or set OUTLOOK_CLIENT_ID');
}

// ---- HTTP -----------------------------------------------------------------------

export function retryDelayMs(attempt, retryAfter = null, { now = Date.now(), rand = Math.random } = {}) {
  if (retryAfter != null && retryAfter !== '') {
    const s = Number(retryAfter);
    const ms = Number.isFinite(s) ? s * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms)) return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, ms));
  }
  return Math.min(MAX_RETRY_WAIT_MS, 1000 * 2 ** (attempt - 1) + Math.floor(rand() * 250));
}
export const isRetryable = (status) => status === 429 || status >= 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postForm(url, form) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error */ }
  return { status: res.status, body };
}

/** GET a Graph URL with the bearer token; retries 429/5xx; returns Response. Only GETs exist. */
async function graphGet(url, token, { accept = 'application/json' } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: accept, Prefer: 'IdType="ImmutableId"' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw new OmhError(`network: ${e.message}`, { fatal: false });
      await sleep(retryDelayMs(attempt));
      continue;
    }
    if (res.ok) return res;
    if (res.status === 401) throw new OmhError('Graph refused the token (401) — run `omh auth` again');
    if (isRetryable(res.status) && attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt, res.headers.get('retry-after'))); continue; }
    let msg = '';
    try { msg = (await res.json())?.error?.message ?? ''; } catch { /* ignore */ }
    throw new OmhError(`Graph ${res.status}${msg ? `: ${msg}` : ''}`, { fatal: res.status === 403, status: res.status });
  }
}

// ---- auth: device code ----------------------------------------------------------

async function cmdAuth(cli) {
  const clientId = resolveClientId(cli);
  if (cli.clientId) writePrivateJson(CLIENT_FILE, { client_id: clientId }); // public id, not a secret: keep it even if sign-in fails
  let start;
  for (let attempt = 1; ; attempt++) {
    try { start = await postForm(`${AUTHORITY}/devicecode`, { client_id: clientId, scope: REQUEST_SCOPE }); break; } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw new OmhError(`cannot reach ${AUTHORITY} (${e.cause?.code ?? e.message}) — check the network and re-run`);
      await sleep(retryDelayMs(attempt));
    }
  }
  if (start.status !== 200 || !start.body.device_code) {
    throw new OmhError(`device-code request refused (${start.status} ${start.body.error ?? ''}: ${String(start.body.error_description ?? '').split('\n')[0]}) — check the app registration allows public client flows and personal accounts`);
  }
  console.error(`\n${start.body.message}\n(omh waits up to ${Math.round(start.body.expires_in / 60)} min; consent grants Mail.Read only)\n`);
  const deadline = Date.now() + start.body.expires_in * 1000;
  let interval = (start.body.interval ?? 5) * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new OmhError('the device code expired before sign-in finished — run `omh auth` again');
    await sleep(interval);
    let r;
    try {
      r = await postForm(`${AUTHORITY}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: start.body.device_code });
    } catch (e) {
      // a dropped connection while the human is still signing in is not a failure: keep polling
      // until the code expires (flaky networks — hotel or ship Wi-Fi — drop single requests)
      console.error(`omh: network hiccup while waiting for sign-in (${e.cause?.code ?? e.message}); still waiting`);
      continue;
    }
    if (r.status === 200) {
      assertScopeExact(r.body.scope);
      const account = accountFromIdToken(r.body.id_token);
      writePrivateJson(tokenPath(account), {
        account, client_id: clientId, scope: r.body.scope, access_token: r.body.access_token, refresh_token: r.body.refresh_token,
        expiry: new Date(Date.now() + (r.body.expires_in - 60) * 1000).toISOString(), consented_at: new Date().toISOString(),
      });
      writePrivateJson(CLIENT_FILE, { client_id: clientId });
      audit({ verb: 'auth', account, result: 'ok' });
      console.log(`authorized ${account} · Graph scope ${GRAPH_SCOPE} only · token ${tokenPath(account)} (600)`);
      return 0;
    }
    const err = r.body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    throw new OmhError(`sign-in did not complete: ${err ?? r.status} ${String(r.body.error_description ?? '').split('\n')[0]}`);
  }
}

/** A valid access token for `account`, refreshing (and re-checking scope) when expired. */
export async function accessToken(account) {
  const file = tokenPath(account);
  const tok = readPrivateJson(file, 'token');
  assertScopeExact(tok.scope);
  if (tok.expiry && Date.parse(tok.expiry) > Date.now()) return tok.access_token;
  const r = await postForm(`${AUTHORITY}/token`, { grant_type: 'refresh_token', client_id: tok.client_id, refresh_token: tok.refresh_token, scope: REQUEST_SCOPE });
  if (r.status !== 200) throw new OmhError(`token refresh refused (${r.body.error ?? r.status}) — run \`omh auth\` again`);
  assertScopeExact(r.body.scope);
  writePrivateJson(file, { ...tok, scope: r.body.scope, access_token: r.body.access_token, refresh_token: r.body.refresh_token ?? tok.refresh_token, expiry: new Date(Date.now() + (r.body.expires_in - 60) * 1000).toISOString() });
  return r.body.access_token;
}

// ---- selection --------------------------------------------------------------------

const WELL_KNOWN = new Set(['inbox', 'junkemail', 'deleteditems', 'sentitems', 'drafts', 'archive']);

/** The first page URL for a selection. Pure (exported for tests). */
export function listUrl({ folder = 'all', since = null, until = null, search = null }, page = LIST_PAGE) {
  const f = String(folder).toLowerCase();
  if (f !== 'all' && !WELL_KNOWN.has(f)) throw usageError(`--folder must be all or one of ${[...WELL_KNOWN].join(', ')}`);
  const base = f === 'all' ? `${GRAPH}/messages` : `${GRAPH}/mailFolders/${f}/messages`;
  const q = new URLSearchParams({ $select: 'id,conversationId,receivedDateTime,parentFolderId,webLink', $top: String(page) });
  if (search) q.set('$search', `"${search.replace(/"/g, '')}"`);
  else {
    const parts = [];
    if (since) parts.push(`receivedDateTime ge ${since}T00:00:00Z`);
    if (until) parts.push(`receivedDateTime lt ${until}T00:00:00Z`);
    if (parts.length) q.set('$filter', parts.join(' and '));
    q.set('$orderby', 'receivedDateTime desc');
  }
  return `${base}?${q}`;
}

/** File-safe, case-insensitive-safe id for a Graph id (Graph ids are long, base64, case-sensitive). */
export const fileId = (graphId) => createHash('sha256').update(graphId).digest('hex').slice(0, 24);
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function listIds(token, sel, max) {
  const out = [];
  let url = listUrl(sel);
  let pages = 0;
  while (url && out.length < max) {
    const res = await graphGet(url, token);
    const body = await res.json();
    pages++;
    for (const m of body.value ?? []) {
      out.push(m);
      if (out.length >= max) break;
    }
    url = body['@odata.nextLink'] ?? null;
  }
  return { messages: out, more: Boolean(url), pages };
}

async function folderNames(token) {
  const names = new Map();
  let url = `${GRAPH}/mailFolders?$top=100&$select=id,displayName`;
  while (url) {
    const body = await (await graphGet(url, token)).json();
    for (const f of body.value ?? []) names.set(f.id, f.displayName);
    url = body['@odata.nextLink'] ?? null;
  }
  return names;
}

// ---- export helpers ---------------------------------------------------------------

export function readIndex(text) {
  const records = new Map();
  let malformed = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.id === 'string') records.set(r.id, r); else malformed++; } catch { malformed++; }
  }
  return { records, malformed };
}

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

export function checkOutDir(dir, { home = homedir(), roots = beltRoots(), cwd = process.cwd() } = {}) {
  const abs = path.resolve(cwd, String(dir).replace(/^~(?=$|\/)/, home));
  const real = realpathNearest(abs);
  const realHome = realpathNearest(path.resolve(home));
  if (real === path.parse(real).root) throw usageError('--out / refused — name a dedicated directory for the export');
  if (real === realHome) throw usageError('--out is your home directory itself — name a dedicated subdirectory');
  for (const r of roots) {
    const rr = realpathNearest(path.resolve(r));
    if (real === rr || real.startsWith(rr + path.sep)) throw usageError(`--out ${abs} is inside the Toolbelt tree (${r}) — exported mail is private data and never lands in the belt`);
  }
  return abs;
}
function realpathNearest(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try { return path.join(realpathSync(cur), ...tail); } catch {
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

// ---- audit (SENSIBILITIES #7) ------------------------------------------------------

export function auditLine(fields, now = new Date()) {
  const parts = [`[omh audit] ${now.toISOString()}`];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) parts.push(`${k}=${typeof v === 'number' ? v : JSON.stringify(String(v))}`);
  return parts.join(' ');
}
function audit(fields) {
  const line = auditLine(fields);
  console.error(line);
  try {
    mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(AUDIT_LOG, `${line}\n`, { mode: 0o600 });
    chmodSync(AUDIT_LOG, 0o600);
  } catch (e) {
    console.error(`omh: could not append to ${AUDIT_LOG} (${e.message})`);
  }
}

// ---- verbs --------------------------------------------------------------------------

async function cmdStatus(cli) {
  const accounts = cli.account ? [cli.account] : listAccounts();
  const rows = accounts.map((a) => {
    const file = tokenPath(a);
    try {
      const t = readPrivateJson(file, 'token');
      return { account: a, file, mode: (statSync(file).mode & 0o777).toString(8), scope: [...graphScopes(t.scope)].join(' '), refresh: Boolean(t.refresh_token), access: Date.parse(t.expiry) > Date.now() ? 'valid' : 'expired (refreshes on next call)', consented_at: t.consented_at };
    } catch (e) {
      return { account: a, file, error: e.message };
    }
  });
  const client = existsSync(CLIENT_FILE) ? 'saved' : process.env.OUTLOOK_CLIENT_ID ? 'environment' : 'missing — omh auth --client-id <id>';
  audit({ verb: 'status', count: rows.length });
  if (cli.json) console.log(JSON.stringify({ client, accounts: rows }));
  else {
    console.log(`omh ${VERSION} — read-only: Graph permission ${GRAPH_SCOPE} only; no write code exists`);
    console.log(`client     ${client}`);
    if (!rows.length) console.log('accounts   none — run `omh auth --client-id <id>`');
    for (const r of rows) console.log(r.error ? `account    ${r.account}  ERROR ${r.error}` : `account    ${r.account}  (${r.file}, mode ${r.mode})\n  scope    ${r.scope}\n  access   ${r.access}\n  refresh  ${r.refresh ? 'present' : 'MISSING'}\n  consent  ${r.consented_at}`);
  }
  return 0;
}

async function cmdWhoami(cli) {
  const account = pickAccount(cli.account);
  const token = await accessToken(account);
  const body = await (await graphGet(`${GRAPH}/mailFolders?$top=100&$select=displayName,totalItemCount,unreadItemCount`, token)).json();
  const folders = (body.value ?? []).map((f) => ({ name: f.displayName, total: f.totalItemCount, unread: f.unreadItemCount }));
  audit({ verb: 'whoami', account, folders: folders.length });
  if (cli.json) console.log(JSON.stringify({ account, folders }));
  else {
    console.log(`account ${account} · ${folders.reduce((s, f) => s + (f.total ?? 0), 0)} messages in ${folders.length} top-level folders`);
    for (const f of folders) console.log(`  ${String(f.name).padEnd(22)} ${String(f.total).padStart(7)}  (${f.unread} unread)`);
  }
  return 0;
}

async function cmdList(cli) {
  const account = pickAccount(cli.account);
  const token = await accessToken(account);
  const { messages, more } = await listIds(token, cli, cli.max);
  audit({ verb: 'list', account, folder: cli.folder, since: cli.since ?? undefined, until: cli.until ?? undefined, search: cli.search ?? undefined, count: messages.length });
  if (cli.json) console.log(JSON.stringify({ account, count: messages.length, more_matched: more, messages: messages.map((m) => ({ id: fileId(m.id), graph_id: m.id, conversationId: m.conversationId, receivedDateTime: m.receivedDateTime })) }));
  else {
    for (const m of messages) console.log(`${fileId(m.id)}\t${m.receivedDateTime}`);
    if (more) console.error(`omh: more messages matched than --max ${cli.max}; raise --max (ceiling ${MAX_MESSAGES}) or narrow the window`);
  }
  return 0;
}

async function cmdExport(cli) {
  const out = checkOutDir(cli.out);
  const account = pickAccount(cli.account);
  const token = await accessToken(account);
  const { messages, more, pages } = await listIds(token, cli, cli.max);
  const indexPath = path.join(out, 'index.jsonl');
  const { records } = existsSync(indexPath) ? readIndex(readFileSync(indexPath, 'utf8')) : { records: new Map() };
  const byFile = new Map(messages.map((m) => [fileId(m.id), m]));
  const sizeOf = (id) => { try { return statSync(path.join(out, `${id}.eml`)).size; } catch { return null; } };
  const plan = resumePlan([...byFile.keys()], records, sizeOf);
  if (cli.explain) {
    console.log([
      'omh export --explain — pre-flight: no message bodies fetched, nothing written',
      `account    ${account} · Graph permission ${GRAPH_SCOPE} (read-only)`,
      `selection  folder=${cli.folder}${cli.since ? ` since=${cli.since}` : ''}${cli.until ? ` until=${cli.until}` : ''}${cli.search ? ` search="${cli.search}"` : ''} → ${messages.length}${more ? '+' : ''} match(es)`,
      `ceiling    --max ${cli.max} (default ${DEFAULT_MAX}, hard ceiling MAX_MESSAGES ${MAX_MESSAGES})`,
      `out        ${out}${existsSync(out) ? '' : ' (would be created, mode 700)'}`,
      `resume     ${plan.skipped.length} already exported (skipped) · ${plan.todo.length} to fetch`,
      `calls      ${pages} list page(s) spent on this pre-flight · ${plan.todo.length} $value GETs`,
    ].join('\n'));
    audit({ verb: 'export', mode: 'explain', account, count: messages.length, out });
    return 0;
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const folders = await folderNames(token);
  let exported = 0;
  let failed = 0;
  let bytes = 0;
  let consecutive = 0;
  let next = 0;
  let stopped = false;
  const one = async (id) => {
    const m = byFile.get(id);
    try {
      const res = await graphGet(`${GRAPH}/messages/${encodeURIComponent(m.id)}/$value`, token, { accept: 'message/rfc822, */*' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new OmhError('empty MIME body', { fatal: false });
      const file = path.join(out, `${id}.eml`);
      writeFileSync(`${file}.part`, buf, { mode: 0o600 });
      renameSync(`${file}.part`, file);
      appendFileSync(indexPath, `${JSON.stringify({ id, graph_id: m.id, threadId: m.conversationId, labelIds: [folders.get(m.parentFolderId) ?? m.parentFolderId], internalDate: String(Date.parse(m.receivedDateTime)), sha256: sha256(buf), bytes: buf.length, source_link: m.webLink, exported_at: new Date().toISOString() })}\n`, { mode: 0o600 });
      exported++;
      bytes += buf.length;
      consecutive = 0;
    } catch (e) {
      if (e instanceof OmhError && e.fatal && e.status !== 404) throw e;
      appendFileSync(indexPath, `${JSON.stringify({ id, graph_id: m.id, error: String(e.message).slice(0, 300), failed_at: new Date().toISOString() })}\n`, { mode: 0o600 });
      failed++;
      if (++consecutive >= BREAKER) stopped = true;
    }
    if ((exported + failed) % 100 === 0) console.error(`omh: ${exported + failed}/${plan.todo.length} done (${failed} failed)`);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (!stopped && next < plan.todo.length) await one(plan.todo[next++]);
  }));
  const notAttempted = plan.todo.length - exported - failed;
  audit({ verb: 'export', account, count: messages.length, bytes, failures: failed, skipped: plan.skipped.length, out, result: stopped ? 'stopped' : 'done' });
  const summary = { account, out, matched: messages.length, more_matched: more, exported, skipped: plan.skipped.length, failed, not_attempted: notAttempted, bytes };
  if (cli.json) console.log(JSON.stringify(summary));
  else console.log(`exported ${exported} · skipped ${plan.skipped.length} (already present) · failed ${failed}${notAttempted ? ` · NOT ATTEMPTED ${notAttempted}` : ''} · ${bytes} bytes → ${out}`);
  if (stopped) console.error(`omh: stopped after ${BREAKER} consecutive failures; re-run the same command to resume`);
  if (more) console.error(`omh: more messages matched than --max ${cli.max}; re-run with a higher --max or a narrower window`);
  return failed || notAttempted ? 1 : 0;
}

function usage() {
  return [
    'usage: omh auth [--client-id GUID]                 device-code sign-in (Mail.Read only); the client id is saved once',
    '       omh status [--account EMAIL] [--json]        token presence, mode, scope, expiry (no network)',
    '       omh whoami [--account EMAIL] [--json]        folder totals',
    '       omh list [--folder F] [--since D] [--until D | --search Q] [--max N] [--json]',
    '       omh export [selection] --out DIR [--max N] [--explain] [--json]',
    '                                                   MIME bytes → DIR/<id>.eml + DIR/index.jsonl (gmh-compatible); resumable',
    `folders: all (default) | ${[...WELL_KNOWN].join(' | ')} · dates YYYY-MM-DD (UTC) · --search is Graph KQL and excludes --since/--until`,
    `ceilings: --max default ${DEFAULT_MAX}, ceiling ${MAX_MESSAGES} · concurrency ${CONCURRENCY} · timeout ${TIMEOUT_MS / 1000}s · ${MAX_ATTEMPTS} attempts`,
    `stores: ${CONF_DIR.replace(homedir(), '~')} (600) · audit ${AUDIT_LOG.replace(homedir(), '~')}`,
    'no write verbs exist · exit: 0 ok · 1 auth/network/API/per-message failure · 2 bad usage',
  ].join('\n');
}

async function run() {
  let cli;
  try { cli = parseCli(process.argv.slice(2)); } catch (e) { console.error(`omh: ${e.message}\n${usage()}`); return 2; }
  if (cli.help) { console.log(usage()); return 0; }
  if (cli.version) { console.log(`omh ${VERSION}`); return 0; }
  try {
    if (cli.verb === 'auth') return await cmdAuth(cli);
    if (cli.verb === 'status') return await cmdStatus(cli);
    if (cli.verb === 'whoami') return await cmdWhoami(cli);
    if (cli.verb === 'list') return await cmdList(cli);
    return await cmdExport(cli);
  } catch (e) {
    const known = e instanceof OmhError;
    const msg = known ? e.message : `internal: ${e.message}`;
    console.error(`omh: ${msg}`);
    if (!(known && e.exitCode === 2)) audit({ verb: cli.verb, result: 'error', error: msg.slice(0, 300) });
    return known ? e.exitCode : 1;
  }
}

let direct = false;
try { direct = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === SELF; } catch { /* not a file path */ }
if (direct) run().then((code) => { process.exitCode = code; });
