// Unit + end-to-end tests for omh. No network: end-to-end runs preload test/fake-graph.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCli, clampMax, graphScopes, assertScopeExact, accountFromIdToken, listUrl, fileId, resumePlan, checkOutDir,
  readIndex, retryDelayMs, MAX_MESSAGES, DEFAULT_MAX,
} from '../omh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OMH = path.resolve(HERE, '..', 'omh.mjs');
const FAKE = path.join(HERE, 'fake-graph.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'omh-'));

test('parseCli: verbs, flag applicability, ceilings, search vs dates', () => {
  assert.throws(() => parseCli([]), /no verb/);
  assert.throws(() => parseCli(['send']), /no write verbs/);
  assert.throws(() => parseCli(['status', '--out', 'x']), /does not apply/);
  assert.throws(() => parseCli(['export']), /needs --out/);
  assert.throws(() => parseCli(['list', '--since', '2026/09/01']), /YYYY-MM-DD/);
  assert.throws(() => parseCli(['list', '--since', '2026-09-01', '--search', 'x']), /cannot be combined/);
  assert.throws(() => parseCli(['auth', '--client-id', 'nope']), /GUID/);
  assert.equal(parseCli(['list']).max, DEFAULT_MAX);
  assert.throws(() => clampMax(String(MAX_MESSAGES + 1)), /ceiling/);
  assert.equal(parseCli(['export', '--out', 'd', '--folder', 'junkemail']).folder, 'junkemail');
});

test('scope: exactly Mail.Read (OIDC scopes and the Graph prefix ignored)', () => {
  assert.deepEqual([...graphScopes('https://graph.microsoft.com/Mail.Read openid profile offline_access')], ['mail.read']);
  assert.doesNotThrow(() => assertScopeExact('Mail.Read openid'));
  assert.throws(() => assertScopeExact('Mail.Read Mail.Send'), /not exactly/);
  assert.throws(() => assertScopeExact('Mail.ReadWrite'), /not exactly/);
  assert.throws(() => assertScopeExact('openid profile'), /not exactly/);
});

test('account from id_token; refused when missing', () => {
  const tok = `a.${Buffer.from(JSON.stringify({ preferred_username: 'Rob@Hotmail.com' })).toString('base64url')}.b`;
  assert.equal(accountFromIdToken(tok), 'rob@hotmail.com');
  assert.throws(() => accountFromIdToken('garbage'), /account name/);
});

test('listUrl: folders, date filter, search, no filter with search', () => {
  const a = new URL(listUrl({ folder: 'all', since: '2026-09-01', until: '2026-09-15' }));
  assert.equal(a.pathname, '/v1.0/me/messages');
  assert.equal(a.searchParams.get('$filter'), 'receivedDateTime ge 2026-09-01T00:00:00Z and receivedDateTime lt 2026-09-15T00:00:00Z');
  const j = new URL(listUrl({ folder: 'junkemail', search: 'unsubscribe "x"' }));
  assert.equal(j.pathname, '/v1.0/me/mailFolders/junkemail/messages');
  assert.equal(j.searchParams.get('$search'), '"unsubscribe x"');
  assert.equal(j.searchParams.get('$filter'), null);
  assert.throws(() => listUrl({ folder: '../x' }), /--folder/);
});

test('fileId is stable, hex, and distinguishes case', () => {
  assert.match(fileId('AAMkAD+x/1=='), /^[0-9a-f]{24}$/);
  assert.equal(fileId('abc'), fileId('abc'));
  assert.notEqual(fileId('abc'), fileId('ABC'));
});

test('resume and out-dir guards', () => {
  const { records } = readIndex('{"id":"a","sha256":"x","bytes":5}\n{"id":"b","error":"x"}\nnot json\n');
  assert.deepEqual(resumePlan(['a', 'b', 'c'], records, (id) => (id === 'a' ? 5 : null)), { todo: ['b', 'c'], skipped: ['a'] });
  const home = tmp();
  assert.throws(() => checkOutDir(home, { home, roots: [] }), /home directory/);
  assert.throws(() => checkOutDir(path.join(home, 'belt', 'x'), { home, roots: [path.join(home, 'belt')] }), /Toolbelt tree/);
  assert.ok(retryDelayMs(1, '2') === 2000);
});

const run = (home, args, env = {}) => spawnSync(process.execPath, ['--import', FAKE, OMH, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, ...env } });

test('end-to-end: device-code auth, paging, $value export, 404 recorded, resume', () => {
  const home = tmp();
  const a = run(home, ['auth', '--client-id', '11111111-2222-3333-4444-555555555555']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stderr, /ABCD-EFGH/);
  const tok = path.join(home, '.config/toolbelt/outlook-harvest/me@example.com.json');
  assert.equal(statSync(tok).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(tok, 'utf8')).refresh_token, 'fake-refresh');
  const out = path.join(home, 'mail');
  const pre = run(home, ['export', '--out', out, '--explain']);
  assert.equal(pre.status, 0, pre.stderr);
  assert.match(pre.stdout, /→ 4 match/);
  assert.equal(existsSync(out), false);
  const e = run(home, ['export', '--out', out, '--json']);
  assert.equal(e.status, 1, 'one message 404s, so exit 1');
  const sum = JSON.parse(e.stdout);
  assert.equal(sum.exported, 3);
  assert.equal(sum.failed, 1);
  const idx = readFileSync(path.join(out, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ok = idx.filter((r) => !r.error);
  for (const r of ok) {
    const buf = readFileSync(path.join(out, `${r.id}.eml`));
    assert.equal(createHash('sha256').update(buf).digest('hex'), r.sha256, 'bytes are exact');
    assert.match(r.internalDate, /^\d+$/);
    assert.ok(r.source_link.startsWith('https://outlook.live.com/'));
  }
  assert.deepEqual(new Set(ok.flatMap((r) => r.labelIds)), new Set(['Inbox']));
  const again = run(home, ['export', '--out', out, '--json']);
  assert.equal(JSON.parse(again.stdout).skipped, 3);
  rmSync(home, { recursive: true, force: true });
});

test('end-to-end: a grant wider than Mail.Read is refused and no token is written', () => {
  const home = tmp();
  const a = run(home, ['auth', '--client-id', '11111111-2222-3333-4444-555555555555'], { FAKE_SCOPE: 'Mail.ReadWrite openid' });
  assert.equal(a.status, 1);
  assert.match(a.stderr, /not exactly/);
  assert.equal(existsSync(path.join(home, '.config/toolbelt/outlook-harvest/me@example.com.json')), false);
  rmSync(home, { recursive: true, force: true });
});

test('end-to-end: a dropped connection while waiting for sign-in does not end the wait', () => {
  const home = tmp();
  const a = run(home, ['auth', '--client-id', '11111111-2222-3333-4444-555555555555'], { FAKE_DROP: '1' });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stderr, /network hiccup/);
  assert.ok(existsSync(path.join(home, '.config/toolbelt/outlook-harvest/me@example.com.json')));
  rmSync(home, { recursive: true, force: true });
});
