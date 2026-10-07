/**
 * Firecrawl client — the one network path for every verb in this tool.
 *
 * Design rules:
 *   - Every request is a paid call against the operator's own Firecrawl account, so every
 *     request writes one audit line to stderr (SENSIBILITIES #7): timestamp, verb, target,
 *     HTTP status, result size — never the key, never the body.
 *   - Ceilings are code constants (SENSIBILITIES #3). A request above one is refused with the
 *     constant named, never silently lowered.
 *   - The key comes from $FIRECRAWL_API_KEY, a 600-mode key file, or the macOS Keychain
 *     (SENSIBILITIES #6, #11). A loose-permission key file is refused. No function returns it
 *     to a caller that could print it; `redactHeaders` is the only form that reaches stdout.
 *   - Throws on error (callers decide exit codes). No console.log.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export const BASE_URL = 'https://api.firecrawl.dev/v2';
export const VERSION = '0.2.0';

// ---- ceilings (code constants — SENSIBILITIES #3) ---------------------------
// Raising one is a reviewed diff, not an argument an agent can pass on a bad day.
export const MAX_SEARCH_LIMIT = 20;     // results per search; Firecrawl bills per result
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_BATCH_URLS = 20;       // URLs per batch; each is one scrape credit
export const MAX_CRAWL_PAGES = 50;      // hard page ceiling on crawl — sent server-side as `limit` AND enforced client-side
export const DEFAULT_CRAWL_PAGES = 10;
export const MIN_DELAY_MS = 1000;       // floor between sequential scrapes; the Hobby plan answers 402 below ~1.5s
export const DEFAULT_DELAY_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const CRAWL_POLL_MS = 3000;
export const CRAWL_WAIT_MS = 300_000;   // give up waiting on a crawl after 5 minutes; the job keeps its id

export const KEY_FILE = path.join(homedir(), '.config', 'toolbelt', 'firecrawl.key');
export const KEYCHAIN_SERVICE = 'toolbelt-firecrawl';

// ---- credential (SENSIBILITIES #6, #11) -------------------------------------

/**
 * Where the key would come from, without reading it: 'env' | 'file' | 'keychain' | null.
 * `status` reports this; nothing reports the value.
 */
export function keySource({ env = process.env, keyFile = KEY_FILE, keychain = readKeychain } = {}) {
  if (env.FIRECRAWL_API_KEY && env.FIRECRAWL_API_KEY.trim() !== '') return 'env';
  if (existsSync(keyFile)) return 'file';
  if (keychain(false) !== null) return 'keychain';
  return null;
}

/**
 * Key resolution: env, then the key file, then the Keychain. A group- or world-readable key
 * file is refused outright: reading it would teach the operator that the loose mode is fine.
 * `env`, `keyFile` and `keychain` are injectable so tests never touch the real home or Keychain.
 */
export function resolveKey({ env = process.env, keyFile = KEY_FILE, keychain = readKeychain } = {}) {
  const fromEnv = env.FIRECRAWL_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (existsSync(keyFile)) {
    const looseBits = statSync(keyFile).mode & 0o077;
    if (looseBits !== 0) {
      throw new Error(`${keyFile} is group/world readable — chmod 600 it first (fc refuses to read a loose-permission key file)`);
    }
    const k = readFileSync(keyFile, 'utf8').trim();
    if (k !== '') return k;
  }
  const fromKeychain = keychain(true);
  if (fromKeychain) return fromKeychain;
  throw new Error(`no Firecrawl key — export FIRECRAWL_API_KEY, write it to ${keyFile} (chmod 600), or: security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w`);
}

/** macOS Keychain lookup. `withValue=false` only tests presence (exit status), never reads the secret. */
export function readKeychain(withValue) {
  if (process.platform !== 'darwin') return null;
  try {
    const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE];
    if (withValue) args.push('-w');
    const out = execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return withValue ? out.trim() || null : '';
  } catch {
    return null;
  }
}

