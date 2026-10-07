#!/usr/bin/env node
// fc — Firecrawl from the command line: search, scrape, batch, crawl. Every call is paid
// against the operator's own Firecrawl account, so every call is audited and ceilinged.
//
//   #1  read-only against the web; the only thing mutated is the operator's credit balance
//   #2  crawl is bulk spend: it previews the page/credit estimate and runs only with --yes,
//       which is always honored — a flag gate for private spend, not a /dev/tty gate
//   #3  ceilings are code constants in lib/firecrawl.js — MAX_SEARCH_LIMIT, MAX_BATCH_URLS,
//       MAX_CRAWL_PAGES (sent server-side as `limit` and enforced again client-side), MIN_DELAY_MS
//   #5  --explain prints the exact request, key redacted, and sends nothing
//   #6  status reports where the key lives and its file mode — never the value
//   #7  one audit line on stderr per HTTP request (lib/firecrawl.js request())
//   #9  batch is sequential with a delay floor; nothing retries on 402/429
//
// Usage:
//   fc status [--live]                         where the key is; --live: one free credit-usage call
//   fc search <query> [--limit N] [--tbs qdr:d]
//   fc scrape <url> [--format markdown|html|links|…] [--fresh] [--full]
//   fc batch <url>... [--delay MS]
//   fc crawl <url> [--limit N] [--depth N] [--include p] [--exclude p] --yes
//   fc crawl-status <id>
//   … --json    raw API JSON       … --explain    pre-flight, nothing sent
//
// Exit codes: 0 ok · 1 auth, network or API failure · 2 bad usage · 3 crawl needs --yes

import { parseArgs } from 'node:util';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  VERSION, KEY_FILE, KEYCHAIN_SERVICE, BASE_URL,
  MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT, MAX_BATCH_URLS, MAX_CRAWL_PAGES, DEFAULT_CRAWL_PAGES, MIN_DELAY_MS, DEFAULT_DELAY_MS, DEFAULT_TIMEOUT_MS,
  keySource, resolveKey, buildRequest, redactHeaders,
  searchBody, scrapeBody, crawlBody, checkDelay, checkBatchSize, assertHttpUrl,
  search, scrape, batchScrape, crawl, crawlStatus, creditUsage,
} from './lib/firecrawl.js';

export const VERBS = ['status', 'search', 'scrape', 'batch', 'crawl', 'crawl-status'];

function fail(msg, code = 1) {
  console.error(`fc: ${msg}`);
  process.exit(code);
}

// ---- argument parsing (pure, exported for tests) ----------------------------

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string', short: 'n' },
      tbs: { type: 'string' },
      format: { type: 'string', multiple: true },
      fresh: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      delay: { type: 'string' },
      depth: { type: 'string' },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      yes: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
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

  const int = (name) => {
    const raw = values[name];
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
    return parseInt(raw, 10);
  };
  const cli = { verb, json: values.json, explain: values.explain, yes: values.yes, live: values.live };

  if (verb === 'status') return cli;
  if (verb === 'search') {
    cli.target = rest.join(' ').trim();
    if (!cli.target) throw new Error('search needs a query');
    cli.opts = { limit: int('limit'), tbs: values.tbs };
    searchBody(cli.target, cli.opts); // ceiling check at parse time
    return cli;
  }
  if (verb === 'scrape') {
    if (rest.length !== 1) throw new Error('scrape needs exactly one <url>');
    cli.target = assertHttpUrl(rest[0]);
    cli.opts = { formats: values.format?.length ? values.format : undefined, onlyMainContent: !values.full, ...(values.fresh ? { maxAge: 0 } : {}) };
    return cli;
  }
  if (verb === 'batch') {
    if (!rest.length) throw new Error('batch needs one or more <url>');
    cli.target = checkBatchSize(rest.map(assertHttpUrl));
    cli.opts = { delay: checkDelay(int('delay')), formats: values.format?.length ? values.format : undefined, onlyMainContent: !values.full };
    return cli;
  }
  if (verb === 'crawl') {
    if (rest.length !== 1) throw new Error('crawl needs exactly one <url>');
    cli.target = assertHttpUrl(rest[0]);
    cli.opts = { limit: int('limit'), maxDepth: int('depth'), includePaths: values.include, excludePaths: values.exclude, formats: values.format?.length ? values.format : undefined, onlyMainContent: !values.full };
    crawlBody(cli.target, cli.opts); // ceiling check at parse time
    return cli;
  }
  if (verb === 'crawl-status') {
    if (rest.length !== 1) throw new Error('crawl-status needs exactly one <id>');
    cli.target = rest[0];
    return cli;
  }
  return cli;
}

// ---- pre-flight (SENSIBILITIES #5) ------------------------------------------

