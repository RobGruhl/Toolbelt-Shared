#!/usr/bin/env node
// pplx — read-only CLI over the Perplexity Search API and Agent API. Every call is paid.
//
//   #1  read-only by construction — both endpoints return web results; nothing mutates
//   #3  ceilings are code constants in lib/constants.js (CEILINGS), never flags
//   #5  --explain pre-flights: the exact request, key redacted, worst-case cost, no call
//   #7  one audit line on stderr per paid call (lib/perplexity.js request()) — tokens and
//       cost when the API reports them, never the key
//   #11 the key comes from $PERPLEXITY_API_KEY or a 600-mode file outside the tree
//
// Usage:
//   pplx search <query…> [--limit N] [--recency hour|day|week|month|year]
//                        [--allow a.com,b.org] [--block x.com] [--after YYYY-MM-DD] [--before YYYY-MM-DD]
//   pplx agent <question…> [--model sonnet|opus|haiku|<id>] [--max-output-tokens N]
//                          [--instructions "…"] [--no-search]
//   … --json      raw API body for machines
//   … --explain   pre-flight only: request + worst-case cost, no call made
//
// Exit codes: 0 ok · 1 auth, network or API failure · 2 bad usage (incl. a value over a ceiling)

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { search, agent, resolveKey, redactedHeaders, assertCeiling } from './lib/perplexity.js';
import { BASE_URL, ENDPOINTS, AGENT_MODELS, DEFAULTS, CEILINGS, PRICING, KEY_FILE } from './lib/constants.js';

export const VERBS = ['search', 'agent'];
const VERSION = '0.2.0';
const MODEL_ALIASES = { sonnet: AGENT_MODELS.CLAUDE_SONNET, opus: AGENT_MODELS.CLAUDE_OPUS, haiku: AGENT_MODELS.CLAUDE_HAIKU };
const MODEL_PRICE = {
  [AGENT_MODELS.CLAUDE_SONNET]: PRICING.AGENT_CLAUDE_SONNET,
  [AGENT_MODELS.CLAUDE_OPUS]: PRICING.AGENT_CLAUDE_OPUS,
  [AGENT_MODELS.CLAUDE_HAIKU]: PRICING.AGENT_CLAUDE_HAIKU,
};
const SEARCH_TOOL_USD = 0.005;

const USAGE = `pplx ${VERSION} — Perplexity Search API + Agent API (read-only; every call is paid)

  pplx search <query…> [--limit N] [--recency R] [--allow d,d] [--block d,d] [--after D] [--before D]
  pplx agent <question…> [--model sonnet|opus|haiku|<id>] [--max-output-tokens N] [--instructions S] [--no-search]
  … --json       raw API body
  … --explain    pre-flight: request + worst-case cost, no call made

Ceilings (lib/constants.js CEILINGS): search --limit ≤ ${CEILINGS.SEARCH_MAX_RESULTS} (default ${DEFAULTS.SEARCH_MAX_RESULTS});
agent --max-output-tokens ≤ ${CEILINGS.AGENT_MAX_OUTPUT_TOKENS} (default ${DEFAULTS.AGENT_MAX_OUTPUT_TOKENS}).
Key: $PERPLEXITY_API_KEY, else ${KEY_FILE} (mode 600).`;

function fail(msg, code = 1) {
  console.error(`pplx: ${msg}`);
  process.exit(code);
}

function intOpt(raw, name) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return parseInt(raw, 10);
}

