#!/usr/bin/env node
// exr — the read-only example tool. Reads the public GitHub REST API; nothing else.
//
// This file is the template for a read-only belt tool. Copy the directory, rename the
// verbs, swap the endpoint, keep every pattern. Each pattern is marked with the
// SENSIBILITIES.md number it implements:
//   #1  read-only by construction — every request is GET; there is no write code to misuse
//   #3  ceilings are code constants (MAX_LIMIT, DEFAULT_LIMIT, TIMEOUT_MS), never flags
//   #5  --explain pre-flights: prints the exact request, token redacted, and runs nothing
//   #7  one audit line on stderr per call — verb + target, never the token
//   #8  graceful degradation — rate limit, not-found and network-down each get a plain
//       sentence and an exit code, never a stack trace
//   #11 the token comes from the environment or a 600-mode file outside the tree; a
//       loose-permission file is refused, not read
//
// Usage:
//   exr repo <owner/name>                 stars, forks, open issues, default branch, last push
//   exr releases <owner/name> [--limit N] most recent releases (default 10, ceiling 100)
//   exr search <query> [--limit N]        repositories matching a GitHub search query
//   … --json                              raw API JSON for machines
//   … --explain                           pre-flight: URL + headers, no call made
//
// Auth is optional. Unauthenticated, GitHub allows 60 requests/hour per source IP (10/minute
// on search). A token raises that to 5000/hour. Resolution order:
//   $GITHUB_TOKEN, else ~/.config/exr/token (mode 600 — anything looser is refused).
// The token is never printed, never logged, never placed on argv.
//
// Exit codes: 0 ok · 1 auth, network or API failure · 2 bad usage

import { parseArgs } from 'node:util';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- ceilings (code constants — SENSIBILITIES #3) ---------------------------
// Raising one is a reviewed diff, not an argument an agent can pass on a bad day.
export const MAX_LIMIT = 100;        // hard cap on --limit; also GitHub's own per_page maximum
export const DEFAULT_LIMIT = 10;     // used when --limit is absent
export const TIMEOUT_MS = 20_000;    // per request, enforced locally with AbortController
export const API = 'https://api.github.com';
export const KEY_FILE = path.join(homedir(), '.config', 'exr', 'token');
export const VERBS = ['repo', 'releases', 'search'];
const VERSION = '0.1.0';

function fail(msg, code = 1) {
  console.error(`exr: ${msg}`);
  process.exit(code);
}

// ---- argument parsing (pure, exported for tests) ----------------------------

/**
 * Parse argv (without node and script) into a request description. Throws a usage error
 * (message only) on anything malformed; the caller maps that to exit 2.
 */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string', short: 'n' },
      json: { type: 'boolean', default: false },
      explain: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  if (values.version) return { version: true };
  const [verb, ...rest] = positionals;
  if (!verb) throw new Error('no verb — one of: ' + VERBS.join(', '));
  if (!VERBS.includes(verb)) throw new Error(`unknown verb "${verb}" — one of: ${VERBS.join(', ')}`);
  // search takes the rest of the line as the query so quoting is optional
  const target = verb === 'search' ? rest.join(' ').trim() : rest[0];
  if (!target) throw new Error(verb === 'search' ? 'search needs a query' : `${verb} needs an <owner/name>`);
  if (verb !== 'search') assertRepoRef(target);
  return { verb, target, limit: clampLimit(values.limit), json: values.json, explain: values.explain };
}

/** `owner/name` only — no URL, no path, nothing that could reshape the request. */
export function assertRepoRef(ref) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref)) {
    throw new Error(`"${ref}" is not an <owner/name> — e.g. octocat/Hello-World`);
  }
}

/**
 * --limit: absent → DEFAULT_LIMIT; above MAX_LIMIT → refused (SENSIBILITIES #3). The
 * ceiling is refused rather than silently lowered, so the caller learns the constant exists
 * instead of believing they got what they asked for.
 */
export function clampLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(String(raw))) throw new Error(`--limit must be a positive integer, got "${raw}"`);
  const n = parseInt(raw, 10);
  if (n < 1) throw new Error('--limit must be at least 1');
  if (n > MAX_LIMIT) {
    throw new Error(`--limit ${n} exceeds the ${MAX_LIMIT} ceiling (a code constant in exr.mjs — raising it is a deliberate edit, not a flag)`);
  }
  return n;
}