// ---- request construction (pure, exported for tests) ------------------------

/** The exact request a call would send. --explain prints it redacted; the real call sends it. */
export function buildRequest(method, endpoint, body, key) {
  return {
    method,
    url: `${BASE_URL}${endpoint}`,
    headers: {
      Authorization: `Bearer ${key ?? ''}`,
      'Content-Type': 'application/json',
      'User-Agent': `toolbelt-fc/${VERSION}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** Headers with the credential masked. The only form that may ever reach stdout or stderr. */
export function redactHeaders(headers) {
  const out = { ...headers };
  if (out.Authorization) out.Authorization = out.Authorization.replace(/^(\w+\s+).*$/, '$1***');
  return out;
}

/** The audit line (SENSIBILITIES #7). Pure so the test can pin its shape. */
export function auditLine({ verb, target, status, size, ms }) {
  return `[fc] ${new Date().toISOString()} verb=${verb} target=${JSON.stringify(target)} status=${status} size=${size} ms=${ms}`;
}

// ---- the one network path ---------------------------------------------------

let auditSink = (line) => process.stderr.write(line + '\n');
/** Tests replace the sink; the CLI never does. */
export function setAuditSink(fn) { auditSink = fn; }

async function request(method, endpoint, body, { apiKey, timeoutMs, verb, target }) {
  const key = apiKey || resolveKey();
  const req = buildRequest(method, endpoint, body, key);
  const started = Date.now();
  let response;
  try {
    response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    auditSink(auditLine({ verb, target, status: e.name === 'TimeoutError' ? 'timeout' : 'network-error', size: 0, ms: Date.now() - started }));
    throw e;
  }
  const text = await response.text();
  auditSink(auditLine({ verb, target, status: response.status, size: text.length, ms: Date.now() - started }));

  if (!response.ok) {
    const hint = {
      401: 'key rejected — expired, revoked, or not an fc-… key',
      402: 'Firecrawl answered 402 — either the account is out of credits or you are sending scrapes faster than the plan allows (the Hobby plan reports rate limiting as 402); slow down before topping up',
      429: 'rate limited — back off; fc does not retry',
    }[response.status];
    throw new Error(`Firecrawl ${response.status}${hint ? ` (${hint})` : ''}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Firecrawl answered HTTP ${response.status} but not with JSON`);
  }
}

// ---- ceilings as checks (pure, exported for tests) --------------------------

function checkCeiling(name, value, max, constant) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  if (value > max) throw new Error(`${name} ${value} exceeds the ${max} ceiling (${constant} in lib/firecrawl.js — raising it is a deliberate edit, not a flag)`);
}

export function checkSearchLimit(limit) { checkCeiling('limit', limit, MAX_SEARCH_LIMIT, 'MAX_SEARCH_LIMIT'); return limit ?? DEFAULT_SEARCH_LIMIT; }
export function checkCrawlPages(limit) { checkCeiling('limit', limit, MAX_CRAWL_PAGES, 'MAX_CRAWL_PAGES'); return limit ?? DEFAULT_CRAWL_PAGES; }
export function checkBatchSize(urls) { checkCeiling('url count', urls.length, MAX_BATCH_URLS, 'MAX_BATCH_URLS'); return urls; }
export function checkDelay(delay) {
  if (delay === undefined) return DEFAULT_DELAY_MS;
  if (!Number.isInteger(delay) || delay < MIN_DELAY_MS) throw new Error(`delay ${delay}ms is below the ${MIN_DELAY_MS}ms floor (MIN_DELAY_MS in lib/firecrawl.js)`);
  return delay;
}

export function assertHttpUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`"${url}" is not a URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`"${url}" is not an http(s) URL`);
  return u.href;
}

// ---- Search (/v2/search) ----------------------------------------------------

/**
 * Search the web. Returns `{results: [{url,title,description}], raw}`.
 * `limit` is capped at MAX_SEARCH_LIMIT; `tbs` takes qdr:h|d|w|m|y; `site:` goes in the query.
 */
export async function search(query, opts = {}) {
  const body = { query, limit: checkSearchLimit(opts.limit) };
  if (opts.lang) body.lang = opts.lang;
  if (opts.country) body.country = opts.country;
  if (opts.location) body.location = opts.location;
  if (opts.tbs) body.tbs = opts.tbs;
  if (opts.scrapeOptions) body.scrapeOptions = opts.scrapeOptions;

  const raw = await request('POST', '/search', body, { apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, verb: 'search', target: query });

  // /v2/search answers { data: { web: [...] } }; older responses were a flat array.
  const data = raw.data;
  const results = Array.isArray(data) ? data : (data?.web ?? []);
  return { results, raw };
}

/** The body `search` would send — for --explain. */
export function searchBody(query, opts = {}) {
  return { query, limit: checkSearchLimit(opts.limit), ...(opts.tbs ? { tbs: opts.tbs } : {}) };
}

// ---- Scrape (/v2/scrape) ----------------------------------------------------

export function scrapeBody(url, opts = {}) {
  const body = {
    url: assertHttpUrl(url),
    formats: opts.formats ?? ['markdown'],
    onlyMainContent: opts.onlyMainContent !== false,
  };
  if (opts.maxAge !== undefined) body.maxAge = opts.maxAge;
  if (opts.includeTags) body.includeTags = opts.includeTags;
  if (opts.excludeTags) body.excludeTags = opts.excludeTags;
  if (opts.waitFor) body.waitFor = opts.waitFor;
  if (opts.location) body.location = opts.location;
  if (opts.headers) body.headers = opts.headers;
  if (opts.actions) body.actions = opts.actions;
  return body;
}

/** Scrape one URL. Returns `{markdown, metadata, raw}`; other formats live on `raw.data`. */
export async function scrape(url, opts = {}) {
  const body = scrapeBody(url, opts);
  const raw = await request('POST', '/scrape', body, { apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, verb: 'scrape', target: body.url });
  const data = raw.data ?? {};
  return { markdown: data.markdown ?? null, metadata: data.metadata ?? {}, raw };
}

// ---- Batch scrape (sequential, delayed) -------------------------------------

/**
 * Scrape up to MAX_BATCH_URLS URLs sequentially with at least MIN_DELAY_MS between requests.
 * One failure does not abort the batch; it lands as `{url, error}`.
 */
export async function batchScrape(urls, opts = {}) {
  checkBatchSize(urls);
  const delay = checkDelay(opts.delay);
  const { delay: _, ...scrapeOpts } = opts;
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      results.push({ url: urls[i], ...(await scrape(urls[i], scrapeOpts)) });
    } catch (error) {
      results.push({ url: urls[i], markdown: null, metadata: {}, error: error.message });
    }
    if (i < urls.length - 1) await new Promise((r) => setTimeout(r, delay));
  }
  return results;
}