function listOpt(raw) {
  if (raw === undefined) return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** Parse argv (without node and script) into a call description. Throws on bad usage. */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string', short: 'n' },
      recency: { type: 'string' },
      allow: { type: 'string' },
      block: { type: 'string' },
      after: { type: 'string' },
      before: { type: 'string' },
      model: { type: 'string' },
      'max-output-tokens': { type: 'string' },
      instructions: { type: 'string' },
      'no-search': { type: 'boolean', default: false },
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
  const query = rest.join(' ').trim();
  if (!query) throw new Error(`${verb} needs a query`);

  if (verb === 'search') {
    const limit = intOpt(values.limit, '--limit') ?? DEFAULTS.SEARCH_MAX_RESULTS;
    assertCeiling('--limit', limit, CEILINGS.SEARCH_MAX_RESULTS);
    if (values.recency && !['hour', 'day', 'week', 'month', 'year'].includes(values.recency)) {
      throw new Error(`--recency must be hour|day|week|month|year, got "${values.recency}"`);
    }
    for (const [k, v] of [['--after', values.after], ['--before', values.before]]) {
      if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${k} must be YYYY-MM-DD, got "${v}"`);
    }
    return {
      verb, query, json: values.json, explain: values.explain,
      opts: {
        maxResults: limit, recency: values.recency,
        allowDomains: listOpt(values.allow), blockDomains: listOpt(values.block),
        startDate: values.after, endDate: values.before,
      },
    };
  }

  const model = values.model === undefined ? DEFAULTS.AGENT_MODEL : (MODEL_ALIASES[values.model] ?? values.model);
  const maxOutputTokens = intOpt(values['max-output-tokens'], '--max-output-tokens') ?? DEFAULTS.AGENT_MAX_OUTPUT_TOKENS;
  assertCeiling('--max-output-tokens', maxOutputTokens, CEILINGS.AGENT_MAX_OUTPUT_TOKENS);
  return {
    verb, query, json: values.json, explain: values.explain,
    opts: { model, maxOutputTokens, instructions: values.instructions, webSearch: !values['no-search'] },
  };
}

/** Worst-case dollars for one call at the chosen parameters (pure, for --explain and tests). */
export function estimateWorstCase({ verb, opts }, inputTokens = 2000) {
  if (verb === 'search') return SEARCH_TOOL_USD;
  const p = MODEL_PRICE[opts.model];
  if (!p) return null; // unknown model id: no price table
  const tokens = (inputTokens * p.input_per_1m + opts.maxOutputTokens * p.output_per_1m) / 1_000_000;
  return tokens + (opts.webSearch ? SEARCH_TOOL_USD : 0);
}

/** The request body a call would send — mirrors lib/perplexity.js so --explain cannot drift far. */
export function describeRequest({ verb, query, opts }) {
  if (verb === 'search') {
    const body = { query, max_results: opts.maxResults };
    const filter = [...(opts.allowDomains ?? []), ...(opts.blockDomains ?? []).map((d) => `-${d}`)];
    if (filter.length) body.search_domain_filter = filter;
    if (opts.recency) body.search_recency_filter = opts.recency;
    if (opts.startDate) body.search_after_date_filter = opts.startDate;
    if (opts.endDate) body.search_before_date_filter = opts.endDate;
    return { url: `${BASE_URL}${ENDPOINTS.SEARCH}`, body, timeoutMs: DEFAULTS.CHAT_TIMEOUT_MS };
  }
  const body = { model: opts.model, input: query, max_output_tokens: opts.maxOutputTokens };
  if (opts.webSearch) body.tools = [{ type: 'web_search' }];
  if (opts.instructions) body.instructions = opts.instructions;
  return { url: `${BASE_URL}${ENDPOINTS.AGENT}`, body, timeoutMs: DEFAULTS.AGENT_TIMEOUT_MS };
}

function explain(call) {
  const { url, body, timeoutMs } = describeRequest(call);
  let keyState;
  try {
    resolveKey(undefined);
    keyState = 'present (redacted)';
  } catch (e) {
    keyState = `ABSENT — ${e.message}`;
  }
  const worst = estimateWorstCase(call);
  console.log(`POST ${url}`);
  for (const [k, v] of Object.entries(redactedHeaders())) console.log(`${k}: ${v}`);
  console.log(`key: ${keyState}`);
  console.log(`timeout: ${timeoutMs} ms`);
  console.log(`worst-case cost: ${worst == null ? 'unknown model id (no price table)' : '$' + worst.toFixed(3)} (at the ceilings; the audit line reports the actual)`);
  console.log(JSON.stringify(body, null, 2));
  console.log('(pre-flight only — no request was made)');
}

function renderSearch({ results }) {
  if (!results.length) {
    console.log('0 results — nothing matched these filters (not proof that nothing exists)');
    return;
  }
  results.forEach((r, i) => {
    console.log(`[${i + 1}] ${r.title ?? '(untitled)'}`);
    console.log(`    ${r.url}`);
    if (r.date) console.log(`    ${r.date}`);
    if (r.snippet) console.log(`    ${r.snippet.replace(/\s+/g, ' ').slice(0, 300)}`);
  });
}

function renderAgent({ answer, citations, usage }) {
  console.log(answer || '(empty answer)');
  if (citations.length) {
    console.log('\nSources:');
    citations.forEach((u, i) => console.log(`  [${i + 1}] ${u}`));
  }
  const cost = usage?.cost?.total_cost;
  if (cost != null) console.log(`\ncost: $${cost} (${usage.total_tokens ?? '?'} tokens)`);
}

async function main() {
  let call;
  try {
    call = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`pplx: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (call.help) { console.log(USAGE); return; }
  if (call.version) { console.log(VERSION); return; }
  if (call.explain) { explain(call); return; }

  let out;
  try {
    out = call.verb === 'search' ? await search(call.query, call.opts) : await agent(call.query, call.opts);
  } catch (e) {
    if (e.name === 'TimeoutError') fail('request timed out (DEFAULTS in lib/constants.js); not retried');
    if (/^Perplexity 401/.test(e.message)) fail('Perplexity rejected the key (401) — rotate it at perplexity.ai/settings/api and update $PERPLEXITY_API_KEY or the key file');
    if (/^Perplexity 429/.test(e.message)) fail('rate limited (429) — wait and retry by hand; pplx does not retry');
    if (/exceeds the .* ceiling/.test(e.message)) fail(e.message, 2);
    fail(e.message);
  }
  if (call.json) { console.log(JSON.stringify(out.raw, null, 2)); return; }
  if (call.verb === 'search') renderSearch(out); else renderAgent(out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
