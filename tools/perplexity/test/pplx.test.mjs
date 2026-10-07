// Unit tests for the pure parts: no network, no real key file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCli, describeRequest, estimateWorstCase, VERBS } from '../pplx.mjs';
import { resolveKey, assertCeiling, auditLine, redactedHeaders } from '../lib/perplexity.js';
import { CEILINGS, DEFAULTS, AGENT_MODELS } from '../lib/constants.js';

test('ceilings are the documented constants', () => {
  assert.equal(CEILINGS.SEARCH_MAX_RESULTS, 20);
  assert.equal(CEILINGS.SEARCH_MAX_QUERIES, 5);
  assert.equal(CEILINGS.AGENT_MAX_OUTPUT_TOKENS, 4096);
  assert.equal(CEILINGS.CHAT_MAX_TOKENS, 4096);
  assert.ok(DEFAULTS.AGENT_MAX_OUTPUT_TOKENS <= CEILINGS.AGENT_MAX_OUTPUT_TOKENS);
  assert.deepEqual(VERBS, ['search', 'agent']);
});

test('a value over a ceiling is refused, not lowered', () => {
  assert.throws(() => assertCeiling('x', CEILINGS.SEARCH_MAX_RESULTS + 1, CEILINGS.SEARCH_MAX_RESULTS), /exceeds the 20 ceiling/);
  assert.throws(() => parseCli(['search', 'q', '--limit', '21']), /exceeds the 20 ceiling/);
  assert.throws(() => parseCli(['agent', 'q', '--max-output-tokens', '9999']), /exceeds the 4096 ceiling/);
  assert.doesNotThrow(() => assertCeiling('x', undefined, 1));
});

test('search parses defaults and filters', () => {
  const c = parseCli(['search', 'tokyo', 'population', '--allow', 'a.com,b.org', '--block', 'x.com', '--recency', 'week']);
  assert.equal(c.verb, 'search');
  assert.equal(c.query, 'tokyo population');
  assert.equal(c.opts.maxResults, DEFAULTS.SEARCH_MAX_RESULTS);
  const { body, url } = describeRequest(c);
  assert.match(url, /\/search$/);
  assert.deepEqual(body.search_domain_filter, ['a.com', 'b.org', '-x.com']);
  assert.equal(body.search_recency_filter, 'week');
  assert.throws(() => parseCli(['search', 'q', '--after', '1/2/2026']), /YYYY-MM-DD/);
});

test('agent resolves model aliases and always sends max_output_tokens', () => {
  const c = parseCli(['agent', 'why', '--model', 'haiku']);
  assert.equal(c.opts.model, AGENT_MODELS.CLAUDE_HAIKU);
  const { body } = describeRequest(c);
  assert.equal(body.max_output_tokens, DEFAULTS.AGENT_MAX_OUTPUT_TOKENS);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  const noSearch = describeRequest(parseCli(['agent', 'why', '--no-search']));
  assert.equal(noSearch.body.tools, undefined);
});

test('usage errors: no verb, unknown verb, empty query', () => {
  assert.throws(() => parseCli([]), /no verb/);
  assert.throws(() => parseCli(['chat', 'hi']), /unknown verb/);
  assert.throws(() => parseCli(['search']), /needs a query/);
});

test('worst-case estimate is bounded and monotone in the ceiling', () => {
  assert.equal(estimateWorstCase(parseCli(['search', 'q'])), 0.005);
  const sonnet = estimateWorstCase(parseCli(['agent', 'q']));
  const opus = estimateWorstCase(parseCli(['agent', 'q', '--model', 'opus']));
  assert.ok(sonnet > 0 && sonnet < 0.2);
  assert.ok(opus > sonnet);
  assert.equal(estimateWorstCase(parseCli(['agent', 'q', '--model', 'vendor/unknown'])), null);
});

test('key resolution: env wins, loose key file refused, 600 file read, none throws', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pplx-'));
  const keyFile = path.join(dir, 'key');
  assert.equal(resolveKey(undefined, { env: { PERPLEXITY_API_KEY: ' e ' }, keyFile }), 'e');
  assert.throws(() => resolveKey(undefined, { env: {}, keyFile }), /PERPLEXITY_API_KEY not set/);
  writeFileSync(keyFile, 'f\n');
  chmodSync(keyFile, 0o644);
  assert.throws(() => resolveKey(undefined, { env: {}, keyFile }), /chmod 600/);
  chmodSync(keyFile, 0o600);
  assert.equal(resolveKey(undefined, { env: {}, keyFile }), 'f');
  assert.equal(resolveKey('explicit', { env: {}, keyFile }), 'explicit');
});

test('audit line carries tokens and cost, never the key', () => {
  const line = auditLine({ endpoint: '/v1/agent', model: 'm', status: 200, ms: 12, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, cost: { total_cost: 0.01 } } });
  assert.match(line, /^\[perplexity audit\] \d{4}-/);
  assert.match(line, /endpoint=\/v1\/agent model=m status=200 ms=12 in_tokens=1 out_tokens=2 total_tokens=3 cost_usd=0.01/);
  assert.deepEqual(redactedHeaders().Authorization, 'Bearer ***');
});