// ---- Search and scrape (two-stage discovery) --------------------------------

export async function searchAndScrape(query, opts = {}) {
  const { results: hits } = await search(query, { limit: opts.searchLimit ?? DEFAULT_SEARCH_LIMIT, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs });
  if (hits.length === 0) return [];
  const toScrape = opts.scrapeLimit ? hits.slice(0, opts.scrapeLimit) : hits;
  const scraped = await batchScrape(toScrape.map((r) => r.url), {
    formats: opts.formats, onlyMainContent: opts.onlyMainContent, delay: opts.delay, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs,
  });
  return scraped.map((s) => {
    const hit = hits.find((r) => r.url === s.url);
    return {
      url: s.url,
      title: hit?.title ?? s.metadata?.title ?? '',
      description: hit?.description ?? s.metadata?.description ?? '',
      markdown: s.markdown,
      metadata: s.metadata,
      ...(s.error ? { error: s.error } : {}),
    };
  });
}

// ---- Crawl (/v2/crawl — async job, page-capped) -----------------------------

export function crawlBody(url, opts = {}) {
  const body = { url: assertHttpUrl(url), limit: checkCrawlPages(opts.limit) };
  if (opts.includePaths) body.includePaths = opts.includePaths;
  if (opts.excludePaths) body.excludePaths = opts.excludePaths;
  if (opts.maxDepth !== undefined) body.maxDiscoveryDepth = opts.maxDepth;
  body.scrapeOptions = { formats: opts.formats ?? ['markdown'], onlyMainContent: opts.onlyMainContent !== false };
  return body;
}