/** What a verb would send, key redacted. Resolves no key, so it works before setup. */
export function renderExplain(cli) {
  const plan = explainPlan(cli);
  const req = buildRequest(plan.method, plan.endpoint, plan.body, null);
  return [
    `would ${req.method} ${req.url}`,
    ...Object.entries(redactHeaders(req.headers)).map(([k, v]) => `  ${k}: ${v}`),
    ...(plan.body ? [`body: ${JSON.stringify(plan.body)}`] : []),
    plan.cost,
    `timeout ${DEFAULT_TIMEOUT_MS / 1000}s · no call made`,
  ].join('\n');
}

export function explainPlan(cli) {
  switch (cli.verb) {
    case 'status': return { method: 'GET', endpoint: '/team/credit-usage', cost: 'cost: free (credit-usage is not billed)' };
    case 'search': { const body = searchBody(cli.target, cli.opts); return { method: 'POST', endpoint: '/search', body, cost: `cost: up to ${body.limit} result(s), billed per result (ceiling ${MAX_SEARCH_LIMIT})` }; }
    case 'scrape': return { method: 'POST', endpoint: '/scrape', body: scrapeBody(cli.target, cli.opts), cost: 'cost: 1 scrape credit (more with screenshot/json formats)' };
    case 'batch': return { method: 'POST', endpoint: '/scrape', body: scrapeBody(cli.target[0], cli.opts), cost: `cost: ${cli.target.length} sequential scrape(s), ${cli.opts.delay}ms apart (ceiling ${MAX_BATCH_URLS} URLs, delay floor ${MIN_DELAY_MS}ms)` };
    case 'crawl': { const body = crawlBody(cli.target, cli.opts); return { method: 'POST', endpoint: '/crawl', body, cost: `cost: up to ${body.limit} page(s), 1 credit each (ceiling ${MAX_CRAWL_PAGES}); runs only with --yes` }; }
    case 'crawl-status': return { method: 'GET', endpoint: `/crawl/${cli.target}`, cost: 'cost: free (status reads are not billed)' };
    default: throw new Error(`unknown verb ${cli.verb}`);
  }
}

/** The crawl preview a human reads before supplying --yes (SENSIBILITIES #2, flag tier). */
export function renderCrawlPreview(cli) {
  const body = crawlBody(cli.target, cli.opts);
  return [
    `crawl ${body.url}`,
    `  pages:   up to ${body.limit} (ceiling ${MAX_CRAWL_PAGES} — MAX_CRAWL_PAGES in lib/firecrawl.js)`,
    `  depth:   ${body.maxDiscoveryDepth ?? 'unbounded within the page limit'}`,
    `  include: ${body.includePaths?.join(', ') ?? '(all paths)'}   exclude: ${body.excludePaths?.join(', ') ?? '(none)'}`,
    `  cost:    up to ${body.limit} credit(s) from your own Firecrawl account; the job keeps running server-side if fc stops waiting`,
    '',
    'Nothing was started. This is bulk spend, so it needs an explicit --yes:',
    `  fc crawl ${body.url}${cli.opts.limit ? ` --limit ${cli.opts.limit}` : ''} --yes`,
    'yes = start the crawl and wait for it · no (omit --yes) = nothing happens',
  ].join('\n');
}

// ---- rendering --------------------------------------------------------------

function renderStatus(live) {
  const src = keySource();
  const lines = [`key: ${src ?? 'none'}`];
  if (src === 'env') lines.push('  from $FIRECRAWL_API_KEY (value never printed)');
  if (src === 'file') { const mode = (statSync(KEY_FILE).mode & 0o777).toString(8); lines.push(`  from ${KEY_FILE} (mode ${mode}${mode === '600' ? '' : ' — NOT 600, will be refused'})`); }
  if (src === 'keychain') lines.push(`  from Keychain item "${KEYCHAIN_SERVICE}"`);
  if (!src) lines.push(`  export FIRECRAWL_API_KEY, write ${KEY_FILE} (chmod 600), or: security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w`);
  lines.push(`ceilings: search ${MAX_SEARCH_LIMIT} · batch ${MAX_BATCH_URLS} urls · crawl ${MAX_CRAWL_PAGES} pages · delay floor ${MIN_DELAY_MS}ms`);
  if (live) lines.push(JSON.stringify(live));
  return lines.join('\n');
}

function renderSearch(results, limit) {
  if (!results.length) return '0 results — Firecrawl found nothing for that query (try without site: or tbs:)';
  return results.map((r, i) => `[${i + 1}] ${r.title ?? ''}\n    ${r.url}\n    ${(r.description ?? '').slice(0, 160)}`).join('\n') + `\n\n${results.length} result(s) (limit ${limit}, ceiling ${MAX_SEARCH_LIMIT})`;
}