// ---- credential (SENSIBILITIES #11) -----------------------------------------

/**
 * Token resolution: env first, then the key file. Returns null when neither exists — the
 * tool works unauthenticated, just with a lower rate limit. A group- or world-readable key
 * file is refused outright: reading it would teach the operator that the loose mode is fine.
 * `env` and `keyFile` are injectable so tests never touch the real home directory.
 */
export function resolveToken({ env = process.env, keyFile = KEY_FILE } = {}) {
  const fromEnv = env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (existsSync(keyFile)) {
    const looseBits = statSync(keyFile).mode & 0o077;
    if (looseBits !== 0) {
      throw new Error(`${keyFile} is group/world readable — chmod 600 it first (exr refuses to read a loose-permission key file)`);
    }
    const t = readFileSync(keyFile, 'utf8').trim();
    return t === '' ? null : t;
  }
  return null;
}

// ---- request construction (pure, exported for tests) ------------------------

/** The exact URL and headers a call would send. --explain prints this; the real call sends it. */
export function buildRequest({ verb, target, limit }, token = null) {
  let url;
  if (verb === 'repo') url = `${API}/repos/${target}`;
  else if (verb === 'releases') url = `${API}/repos/${target}/releases?per_page=${limit}`;
  else if (verb === 'search') url = `${API}/search/repositories?q=${encodeURIComponent(target)}&per_page=${limit}`;
  else throw new Error(`unknown verb "${verb}"`);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `exr/${VERSION}`,            // GitHub rejects requests without one
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { url, headers };
}

/** Headers with the credential masked. The only form that may ever reach stdout or stderr. */
export function redactHeaders(headers) {
  const out = { ...headers };
  if (out.Authorization) out.Authorization = out.Authorization.replace(/^(\w+\s+).+$/, '$1***');
  return out;
}

/** The --explain text (SENSIBILITIES #5): what would run, and under which rate limit. */
export function renderExplain(req, { verb, target, limit }, token) {
  const lines = [
    `would GET ${req.url}`,
    ...Object.entries(redactHeaders(req.headers)).map(([k, v]) => `  ${k}: ${v}`),
    `verb=${verb} target=${JSON.stringify(target)}${verb === 'repo' ? '' : ` limit=${limit} (ceiling ${MAX_LIMIT})`}`,
    `auth: ${token ? 'token present — 5000 req/hr' : 'none — unauthenticated, 60 req/hr (10/min on search)'}`,
    `timeout ${TIMEOUT_MS / 1000}s · no call made`,
  ];
  return lines.join('\n');
}

// ---- the one network path ---------------------------------------------------

/**
 * Every verb goes through here, so every verb gets the same audit line, timeout and error
 * vocabulary. Returns parsed JSON on 2xx; exits the process otherwise (CLI semantics).
 */
async function callApi(req, { verb, target }) {
  // SENSIBILITIES #7: one audit line — verb and target, never the token.
  console.error(`[exr] ${new Date().toISOString()} verb=${verb} target=${JSON.stringify(target)}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(req.url, { method: 'GET', headers: req.headers, signal: ac.signal });
  } catch (e) {
    // SENSIBILITIES #8: stop and tell. No retry loop — a network that is down stays down for
    // the seconds a retry would buy, and the operator should know now.
    if (e.name === 'AbortError') fail(`timeout after ${TIMEOUT_MS / 1000}s reaching ${API} — network or proxy problem; nothing was retried`);
    fail(`cannot reach ${API} (${e.cause?.code ?? e.message}) — are you online / is your proxy up?`);
  } finally {
    clearTimeout(timer);
  }

  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if ((res.status === 403 || res.status === 429) && remaining === '0') {
    const at = reset ? new Date(parseInt(reset, 10) * 1000) : null;
    const wait = at ? Math.max(0, Math.ceil((at - Date.now()) / 60_000)) : null;
    fail(`rate limited by GitHub${at ? ` — resets at ${at.toISOString()} (~${wait} min)` : ''}.`
      + (req.headers.Authorization ? '' : ' Unauthenticated calls get 60/hr; set GITHUB_TOKEN or write ~/.config/exr/token (chmod 600) for 5000/hr.'));
  }
  if (res.status === 401) fail('token rejected (HTTP 401) — expired or revoked; unset GITHUB_TOKEN to fall back to unauthenticated reads');
  if (res.status === 404) fail(`not found — or not visible to this principal (HTTP 404). GitHub answers 404 for private repositories you cannot see, so this is not proof the repository does not exist.`);
  if (res.status === 422) fail(`GitHub rejected the request (HTTP 422) — for search, check the query syntax`);
  if (!res.ok) fail(`GitHub HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    fail(`GitHub answered HTTP ${res.status} but not with JSON (${e.message})`);
  }
}

