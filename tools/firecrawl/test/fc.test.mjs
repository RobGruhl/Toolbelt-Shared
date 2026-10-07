// Pure-part tests: ceilings, key resolution, redaction, crawl fence, audit shape, CLI parsing.
// No network, no credential, no real home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_SEARCH_LIMIT, MAX_BATCH_URLS, MAX_CRAWL_PAGES, MIN_DELAY_MS, DEFAULT_CRAWL_PAGES,
  resolveKey, keySource, buildRequest, redactHeaders, auditLine,
  checkSearchLimit, checkCrawlPages, checkBatchSize, checkDelay, collectPages, crawlBody,
} from '../lib/firecrawl.js';
import { parseCli, renderExplain, renderCrawlPreview, VERBS } from '../fc.mjs';

const noKeychain = () => null;
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('ceilings hold the documented values', () => {
  assert.equal(MAX_SEARCH_LIMIT, 20);
  assert.equal(MAX_BATCH_URLS, 20);
  assert.equal(MAX_CRAWL_PAGES, 50);
  assert.equal(MIN_DELAY_MS, 1000);
});

test('a limit above a ceiling is refused, not lowered', () => {
  assert.throws(() => checkSearchLimit(MAX_SEARCH_LIMIT + 1), /MAX_SEARCH_LIMIT/);
  assert.throws(() => checkCrawlPages(MAX_CRAWL_PAGES + 1), /MAX_CRAWL_PAGES/);
  assert.throws(() => checkBatchSize(new Array(MAX_BATCH_URLS + 1).fill('https://x')), /MAX_BATCH_URLS/);
  assert.throws(() => checkDelay(MIN_DELAY_MS - 1), /MIN_DELAY_MS/);
  assert.equal(checkCrawlPages(undefined), DEFAULT_CRAWL_PAGES);
  assert.equal(crawlBody('https://example.com', {}).limit, DEFAULT_CRAWL_PAGES);
});

test('collectPages never returns more than the ceiling whatever the server sent', () => {
  const data = new Array(MAX_CRAWL_PAGES + 30).fill({ markdown: 'x', metadata: { sourceURL: 'https://e' } });
  assert.equal(collectPages(data, 500).length, MAX_CRAWL_PAGES);
  assert.equal(collectPages(data, 3).length, 3);
});

test('key: env wins, a loose key file is refused, a 600 file is read, none is an error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-'));
  const keyFile = path.join(dir, 'key');
  assert.equal(resolveKey({ env: { FIRECRAWL_API_KEY: 'fc-env' }, keyFile, keychain: noKeychain }), 'fc-env'); // pragma: allowlist secret
  writeFileSync(keyFile, 'fc-file\n');
  chmodSync(keyFile, 0o644);
  assert.throws(() => resolveKey({ env: {}, keyFile, keychain: noKeychain }), /chmod 600/);
  chmodSync(keyFile, 0o600);
  assert.equal(resolveKey({ env: {}, keyFile, keychain: noKeychain }), 'fc-file');
  assert.equal(keySource({ env: {}, keyFile, keychain: noKeychain }), 'file');
  assert.throws(() => resolveKey({ env: {}, keyFile: path.join(dir, 'missing'), keychain: noKeychain }), /no Firecrawl key/);
  assert.equal(keySource({ env: {}, keyFile: path.join(dir, 'missing'), keychain: noKeychain }), null);
});

test('redaction masks the bearer and the explain text never carries a key', () => {
  const req = buildRequest('POST', '/scrape', { url: 'https://example.com' }, 'fc-secret-123');
  assert.equal(redactHeaders(req.headers).Authorization, 'Bearer ***');
  const text = renderExplain(parseCli(['scrape', 'https://example.com']));
  assert.doesNotMatch(text, /fc-secret/);
  assert.match(text, /Bearer \*\*\*/);
  assert.match(text, /no call made/);
});

test('audit line carries verb, target, status, size — and no key', () => {
  const line = auditLine({ verb: 'scrape', target: 'https://example.com', status: 200, size: 1234, ms: 5 });
  assert.match(line, /^\[fc\] \d{4}-\d\d-\d\dT.*verb=scrape target="https:\/\/example\.com" status=200 size=1234 ms=5$/);
});

test('crawl without --yes is a preview; parse refuses over-ceiling and bad URLs', () => {
  const cli = parseCli(['crawl', 'https://example.com', '--limit', '5']);
  assert.equal(cli.yes, false);
  assert.match(renderCrawlPreview(cli), /needs an explicit --yes/);
  assert.equal(parseCli(['crawl', 'https://example.com', '--yes']).yes, true);
  assert.throws(() => parseCli(['crawl', 'https://example.com', '--limit', String(MAX_CRAWL_PAGES + 1)]), /MAX_CRAWL_PAGES/);
  assert.throws(() => parseCli(['scrape', 'ftp://example.com']), /http\(s\)/);
  assert.throws(() => parseCli(['search']), /needs a query/);
  assert.throws(() => parseCli(['bogus']), /unknown verb/);
});

test('manifest verbs[] names every CLI verb', () => {
  const manifest = JSON.parse(readFileSync(path.join(HERE, '..', 'toolbelt.json'), 'utf8'));
  const declared = new Set(manifest.verbs.map((v) => v.name));
  for (const v of VERBS) assert.ok(declared.has(v), `verb ${v} missing from toolbelt.json`);
  assert.equal(manifest.verbs.find((v) => v.name === 'crawl').gate, 'flag');
});