function renderScrape({ markdown, metadata, raw }, formats) {
  if (formats && !formats.includes('markdown')) return JSON.stringify(raw.data ?? {}, null, 2);
  const head = `# ${metadata.title ?? ''}\n<!-- ${metadata.sourceURL ?? ''} · HTTP ${metadata.statusCode ?? '?'} -->\n`;
  return head + (markdown ?? '(no markdown returned)');
}

function renderBatch(results) {
  return results.map((r) => `${r.error ? 'FAIL' : 'ok  '}  ${r.url}  ${r.error ?? `${(r.markdown ?? '').length} chars`}`).join('\n') + `\n\n${results.filter((r) => !r.error).length}/${results.length} scraped`;
}

function renderCrawl(result) {
  const lines = result.pages.map((p, i) => `[${i + 1}] ${p.url ?? '?'}  ${(p.markdown ?? '').length} chars`);
  return `${lines.join('\n')}\n\ncrawl ${result.id} ${result.status} · ${result.pages.length} page(s) returned · creditsUsed=${result.creditsUsed ?? '?'}`;
}

// ---- main -------------------------------------------------------------------

function usage() {
  return [
    'usage: fc status [--live]',
    '       fc search <query> [--limit N] [--tbs qdr:h|d|w|m|y] [--json] [--explain]',
    '       fc scrape <url> [--format F]... [--fresh] [--full] [--json] [--explain]',
    '       fc batch <url>... [--delay MS] [--json] [--explain]',
    '       fc crawl <url> [--limit N] [--depth N] [--include P]... [--exclude P]... --yes [--json] [--explain]',
    '       fc crawl-status <id> [--json]',
    `ceilings: search ${MAX_SEARCH_LIMIT} (default ${DEFAULT_SEARCH_LIMIT}) · batch ${MAX_BATCH_URLS} urls · crawl ${MAX_CRAWL_PAGES} pages (default ${DEFAULT_CRAWL_PAGES}) · delay floor ${MIN_DELAY_MS}ms (default ${DEFAULT_DELAY_MS})`,
    `auth: $FIRECRAWL_API_KEY, else ${KEY_FILE} (mode 600), else Keychain "${KEYCHAIN_SERVICE}"`,
    'exit: 0 ok · 1 auth/network/API failure · 2 bad usage · 3 crawl previewed, needs --yes',
  ].join('\n');
}

async function run() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`fc: ${e.message}\n${usage()}`);
    process.exit(2);
  }
  if (cli.help) { console.log(usage()); return; }
  if (cli.version) { console.log(`fc ${VERSION}`); return; }

  if (cli.explain) { console.log(renderExplain(cli)); return; }

  if (cli.verb === 'status') {
    let live = null;
    if (cli.live) {
      try { live = await creditUsage(); } catch (e) { fail(e.message); }
    }
    console.log(renderStatus(live));
    return;
  }

  // SENSIBILITIES #2, flag tier: crawl is bulk private spend. Preview without --yes, exit 3;
  // --yes is always honored — refusing a deliberate crawl only pushes it to an unguarded curl.
  if (cli.verb === 'crawl' && !cli.yes) {
    console.log(renderCrawlPreview(cli));
    process.exit(3);
  }

  try {
    resolveKey(); // fail early and plainly, before any request is built
  } catch (e) {
    fail(e.message);
  }

  try {
    if (cli.verb === 'search') {
      const { results, raw } = await search(cli.target, cli.opts);
      console.log(cli.json ? JSON.stringify(raw, null, 2) : renderSearch(results, searchBody(cli.target, cli.opts).limit));
    } else if (cli.verb === 'scrape') {
      const r = await scrape(cli.target, cli.opts);
      console.log(cli.json ? JSON.stringify(r.raw, null, 2) : renderScrape(r, cli.opts.formats));
    } else if (cli.verb === 'batch') {
      const results = await batchScrape(cli.target, cli.opts);
      console.log(cli.json ? JSON.stringify(results, null, 2) : renderBatch(results));
    } else if (cli.verb === 'crawl') {
      const result = await crawl(cli.target, cli.opts);
      console.log(cli.json ? JSON.stringify(result, null, 2) : renderCrawl(result));
    } else if (cli.verb === 'crawl-status') {
      const s = await crawlStatus(cli.target);
      console.log(cli.json ? JSON.stringify(s, null, 2) : `crawl ${cli.target}: ${s.status} · ${s.completed ?? '?'}/${s.total ?? '?'} pages · creditsUsed=${s.creditsUsed ?? '?'}`);
    }
  } catch (e) {
    fail(e.name === 'TimeoutError' ? `timeout after ${DEFAULT_TIMEOUT_MS / 1000}s reaching ${BASE_URL}; nothing was retried` : e.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => fail(`internal: ${e.message}`, 1));
}