// ---- rendering for humans ---------------------------------------------------

function renderRepo(r) {
  const rows = [
    ['repository', r.full_name],
    ['description', r.description ?? ''],
    ['stars', r.stargazers_count],
    ['forks', r.forks_count],
    ['open issues', r.open_issues_count],
    ['default branch', r.default_branch],
    ['pushed at', r.pushed_at],
    ['archived', r.archived ? 'yes' : 'no'],
    ['url', r.html_url],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v ?? ''}`).join('\n');
}

function renderReleases(list, target) {
  if (!list.length) {
    // SENSIBILITIES #8: empty is a fact about this repository's release habit, not an error.
    return `0 releases for ${target} — the project may publish tags without GitHub releases; \`git ls-remote --tags\` would show those`;
  }
  const lines = list.map((r) => `${(r.tag_name ?? '').padEnd(18)}  ${(r.published_at ?? 'unpublished').slice(0, 10)}  ${r.prerelease ? 'pre-release' : r.draft ? 'draft' : 'release'}  ${r.name && r.name !== r.tag_name ? r.name : ''}`.trimEnd());
  return `${lines.join('\n')}\n\n${list.length} release(s) shown · ${target}`;
}

function renderSearch(body, target, limit) {
  const items = body.items ?? [];
  if (!items.length) return `0 repositories matched ${JSON.stringify(target)} — under this principal's visibility; private repositories never appear unauthenticated`;
  const w = Math.max(...items.map((i) => i.full_name.length));
  const lines = items.map((i) => `${i.full_name.padEnd(w)}  ${String(i.stargazers_count).padStart(7)} ★  ${(i.description ?? '').slice(0, 80)}`);
  const total = body.total_count ?? items.length;
  return `${lines.join('\n')}\n\n${items.length} of ${total} match(es) shown (limit ${limit}, ceiling ${MAX_LIMIT}) · query ${JSON.stringify(target)}`;
}

// ---- main -------------------------------------------------------------------

function usage() {
  return [
    'usage: exr repo <owner/name> [--json] [--explain]',
    '       exr releases <owner/name> [--limit N] [--json] [--explain]',
    '       exr search <query> [--limit N] [--json] [--explain]',
    `ceilings: --limit cap ${MAX_LIMIT} · default ${DEFAULT_LIMIT} · timeout ${TIMEOUT_MS / 1000}s`,
    'auth: optional — $GITHUB_TOKEN, else ~/.config/exr/token (mode 600); unauthenticated = 60 req/hr',
    'exit: 0 ok · 1 auth/network/API failure · 2 bad usage',
  ].join('\n');
}

async function run() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`exr: ${e.message}\n${usage()}`);
    process.exit(2);
  }
  if (cli.help) { console.log(usage()); return; }
  if (cli.version) { console.log(`exr ${VERSION}`); return; }

  let token;
  try {
    token = resolveToken();
  } catch (e) {
    fail(e.message, 1);
  }
  const req = buildRequest(cli, token);

  if (cli.explain) {
    // SENSIBILITIES #5: the pre-flight is the real request, rendered instead of sent.
    console.log(renderExplain(req, cli, token));
    return;
  }

  const body = await callApi(req, cli);

  if (cli.json) { console.log(JSON.stringify(body, null, 2)); return; }
  if (cli.verb === 'repo') console.log(renderRepo(body));
  else if (cli.verb === 'releases') console.log(renderReleases(body, cli.target));
  else console.log(renderSearch(body, cli.target, cli.limit));
}

// Run only when invoked directly, so the pure helpers stay importable by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => fail(`internal: ${e.message}`, 1));
}