/** Start a crawl. Returns `{id, url}`; the job runs on Firecrawl's side, billed per page up to `limit`. */
export async function startCrawl(url, opts = {}) {
  const body = crawlBody(url, opts);
  const raw = await request('POST', '/crawl', body, { apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, verb: 'crawl', target: body.url });
  if (!raw.id) throw new Error(`Firecrawl did not return a crawl id: ${JSON.stringify(raw).slice(0, 200)}`);
  return { id: raw.id, url: raw.url ?? null, limit: body.limit };
}

/** One status read of a crawl job (free of scrape credits). */
export async function crawlStatus(id, opts = {}) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`"${id}" is not a crawl id`);
  return request('GET', `/crawl/${id}`, undefined, { apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, verb: 'crawl-status', target: id });
}

/**
 * Start a crawl and wait for it. Pages are collected until the job completes or
 * MAX_CRAWL_PAGES is reached client-side — the server-side `limit` is the first fence, this is
 * the second. Returns `{id, status, pages: [{url, markdown, metadata}], creditsUsed}`.
 */
export async function crawl(url, opts = {}) {
  const job = await startCrawl(url, opts);
  const deadline = Date.now() + (opts.waitMs ?? CRAWL_WAIT_MS);
  const pollMs = opts.pollMs ?? CRAWL_POLL_MS;
  let status;
  while (true) {
    status = await crawlStatus(job.id, opts);
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') break;
    if (Date.now() > deadline) throw new Error(`crawl ${job.id} still ${status.status} after ${(opts.waitMs ?? CRAWL_WAIT_MS) / 1000}s — fc crawl-status ${job.id} to check later; no more pages will be billed than the ${job.limit} sent as limit`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const pages = collectPages(status.data ?? [], job.limit);
  return { id: job.id, status: status.status, total: status.total ?? pages.length, creditsUsed: status.creditsUsed ?? null, pages };
}

/** Client-side fence: never hand back more than the ceiling, whatever the server sent. */
export function collectPages(data, limit) {
  const cap = Math.min(limit ?? MAX_CRAWL_PAGES, MAX_CRAWL_PAGES);
  return data.slice(0, cap).map((d) => ({ url: d.metadata?.sourceURL ?? d.metadata?.url ?? null, markdown: d.markdown ?? null, metadata: d.metadata ?? {} }));
}

// ---- Account (free) ---------------------------------------------------------

/** GET /team/credit-usage — proves the key is accepted and reports remaining credits; costs nothing. */
export async function creditUsage(opts = {}) {
  const raw = await request('GET', '/team/credit-usage', undefined, { apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, verb: 'credit-usage', target: 'team' });
  return raw.data ?? raw;
}

// ---- Factory ----------------------------------------------------------------

/** The same functions with an explicit key pre-applied. */
export function createClient(apiKey) {
  if (!apiKey) throw new Error('apiKey required');
  const bind = (fn) => (a, opts = {}) => fn(a, { ...opts, apiKey });
  return {
    search: bind(search), scrape: bind(scrape), batchScrape: bind(batchScrape), searchAndScrape: bind(searchAndScrape),
    crawl: bind(crawl), startCrawl: bind(startCrawl), crawlStatus: bind(crawlStatus), creditUsage: (opts = {}) => creditUsage({ ...opts, apiKey }),
  };
}
