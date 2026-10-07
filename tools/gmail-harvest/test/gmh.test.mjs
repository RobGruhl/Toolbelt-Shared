// Unit tests for the pure parts of gmh. No network, no Keychain, no real token or home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCli, clampMax, assertAccount, parseIdsFile, makePkce, makeState, buildAuthUrl, scopeSet,
  assertScopeExact, parseCallback, readTokenFile, writeTokenFile, listAccounts, pickAccount,
  parseKeychainAccount, resolveClient, decodeRaw, sha256, readIndex, resumePlan, checkOutDir,
  retryDelayMs, isRetryable, auditLine, tokenPath, extractLinks, mimeTexts, decodeQuotedPrintable,
  MAX_MESSAGES, DEFAULT_MAX, CONCURRENCY, TIMEOUT_MS, MAX_ATTEMPTS, LIST_PAGE, AUTH_WAIT_MS, SCOPE,
  KEYCHAIN_SERVICE,
} from '../gmh.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'gmh-test-'));

// ---- ceilings ---------------------------------------------------------------

test('ceilings are the documented code constants', () => {
  assert.equal(MAX_MESSAGES, 5000);
  assert.equal(DEFAULT_MAX, 500);
  assert.equal(CONCURRENCY, 4);
  assert.equal(TIMEOUT_MS, 30_000);
  assert.equal(MAX_ATTEMPTS, 4);
  assert.equal(LIST_PAGE, 500);
  assert.equal(AUTH_WAIT_MS, 300_000);
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(KEYCHAIN_SERVICE, 'google-workspace-oauth');
});

test('--max: default, accepted, refused above the ceiling (never lowered)', () => {
  assert.equal(clampMax(undefined), DEFAULT_MAX);
  assert.equal(clampMax('1'), 1);
  assert.equal(clampMax(String(MAX_MESSAGES)), MAX_MESSAGES);
  assert.throws(() => clampMax(String(MAX_MESSAGES + 1)), /exceeds the 5000 ceiling/);
  assert.throws(() => clampMax('0'), /at least 1/);
  assert.throws(() => clampMax('ten'), /positive integer/);
  assert.throws(() => clampMax('-5'), /positive integer/);
});

// ---- argument parsing -------------------------------------------------------

test('parses every verb', () => {
  assert.deepEqual(parseCli(['auth', '--account', 'Me@Example.com']),
    { verb: 'auth', json: false, explain: false, live: false, account: 'me@example.com' });
  assert.equal(parseCli(['status', '--live']).live, true);
  assert.equal(parseCli(['whoami', '--json']).json, true);
  const l = parseCli(['list', '--query', 'newer_than:7d', '--max', '20']);
  assert.equal(l.query, 'newer_than:7d');
  assert.equal(l.max, 20);
  const e = parseCli(['export', '-q', 'from:x', '--out', '/tmp/x', '--explain']);
  assert.equal(e.query, 'from:x');
  assert.equal(e.out, '/tmp/x');
  assert.equal(e.max, DEFAULT_MAX);
  assert.equal(e.explain, true);
  assert.equal(parseCli(['export', '--ids-file', 'ids.txt', '--out', 'd']).idsFile, 'ids.txt');
  assert.deepEqual(parseCli(['--help']), { help: true });
  assert.deepEqual(parseCli(['--version']), { version: true });
});

test('rejects no verb, unknown verbs (there are no write verbs), and stray positionals', () => {
  assert.throws(() => parseCli([]), /no verb/);
  for (const w of ['send', 'trash', 'delete', 'modify', 'label', 'draft']) {
    assert.throws(() => parseCli([w]), /unknown verb/);
  }
  assert.throws(() => parseCli(['list', 'from:x']), /unexpected argument/);
  assert.throws(() => parseCli(['list', '--bogus']), (e) => e.exitCode === 2);
});

test('export needs exactly one source and an --out; flags are verb-scoped', () => {
  assert.throws(() => parseCli(['export', '--out', 'd']), /exactly one of/);
  assert.throws(() => parseCli(['export', '-q', 'x', '--ids-file', 'f', '--out', 'd']), /exactly one of/);
  assert.throws(() => parseCli(['export', '-q', 'x']), /needs --out/);
  assert.throws(() => parseCli(['export', '-q', '  ', '--out', 'd']), /empty/);
  assert.throws(() => parseCli(['list']), /needs --query/);
  assert.throws(() => parseCli(['list', '-q', 'x', '--out', 'd']), /does not apply to list/);
  assert.throws(() => parseCli(['whoami', '--explain']), /does not apply to whoami/);
  assert.throws(() => parseCli(['auth', '--live']), /does not apply to auth/);
  assert.throws(() => parseCli(['list', '-q', 'x', '--max', '5001']), /ceiling/);
});

