// Unit tests for the pure parts of exr. No network: the one fetch path is not imported here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCli, clampLimit, assertRepoRef, buildRequest, redactHeaders, renderExplain, resolveToken,
  MAX_LIMIT, DEFAULT_LIMIT, TIMEOUT_MS, API,
} from '../exr.mjs';

// ---- argument parsing --------------------------------------------------------

test('parses the three verbs with their targets', () => {
  assert.deepEqual(parseCli(['repo', 'octocat/Hello-World']),
    { verb: 'repo', target: 'octocat/Hello-World', limit: DEFAULT_LIMIT, json: false, explain: false });
  assert.equal(parseCli(['releases', 'octocat/Hello-World', '--limit', '3']).limit, 3);
  assert.equal(parseCli(['search', 'language:rust', 'cli', '-n', '5']).target, 'language:rust cli');
});

test('flags: --json, --explain, --help, --version', () => {
  const c = parseCli(['repo', 'a/b', '--json', '--explain']);
  assert.equal(c.json, true);
  assert.equal(c.explain, true);
  assert.deepEqual(parseCli(['--help']), { help: true });
  assert.deepEqual(parseCli(['--version']), { version: true });
});

test('rejects a missing or unknown verb and a missing target', () => {
  assert.throws(() => parseCli([]), /no verb/);
  assert.throws(() => parseCli(['delete', 'a/b']), /unknown verb "delete"/);
  assert.throws(() => parseCli(['repo']), /needs an <owner\/name>/);
  assert.throws(() => parseCli(['search']), /needs a query/);
});

test('repo refs must be owner/name — nothing that could reshape the URL', () => {
  assert.doesNotThrow(() => assertRepoRef('octocat/Hello-World'));
  assert.doesNotThrow(() => assertRepoRef('my.org/some_repo-1'));
  assert.throws(() => assertRepoRef('octocat'), /not an <owner\/name>/);
  assert.throws(() => assertRepoRef('https://github.com/octocat/Hello-World'), /not an <owner\/name>/);
  assert.throws(() => assertRepoRef('a/b/c'), /not an <owner\/name>/);
  assert.throws(() => assertRepoRef('a/b?per_page=1000'), /not an <owner\/name>/);
});

// ---- ceilings (SENSIBILITIES #3) ---------------------------------------------

test('limit defaults to DEFAULT_LIMIT and the constants are what the contract says', () => {
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT);
  assert.equal(DEFAULT_LIMIT, 10);
  assert.equal(MAX_LIMIT, 100);
  assert.equal(TIMEOUT_MS, 20_000);
});

test('limit within the ceiling passes; above it is refused, not silently lowered', () => {
  assert.equal(clampLimit('1'), 1);
  assert.equal(clampLimit(String(MAX_LIMIT)), MAX_LIMIT);
  assert.throws(() => clampLimit(String(MAX_LIMIT + 1)), /exceeds the 100 ceiling/);
  assert.throws(() => clampLimit('99999'), /code constant/);
});

test('limit must be a positive integer', () => {
  assert.throws(() => clampLimit('0'), /at least 1/);
  assert.throws(() => clampLimit('-5'), /positive integer/);
  assert.throws(() => clampLimit('ten'), /positive integer/);
  assert.throws(() => clampLimit('1.5'), /positive integer/);
});

// ---- request construction + redaction ----------------------------------------

test('buildRequest: URLs are the documented GitHub endpoints with the limit as per_page', () => {
  assert.equal(buildRequest({ verb: 'repo', target: 'o/n', limit: 10 }).url, `${API}/repos/o/n`);
  assert.equal(buildRequest({ verb: 'releases', target: 'o/n', limit: 7 }).url, `${API}/repos/o/n/releases?per_page=7`);
  const s = buildRequest({ verb: 'search', target: 'a b&c', limit: 2 }).url;
  assert.equal(s, `${API}/search/repositories?q=a%20b%26c&per_page=2`);
});

test('buildRequest: no Authorization header without a token; Bearer with one', () => {
  const anon = buildRequest({ verb: 'repo', target: 'o/n', limit: 10 });
  assert.equal(anon.headers.Authorization, undefined);
  assert.ok(anon.headers['User-Agent'].startsWith('exr/'));
  const authed = buildRequest({ verb: 'repo', target: 'o/n', limit: 10 }, 'ghp_secret123');
  assert.equal(authed.headers.Authorization, 'Bearer ghp_secret123');
});

test('redactHeaders masks the credential and leaves everything else alone', () => {
  const h = buildRequest({ verb: 'repo', target: 'o/n', limit: 10 }, 'ghp_secret123').headers;
  const r = redactHeaders(h);
  assert.equal(r.Authorization, 'Bearer ***');
  assert.equal(r.Accept, h.Accept);
  assert.equal(h.Authorization, 'Bearer ghp_secret123', 'input is not mutated');
  assert.deepEqual(redactHeaders({ Accept: 'x' }), { Accept: 'x' });
});

// ---- --explain (SENSIBILITIES #5) --------------------------------------------

test('renderExplain shows the exact URL and headers, never the token', () => {
  const cli = { verb: 'releases', target: 'octocat/Hello-World', limit: 3 };
  const token = 'ghp_verysecret';
  const out = renderExplain(buildRequest(cli, token), cli, token);
  assert.match(out, /^would GET https:\/\/api\.github\.com\/repos\/octocat\/Hello-World\/releases\?per_page=3$/m);
  assert.match(out, /Authorization: Bearer \*\*\*/);
  assert.match(out, /limit=3 \(ceiling 100\)/);
  assert.match(out, /token present/);
  assert.match(out, /no call made/);
  assert.ok(!out.includes(token), 'token must not appear in --explain output');
});

test('renderExplain names the unauthenticated rate limit when there is no token', () => {
  const cli = { verb: 'repo', target: 'o/n', limit: 10 };
  const out = renderExplain(buildRequest(cli, null), cli, null);
  assert.match(out, /auth: none — unauthenticated, 60 req\/hr/);
  assert.ok(!/Authorization/.test(out));
  assert.ok(!/limit=/.test(out), 'repo has no limit to explain');
});

// ---- credential (SENSIBILITIES #11) ------------------------------------------

test('resolveToken: env wins, blank env is absent, absent file is null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exr-'));
  try {
    const keyFile = path.join(dir, 'token');
    assert.equal(resolveToken({ env: { GITHUB_TOKEN: ' ghp_env ' }, keyFile }), 'ghp_env');
    assert.equal(resolveToken({ env: { GITHUB_TOKEN: '   ' }, keyFile }), null);
    assert.equal(resolveToken({ env: {}, keyFile }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveToken: a 600-mode key file is read; a loose one is refused; an empty one is absent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exr-'));
  try {
    const keyFile = path.join(dir, 'token');
    writeFileSync(keyFile, 'ghp_file\n');
    chmodSync(keyFile, 0o600);
    assert.equal(resolveToken({ env: {}, keyFile }), 'ghp_file');
    chmodSync(keyFile, 0o644);
    assert.throws(() => resolveToken({ env: {}, keyFile }), /group\/world readable — chmod 600/);
    chmodSync(keyFile, 0o600);
    writeFileSync(keyFile, '\n');
    assert.equal(resolveToken({ env: {}, keyFile }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