test('accounts must be plain addresses — nothing that could reshape the token path', () => {
  assert.equal(assertAccount(' Rob@Gmail.com '), 'rob@gmail.com');
  for (const bad of ['rob', '../x@y.com', 'a/b@c.com', 'a@b', 'a@b..com', '']) {
    assert.throws(() => assertAccount(bad), /not an email address/, bad);
  }
  assert.equal(path.basename(tokenPath('Me@Example.com', '/t')), 'me@example.com.json');
});

test('ids file: one hex id per line, comments and blanks ignored, deduped, junk refused', () => {
  assert.deepEqual(parseIdsFile('18f0a1b2c3d4e5f6\n\n# note\n18F0A1B2C3D4E5F6\n190aa  # trailing\n'.replace('190aa', '190aabbccdd')),
    ['18f0a1b2c3d4e5f6', '190aabbccdd']);  // pragma: allowlist secret
  assert.throws(() => parseIdsFile('18f0a1b2c3d4e5f6\n../../etc/passwd\n'), /line 2/);
  assert.throws(() => parseIdsFile('zzzzzzzz'), /not a Gmail message id/);
});

// ---- OAuth ------------------------------------------------------------------

test('PKCE S256: verifier length and challenge = base64url(sha256(verifier))', () => {
  const { verifier, challenge, method } = makePkce();
  assert.equal(method, 'S256');
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  // RFC 7636 appendix B test vector
  const fixed = makePkce(Buffer.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]));
  assert.equal(fixed.verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');  // pragma: allowlist secret
  assert.equal(fixed.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');  // pragma: allowlist secret
  assert.notEqual(makePkce().verifier, makePkce().verifier);
});

test('state is random and URL-safe', () => {
  const a = makeState();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, makeState());
});

test('auth URL requests exactly gmail.readonly, offline + consent, PKCE, loopback', () => {
  const url = new URL(buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:53123', challenge: 'ch', state: 'st', loginHint: 'me@example.com' }));
  const p = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(p.get('scope'), SCOPE);
  assert.deepEqual([...scopeSet(p.get('scope'))], [SCOPE]);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('code_challenge'), 'ch');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('state'), 'st');
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('login_hint'), 'me@example.com');
  assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:53123');
  assert.equal(p.get('include_granted_scopes'), null);
  assert.equal(new URL(buildAuthUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1', challenge: 'c', state: 's' })).searchParams.get('login_hint'), null);
});

test('auth URL refuses any other scope and any non-loopback redirect', () => {
  const base = { clientId: 'c', redirectUri: 'http://127.0.0.1:9', challenge: 'c', state: 's' };
  for (const scope of ['https://www.googleapis.com/auth/gmail.modify', `${SCOPE} https://www.googleapis.com/auth/gmail.send`, 'https://mail.google.com/']) {
    assert.throws(() => buildAuthUrl({ ...base, scope }), /refusing to request scope/);
  }
  assert.throws(() => buildAuthUrl({ ...base, redirectUri: 'http://localhost:8000/oauth2callback' }), /loopback/);
  assert.throws(() => buildAuthUrl({ ...base, redirectUri: 'https://evil.example/cb' }), /loopback/);
});

test('granted scope must be exactly gmail.readonly', () => {
  assert.doesNotThrow(() => assertScopeExact(SCOPE));
  assert.doesNotThrow(() => assertScopeExact(` ${SCOPE} `));
  assert.throws(() => assertScopeExact(`${SCOPE} https://www.googleapis.com/auth/gmail.modify`), /extra scopes/);
  assert.throws(() => assertScopeExact('https://www.googleapis.com/auth/gmail.modify'), /tick the Gmail read box/);
  assert.throws(() => assertScopeExact(''), /\(none\)/);
  assert.throws(() => assertScopeExact(undefined), /\(none\)/);
});

test('loopback callback: state must match; error and code are distinguished', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(parseCallback(q('state=abc&code=4/xyz'), 'abc'), { code: '4/xyz' });
  assert.ok(parseCallback(q('state=nope&code=4/xyz'), 'abc').ignore);
  assert.ok(parseCallback(q('code=4/xyz'), 'abc').ignore);
  assert.match(parseCallback(q('state=abc&error=access_denied'), 'abc').error, /access_denied/);
  assert.ok(parseCallback(q('state=abc'), 'abc').ignore);
});

// ---- token cache ------------------------------------------------------------

test('token file: written 600 in a 700 dir, read back, loose mode refused', () => {
  const dir = path.join(tmp(), 'gmail-harvest');
  const file = path.join(dir, 'me@example.com.json');
  try {
    writeTokenFile(file, { access_token: 'a', refresh_token: 'r', scope: SCOPE, expiry: '2099-01-01T00:00:00Z' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(readTokenFile(file).refresh_token, 'r');
    chmodSync(file, 0o644);
    assert.throws(() => readTokenFile(file), /group\/world readable.*chmod 600/);
    chmodSync(file, 0o640);
    assert.throws(() => readTokenFile(file), /refuses to read/);
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('token file with the wrong scope, bad JSON, or missing is refused', () => {
  const dir = tmp();
  try {
    const wide = path.join(dir, 'a@b.com.json');
    writeFileSync(wide, JSON.stringify({ scope: `${SCOPE} https://www.googleapis.com/auth/gmail.send` }), { mode: 0o600 });
    assert.throws(() => readTokenFile(wide), /accepts exactly/);
    const junk = path.join(dir, 'c@d.com.json');
    writeFileSync(junk, '{', { mode: 0o600 });
    assert.throws(() => readTokenFile(junk), /not valid JSON/);
    assert.throws(() => readTokenFile(path.join(dir, 'none@x.com.json')), /run `gmh auth`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('account selection: explicit, the only one, none, several', () => {
  const dir = tmp();
  try {
    assert.equal(pickAccount('x@y.com', dir), 'x@y.com');
    assert.throws(() => pickAccount(null, dir), /no Gmail account authorized/);
    writeFileSync(path.join(dir, 'a@b.com.json'), '{}', { mode: 0o600 });
    writeFileSync(path.join(dir, 'a@b.com.json.123.tmp'), '{}', { mode: 0o600 });
    assert.equal(pickAccount(null, dir), 'a@b.com');
    writeFileSync(path.join(dir, 'c@d.com.json'), '{}', { mode: 0o600 });
    assert.deepEqual(listAccounts(dir), ['a@b.com', 'c@d.com']);
    assert.throws(() => pickAccount(null, dir), /pass --account/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- OAuth client -----------------------------------------------------------

test('client id is parsed from the Keychain item attributes', () => {
  const out = 'keychain: "/Users/x/Library/Keychains/login.keychain-db"\nattributes:\n    "acct"<blob>="123-abc.apps.googleusercontent.com"\n    "svce"<blob>="google-workspace-oauth"\n';
  assert.equal(parseKeychainAccount(out), '123-abc.apps.googleusercontent.com');
  assert.equal(parseKeychainAccount('"acct"<blob>=<NULL>'), null);
  assert.equal(parseKeychainAccount(''), null);
});

test('client: Keychain first (secret via -w, never on argv), environment fallback, else a plain sentence', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('-w')) return { stdout: 'shh-secret\n', stderr: '' };
    return { stdout: '    "acct"<blob>="kc-id"\n', stderr: '' };
  };
  const c = await resolveClient({ env: { GOOGLE_OAUTH_CLIENT_ID: 'env-id', GOOGLE_OAUTH_CLIENT_SECRET: 'env-s' }, run });
  assert.deepEqual([c.clientId, c.clientSecret], ['kc-id', 'shh-secret']);
  assert.match(c.source, /keychain/);
  assert.ok(calls.every(([cmd, ...args]) => cmd === 'security' && !args.includes('shh-secret')));

  const missing = async () => { throw new Error('The specified item could not be found'); };
  const e = await resolveClient({ env: { GOOGLE_OAUTH_CLIENT_ID: 'env-id', GOOGLE_OAUTH_CLIENT_SECRET: 'env-s' }, run: missing });
  assert.deepEqual([e.clientId, e.source], ['env-id', 'environment']);
  await assert.rejects(resolveClient({ env: {}, run: missing }), /security add-generic-password -U -s google-workspace-oauth/);
});

// ---- raw decode, index, resume ----------------------------------------------

test('base64url raw decodes to the exact bytes, including CRLF and 8-bit content', () => {
  const bytes = Buffer.concat([Buffer.from('From: a@b\r\nSubject: =?UTF-8?B?w6k=?=\r\n\r\nbody é\r\n'), Buffer.from([0x00, 0xff, 0xfe, 0x80])]);
  const raw = bytes.toString('base64url');
  const out = decodeRaw(raw);
  assert.ok(out.equals(bytes));
  assert.equal(sha256(out), createHash('sha256').update(bytes).digest('hex'));
  assert.ok(decodeRaw(bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')).equals(bytes)); // padded form
  assert.throws(() => decodeRaw(bytes.toString('base64').replace(/_/g, '/') + '+/'), /not base64url/);
  assert.throws(() => decodeRaw(''), /no raw body/);
  assert.throws(() => decodeRaw(undefined), /no raw body/);
  assert.throws(() => decodeRaw('QUJDR'), /round-trip/);
});

test('index: latest record per id wins; torn lines are counted, not fatal', () => {
  const text = [
    JSON.stringify({ id: 'aaa111', error: 'HTTP 500' }),
    JSON.stringify({ id: 'aaa111', sha256: 'x', bytes: 10 }),
    JSON.stringify({ id: 'bbb222', sha256: 'y', bytes: 5 }),
    '{"id": "ccc3',
    '',
    '42',
  ].join('\n');
  const { records, malformed } = readIndex(text);
  assert.equal(records.get('aaa111').bytes, 10);
  assert.equal(records.size, 2);
  assert.equal(malformed, 2);
});

test('resume: skip only a successful record whose .eml exists with the recorded size', () => {
  const { records } = readIndex([
    JSON.stringify({ id: 'a1a1a1', sha256: 's', bytes: 10 }),   // present, right size → skip
    JSON.stringify({ id: 'b2b2b2', sha256: 's', bytes: 10 }),   // file missing → fetch
    JSON.stringify({ id: 'c3c3c3', sha256: 's', bytes: 10 }),   // wrong size (torn) → fetch
    JSON.stringify({ id: 'd4d4d4', error: 'not found' }),       // failed before → retry
  ].join('\n'));
  const sizes = { a1a1a1: 10, c3c3c3: 7, d4d4d4: 3 };
  const plan = resumePlan(['a1a1a1', 'b2b2b2', 'c3c3c3', 'd4d4d4', 'e5e5e5'], records, (id) => sizes[id] ?? null);
  assert.deepEqual(plan.skipped, ['a1a1a1']);
  assert.deepEqual(plan.todo, ['b2b2b2', 'c3c3c3', 'd4d4d4', 'e5e5e5']);
});

// ---- output-dir containment -------------------------------------------------

test('out dir: refuses /, $HOME, and anything inside the Toolbelt tree (symlinks resolved)', () => {
  const root = tmp();
  try {
    const home = path.join(root, 'home');
    const belt = path.join(home, 'Toolbelt');
    mkdirSync(path.join(belt, 'tools'), { recursive: true });
    const opts = { home, roots: [belt], cwd: home };
    assert.throws(() => checkOutDir('/', opts), /refused/);
    assert.throws(() => checkOutDir(home, opts), /home directory itself/);
    assert.throws(() => checkOutDir('~', opts), /home directory itself/);
    assert.throws(() => checkOutDir('.', opts), /home directory itself/);
    assert.throws(() => checkOutDir(belt, opts), /inside the Toolbelt tree/);
    assert.throws(() => checkOutDir(path.join(belt, 'tools', 'new', 'deep'), opts), /inside the Toolbelt tree/);
    assert.throws(() => checkOutDir('~/Toolbelt/mail', opts), /inside the Toolbelt tree/);
    symlinkSync(path.join(belt, 'tools'), path.join(home, 'sneaky'));
    assert.throws(() => checkOutDir(path.join(home, 'sneaky', 'mail'), opts), /inside the Toolbelt tree/);
    assert.equal(checkOutDir('~/mail-export', opts), path.join(home, 'mail-export'));
    assert.equal(checkOutDir(path.join(home, 'Toolbelt-mail'), opts), path.join(home, 'Toolbelt-mail'));
    assert.equal(checkOutDir('rel/out', opts), path.join(home, 'rel', 'out'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- retries and audit ------------------------------------------------------

test('retry: honors Retry-After (seconds or date), else exponential backoff, capped', () => {
  const rand = () => 0;
  assert.equal(retryDelayMs(1, null, { rand }), 1000);
  assert.equal(retryDelayMs(2, null, { rand }), 2000);
  assert.equal(retryDelayMs(3, null, { rand }), 4000);
  assert.equal(retryDelayMs(1, '7', { rand }), 7000);
  assert.equal(retryDelayMs(1, '600', { rand }), 60_000);
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(retryDelayMs(1, 'Wed, 23 Sep 2026 12:00:05 GMT', { now, rand }), 5000);
  assert.equal(retryDelayMs(1, 'garbage', { rand }), 1000);
  assert.ok(isRetryable(429));
  assert.ok(isRetryable(503));
  assert.ok(isRetryable(403, 'userRateLimitExceeded'));
  assert.ok(!isRetryable(403, 'insufficientPermissions'));
  assert.ok(!isRetryable(404));
  assert.ok(!isRetryable(400));
});

test('audit line: timestamp and key=value fields only', () => {
  const line = auditLine({ verb: 'export', account: 'me@example.com', query: 'from:"x y"', count: 3, bytes: 1200, failures: 0, out: '/tmp/o', skip: undefined }, new Date('2026-09-23T00:00:00Z'));
  assert.equal(line, '[gmh audit] 2026-09-23T00:00:00.000Z verb="export" account="me@example.com" query="from:\\"x y\\"" count=3 bytes=1200 failures=0 out="/tmp/o"');
});

// ---- export end to end against an in-memory Gmail (no network) -------------

test('export: exact bytes, 600 files, metadata-only index, recorded failure, resume, exit codes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { MESSAGES, GONE } = await import('./fake-gmail.mjs');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const home = tmp();
  try {
    writeTokenFile(path.join(home, '.config', 'toolbelt', 'gmail-harvest', 'me@example.com.json'), {
      account: 'me@example.com', access_token: 'fake-access', refresh_token: 'fake-refresh',
      scope: SCOPE, expiry: '2099-01-01T00:00:00Z',
    });
    const out = path.join(home, 'export');
    const gmh = (...args) => spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'fake-gmail.mjs')).href, path.join(here, '..', 'gmh.mjs'), ...args], {
      env: { ...process.env, HOME: home, GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' }, encoding: 'utf8',
    });

    const pre = gmh('export', '--query', 'in:inbox', '--out', out, '--explain');
    assert.equal(pre.status, 0, pre.stderr);
    assert.match(pre.stdout, /4 match\(es\)/);
    assert.match(pre.stdout, /4 messages\.get/);
    assert.throws(() => statSync(out), /ENOENT/); // --explain writes nothing

    const first = gmh('export', '--query', 'in:inbox', '--out', out, '--json');
    assert.equal(first.status, 1, 'a per-message failure exits 1');
    const sum = JSON.parse(first.stdout);
    assert.deepEqual([sum.matched, sum.exported, sum.failed, sum.skipped], [4, 3, 1, 0]);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    for (const [id, bytes] of Object.entries(MESSAGES)) {
      const f = path.join(out, `${id}.eml`);
      assert.ok(readFileSync(f).equals(bytes), `${id} byte-exact`);
      assert.equal(statSync(f).mode & 0o777, 0o600);
    }
    assert.equal(statSync(path.join(out, 'index.jsonl')).mode & 0o777, 0o600);
    const idx = readFileSync(path.join(out, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(idx.length, 4);
    assert.deepEqual(idx.find((r) => r.id === GONE).error, 'not found (deleted, or not in this mailbox)');
    const ok = idx.find((r) => r.id === '18f0000000000002');
    assert.deepEqual(Object.keys(ok).sort(), ['bytes', 'exported_at', 'historyId', 'id', 'internalDate', 'labelIds', 'sha256', 'sizeEstimate', 'threadId']);
    assert.equal(ok.sha256, sha256(MESSAGES['18f0000000000002']));
    assert.ok(!readdirSync(out).some((f) => f.endsWith('.part')));
    assert.match(first.stderr, /\[gmh audit\] \S+ verb="export" account="me@example.com" query="in:inbox" count=3 bytes=\d+ failures=1/);
    assert.ok(!/fake-access|fake-refresh/.test(first.stderr + first.stdout), 'tokens never printed');
    const log = readFileSync(path.join(home, '.local', 'share', 'toolbelt', 'gmail-harvest', 'audit.log'), 'utf8');
    assert.match(log, /verb="export"/);
    assert.equal(statSync(path.join(home, '.local', 'share', 'toolbelt', 'gmail-harvest', 'audit.log')).mode & 0o777, 0o600);

    const again = gmh('export', '--query', 'in:inbox', '--out', out, '--json');
    const s2 = JSON.parse(again.stdout);
    assert.deepEqual([s2.exported, s2.skipped, s2.failed], [0, 3, 1], 'resume skips done ids and retries the failed one');

    const idsFile = path.join(home, 'ids.txt');
    writeFileSync(idsFile, '18f0000000000001\n18f0000000000003\n');
    const byIds = gmh('export', '--ids-file', idsFile, '--out', path.join(home, 'by-ids'), '--json');
    assert.equal(byIds.status, 0, byIds.stderr);
    assert.equal(JSON.parse(byIds.stdout).exported, 2);
    const tooMany = gmh('export', '--ids-file', idsFile, '--out', path.join(home, 'x'), '--max', '1');
    assert.equal(tooMany.status, 2);
    assert.match(tooMany.stderr, /above --max 1/);

    chmodSync(path.join(home, '.config', 'toolbelt', 'gmail-harvest', 'me@example.com.json'), 0o644);
    const loose = gmh('whoami');
    assert.equal(loose.status, 1);
    assert.match(loose.stderr, /chmod 600/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


// ---- links (local .eml parsing, no network) --------------------------------------------

const eml = (headers, body) => Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'latin1');

test('links: parseCli needs --eml and validates --match', () => {
  assert.throws(() => parseCli(['links']), /needs --eml/);
  assert.throws(() => parseCli(['links', '--eml', 'a.eml', '--match', '(']), /regular expression/);
  assert.equal(parseCli(['links', '--eml', 'a.eml', '--match', 'unsub']).match.test('Unsubscribe'), true);
  assert.throws(() => parseCli(['links', '--eml', 'a.eml', '--query', 'x']), /does not apply/);
});

test('links: quoted-printable HTML inside multipart/alternative, entities decoded, hrefs exact', () => {
  const html = '<p><a href=3D"https://x.com/u?a=3D1&amp;b=3D2">Email&#160;Pre=\r\nferences</a> <a href=3D"#top">top</a> <a href=3D"mailto:h@x.com"><img src=3D"i.png"></a></p>';
  const raw = eml(['Content-Type: multipart/alternative; boundary="b1"'], [
    '--b1', 'Content-Type: text/plain; charset=utf-8', '', 'plain https://ignored.example', '--b1',
    'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable', '', html, '--b1--', ''].join('\r\n'));
  assert.deepEqual(extractLinks(raw), [
    { text: 'Email Preferences', href: 'https://x.com/u?a=1&b=2' },
    { text: '(image)', href: 'mailto:h@x.com' },
  ]);
});

test('links: base64 HTML, nested multipart, attachments skipped', () => {
  const b64 = Buffer.from('<a href="https://y.org/opt-out">Opt out ›</a>').toString('base64');
  const raw = eml(['Content-Type: multipart/mixed; boundary=outer'], [
    '--outer', 'Content-Type: multipart/related; boundary=inner', '', '--inner',
    'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64, '--inner--',
    '--outer', 'Content-Type: text/html', 'Content-Disposition: attachment; filename=x.html', '', '<a href="https://evil.example">x</a>',
    '--outer--', ''].join('\r\n'));
  assert.deepEqual(extractLinks(raw), [{ text: 'Opt out ›', href: 'https://y.org/opt-out' }]);
});

test('links: text-only mail falls back to bare URLs', () => {
  const raw = eml(['Content-Type: text/plain; charset=utf-8'], 'Pay here: https://pay.example/inv/1 (thanks)');
  assert.deepEqual(extractLinks(raw), [{ text: '(plain text)', href: 'https://pay.example/inv/1' }]);
  assert.equal(mimeTexts(raw).html, null);
});

test('links: quoted-printable decoding keeps bytes and drops soft breaks', () => {
  assert.equal(decodeQuotedPrintable(Buffer.from('caf=C3=A9 =\r\nok')).toString('utf8'), 'café ok');
});
