// Unit tests for the pure parts of hp.mjs and for the manifest/code agreement. No browser,
// no network: playwright-cli is replaced by a recording stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS, ALL_VERBS, containFilename, classifyEndpoint, validProfileName, parseArgs, main,
  findRefusedFlag, REFUSED_FLAGS, CONFIG_FILE, EXEC_TIMEOUT_MS, LAUNCH_WAIT_MS, PENDING_TTL_S } from '../hp.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(DIR, '..', 'toolbelt.json'), 'utf8'));

// The stub playwright-cli keeps its own registry, exactly as the real one does (keyed to the
// tool dir, not to hp's home): `attach` marks a session attached, `detach` clears it, and
// `list --json` reports it. `registry` is shared across harnesses built from the same object so
// a test can point a fresh hp home at an already-attached session.
function harness(extra = {}, registry = new Set()) {
  const home = mkdtempSync(path.join(tmpdir(), 'hp-test-'));
  const out = [], err = [], calls = [], spawns = [];
  const env = {
    home, outputDir: path.join(home, 'out'), bin: path.join(home, 'fake-playwright-cli'),
    out: (s) => out.push(s), err: (s) => err.push(s),
    tty: { has: () => false, readLine: () => null, why: 'test: no tty' },
    spawn: (bin, args, opts) => {
      calls.push(args); spawns.push(opts);
      const session = args.find((a) => a.startsWith('-s='))?.slice(3) ?? 'default';
      const verb = args.find((a) => !a.startsWith('-'));
      if (verb === 'attach') registry.add(session);
      if (verb === 'detach') registry.delete(session);
      if (verb === 'list') return { status: 0, stdout: JSON.stringify({ browsers: [...registry].map((name) => ({ name, attached: true })) }), stderr: '' };
      return { status: 0, stdout: `ran ${args.join(' ')}`, stderr: '' };
    },
    ...extra,
  };
  writeFileSync(env.bin, '#!/bin/sh\n');
  return { env, out, err, calls, spawns, home, registry };
}
const isList = (c) => c[0] === 'list';

test('ceilings hold their values', () => {
  assert.equal(EXEC_TIMEOUT_MS, 60_000);
  assert.equal(LAUNCH_WAIT_MS, 15_000);
  assert.equal(PENDING_TTL_S, 900);
});

test('manifest verbs[] mirrors the VERBS table', () => {
  const byName = Object.fromEntries(manifest.verbs.map((v) => [v.name, v]));
  for (const v of VERBS.read) assert.equal(byName[v]?.tier, 'read', `${v} should be read`);
  for (const v of VERBS.interact) { assert.equal(byName[v]?.tier, 'write-gated', `${v} should be write-gated`); assert.equal(byName[v].gate, 'containment'); }
  assert.equal(byName.connect.tier, 'write-gated'); assert.equal(byName.connect.gate, 'typed-echo');
  assert.equal(byName.approve.tier, 'write-gated'); assert.equal(byName.approve.gate, 'tty');
  for (const v of manifest.verbs) if (v.tier !== 'never') assert.ok(ALL_VERBS.includes(v.name), `${v.name} in manifest but not in code`);
});

test('containFilename keeps files under the output dir', () => {
  const out = '/x/out';
  assert.equal(containFilename('a.png', out).resolved, '/x/out/a.png');
  assert.equal(containFilename('sub/a.png', out).resolved, '/x/out/sub/a.png');
  assert.equal(containFilename('/tmp/a.png', out).ok, false);
  assert.equal(containFilename('../a.png', out).ok, false);
  assert.equal(containFilename('sub/../../a.png', out).ok, false);
  assert.equal(containFilename('', out).ok, false);
});

test('classifyEndpoint: channels are the real profile; non-loopback refused without --remote-ok', () => {
  assert.equal(classifyEndpoint('chrome').profileClass, 'real');
  const l = classifyEndpoint('http://127.0.0.1:9222'); assert.ok(l.ok && l.loopback); assert.equal(l.port, 9222);
  assert.ok(classifyEndpoint('ws://localhost:9222/devtools/browser/abc').ok);
  assert.ok(classifyEndpoint('http://[::1]:9222').ok);
  assert.equal(classifyEndpoint('http://10.0.0.5:9222').ok, false);
  assert.ok(classifyEndpoint('http://10.0.0.5:9222', { remoteOk: true }).ok);
  assert.equal(classifyEndpoint('not a url').ok, false);
  assert.equal(classifyEndpoint('file:///etc/passwd').ok, false);
});

test('validProfileName is one path segment', () => {
  assert.ok(validProfileName('work')); assert.ok(validProfileName('a.b-c_1'));
  assert.equal(validProfileName('../x'), false); assert.equal(validProfileName('/Users/me/Library/Application Support/Google/Chrome'), false);
  assert.equal(validProfileName('..'), false); assert.equal(validProfileName(''), false);
});

test('parseArgs handles -s=, --k=v, --k v and booleans', () => {
  const p = parseArgs(['-s=dbg', 'screenshot', 'e5', '--filename', 'a.png', '--full-page', '--cdp=chrome']);
  assert.equal(p.session, 'dbg'); assert.deepEqual(p.args, ['screenshot', 'e5']);
  assert.deepEqual(p.flags, { filename: 'a.png', 'full-page': true, cdp: 'chrome' });
});

test('unknown verb is a usage error and runs nothing', async () => {
  const h = harness();
  assert.equal(await main(['kill-all'], h.env), 2);
  assert.equal(h.calls.length, 0);
});

test('screenshot --filename is rewritten to the output dir; escapes refused', async () => {
  const h = harness();
  assert.equal(await main(['screenshot', '--filename=shot.png'], h.env), 0);
  assert.deepEqual(h.calls[0], ['screenshot', `--filename=${path.join(h.env.outputDir, 'shot.png')}`]);
  assert.equal(await main(['screenshot', '--filename=/tmp/shot.png'], h.env), 2);
  assert.equal(await main(['-s=a', 'state-save', '../x.json'], h.env), 2);
  assert.equal(h.calls.length, 1);
});

test('page actions run free on the isolated profile and carry the session flag', async () => {
  const h = harness();
  assert.equal(await main(['-s=iso', 'click', 'e5'], h.env), 0);
  assert.deepEqual(h.calls.filter((c) => !isList(c))[0], ['-s=iso', 'click', 'e5']);
  assert.deepEqual(h.calls[0], ['list', '--json']); // the gate asked playwright-cli first
});

test('connect to a real profile without a tty stages and attaches nothing; --yes is refused', async () => {
  const h = harness();
  assert.equal(await main(['-s=real', 'connect', '--cdp=chrome'], h.env), 3);
  assert.equal(h.calls.length, 0);
  const pending = readdirSync(path.join(h.home, 'pending')).filter((f) => f.endsWith('.json'));
  assert.equal(pending.length, 1);
  const rec = JSON.parse(readFileSync(path.join(h.home, 'pending', pending[0]), 'utf8'));
  assert.equal(rec.flags.cdp, 'chrome'); assert.equal(rec.session, 'real');
  assert.ok(h.err.some((l) => l.includes('toolbelt approve playwright')));
  assert.equal(await main(['-s=real', 'connect', '--cdp=chrome', '--yes'], h.env), 2);
  assert.equal(h.calls.length, 0);
});

test('connect needs a session name and exactly one target', async () => {
  const h = harness();
  assert.equal(await main(['connect', '--cdp=chrome'], h.env), 2);
  assert.equal(await main(['-s=x', 'connect', '--cdp=chrome', '--extension'], h.env), 2);
  assert.equal(await main(['-s=x', 'connect', '--cdp=http://10.1.1.1:9222'], h.env), 2);
});

test('a wrong typed echo at the tty aborts; the exact target attaches and is audited', async () => {
  let answer = 'yes';
  const h = harness({ tty: { has: () => true, readLine: () => answer, why: '' } });
  assert.equal(await main(['-s=real', 'connect', '--cdp=chrome'], h.env), 1);
  assert.equal(h.calls.length, 0);
  answer = 'chrome';
  assert.equal(await main(['-s=real', 'connect', '--cdp=chrome'], h.env), 0);
  assert.deepEqual(h.calls[0], ['-s=real', 'attach', '--cdp=chrome', `--config=${CONFIG_FILE}`]);
  const sessions = JSON.parse(readFileSync(path.join(h.home, 'sessions.json'), 'utf8'));
  assert.equal(sessions.real.profileClass, 'real');
  const audit = readFileSync(path.join(h.home, 'audit.log'), 'utf8');
  assert.match(audit, /verb=connect session=real endpoint=chrome profile=real result=ok/);
});

test('on an attached real profile, page actions need --attached-writes; reads stay free', async () => {
  const h = harness({ tty: { has: () => true, readLine: () => 'chrome', why: '' } });
  assert.equal(await main(['-s=real', 'connect', '--cdp=chrome'], h.env), 0);
  assert.equal(await main(['-s=real', 'snapshot'], h.env), 0);
  assert.equal(await main(['-s=real', 'click', 'e1'], h.env), 2);
  assert.equal(h.calls.filter((c) => c.includes('click')).length, 0);
  assert.equal(await main(['-s=real', 'click', 'e1', '--attached-writes'], h.env), 0);
  assert.deepEqual(h.calls.at(-1), ['-s=real', 'click', 'e1']);
  assert.deepEqual(h.calls.at(-2), ['list', '--json']);
  assert.match(readFileSync(path.join(h.home, 'audit.log'), 'utf8'), /verb=click session=real endpoint=chrome profile=real target=e1 flag=--attached-writes/);
  // close detaches and leaves the browser running
  assert.equal(await main(['-s=real', 'close'], h.env), 0);
  assert.deepEqual(h.calls.at(-1), ['-s=real', 'detach']);
  assert.equal(JSON.parse(readFileSync(path.join(h.home, 'sessions.json'), 'utf8')).real, undefined);
  assert.equal(h.registry.has('real'), false);
  // detached: page actions are free again
  assert.equal(await main(['-s=real', 'click', 'e1'], h.env), 0);
});

test('the gate reads playwright-cli, not hp home: a fresh HP_HOME does not unlock an attached session', async () => {
  // The reviewer's bypass: attach under one home, then act with HP_HOME pointed at an empty dir.
  const a = harness({ tty: { has: () => true, readLine: () => 'chrome', why: '' } });
  assert.equal(await main(['-s=foo', 'connect', '--cdp=chrome'], a.env), 0);
  assert.ok(a.registry.has('foo'));
  const b = harness({}, a.registry); // same playwright-cli registry, empty hp home, no tty
  assert.equal(existsSync(path.join(b.home, 'sessions.json')), false);
  assert.equal(await main(['-s=foo', 'click', 'e1', '--explain'], b.env), 0);
  assert.ok(b.out.at(-1).includes('ATTACHED') && b.out.at(-1).includes('needs --attached-writes'), b.out.at(-1));
  assert.equal(await main(['-s=foo', 'click', 'e1'], b.env), 2);
  assert.equal(b.calls.filter((c) => c.includes('click')).length, 0);
  assert.ok(b.err.at(-1).includes('--attached-writes'));
  assert.equal(existsSync(path.join(b.home, 'audit.log')), false);
  // the same holds for a session hp never recorded anywhere
  a.registry.add('ghost');
  assert.equal(await main(['-s=ghost', 'fill', 'e2', 'x'], b.env), 2);
  assert.equal(b.calls.filter((c) => c.includes('fill')).length, 0);
  // the loud flag is still honored there, and audited with the endpoint hp cannot name
  assert.equal(await main(['-s=foo', 'click', 'e1', '--attached-writes'], b.env), 0);
  assert.deepEqual(b.calls.at(-1), ['-s=foo', 'click', 'e1']);
  assert.match(readFileSync(path.join(b.home, 'audit.log'), 'utf8'), /verb=click session=foo endpoint=.*profile=real target=e1 flag=--attached-writes/);
});

test('forged hp records cannot unlock an attached session: sessions.json + launched/ naming a live pid still refuse', async () => {
  const h = harness({}, new Set(['foo']));
  mkdirSync(path.join(h.home, 'launched'), { recursive: true });
  writeFileSync(path.join(h.home, 'sessions.json'), JSON.stringify({ foo: { mode: 'attached', profileClass: 'isolated', endpoint: 'http://127.0.0.1:9222', launchedPort: 9222 } }));
  writeFileSync(path.join(h.home, 'launched', '9222.json'), JSON.stringify({ port: 9222, pid: process.pid, profileDir: '/whatever', endpoint: 'http://127.0.0.1:9222' }));
  assert.equal(await main(['-s=foo', 'click', 'e1', '--explain'], h.env), 0);
  assert.ok(h.out.at(-1).includes('ATTACHED'), h.out.at(-1));
  assert.equal(await main(['-s=foo', 'click', 'e1'], h.env), 2);
  assert.equal(h.calls.filter((c) => c.includes('click')).length, 0);
  assert.equal(existsSync(path.join(h.home, 'audit.log')), false);
  // a session attached to a Chrome hp genuinely launched is gated the same way
  const l = harness({ tty: { has: () => false, readLine: () => null, why: '' } });
  mkdirSync(path.join(l.home, 'launched'), { recursive: true });
  writeFileSync(path.join(l.home, 'launched', '9333.json'), JSON.stringify({ port: 9333, pid: process.pid, profileDir: path.join(l.home, 'profiles', 'x') }));
  assert.equal(await main(['-s=dbg', 'connect', '--cdp=http://127.0.0.1:9333'], l.env), 0); // ungated attach
  assert.equal(await main(['-s=dbg', 'click', 'e1'], l.env), 2);
  assert.equal(await main(['-s=dbg', 'click', 'e1', '--attached-writes'], l.env), 0);
  assert.match(readFileSync(path.join(l.home, 'audit.log'), 'utf8'), /verb=click session=dbg endpoint=http:\/\/127\.0\.0\.1:9333 profile=real/);
});

test('option-like positionals after -- are refused: no route to an attached session through upstream argv', async () => {
  const h = harness({}, new Set(['real']));
  for (const argv of [
    ['click', 'e1', '--', '-s=real'], ['click', 'e1', '--', '-s', 'real'], ['-s=iso', 'click', 'e1', '--', '-s=real'],
    ['click', 'e1', '--', '--config=/tmp/c.json'], ['click', 'e1', '--', '--session', 'real'], ['click', 'e1', '-t'],
    ['fill', 'e1', '--', '-s=real', 'text'],
  ]) {
    assert.equal(await main(argv, h.env), 2, argv.join(' '));
  }
  assert.equal(h.calls.filter((c) => c[0] !== 'list').length, 0);
  assert.ok(h.err.every((l) => l.includes('not accepted')));
  assert.equal(findRefusedFlag('click', {}, ['e1', '-s=real']), '-s');
  assert.equal(findRefusedFlag('click', {}, ['e1', '-1']), '-1'); // upstream reads -1 as an option too
});

test('single-character flag keys are refused on every verb: --s is upstream\'s --session alias', async () => {
  const h = harness({}, new Set(['real']));
  for (const argv of [
    ['click', 'e1', '--s=real'], ['click', 'e1', '--s', 'real'], ['click', 'e1', '--S=real'], ['click', 'e1', '--g=x'],
    ['snapshot', '--s=real'], ['-s=iso', 'goto', 'https://x', '--s=real'], ['click', '-1', 'real'], ['click', 'e1', '--', '-1'],
    ['connect', '--cdp=chrome', '--s=real'], ['launch-debug', '--s=x'], ['status', '--v'],
  ]) {
    assert.equal(await main(argv, h.env), 2, argv.join(' '));
  }
  assert.equal(h.calls.filter((c) => c[0] !== 'list').length, 0);
  assert.ok(REFUSED_FLAGS.includes('s'));
  assert.equal(findRefusedFlag('click', { s: 'real' }), 's');
  assert.equal(findRefusedFlag('click', { g: 'x' }), 'g');
  assert.equal(findRefusedFlag('click', { headed: true }), null);
});

test('navigation is an action: goto/reload/go-back/go-forward are gated on an attached session; open is refused there', async () => {
  const h = harness({}, new Set(['real']));
  for (const argv of [['-s=real', 'goto', 'https://site/logout'], ['-s=real', 'reload'], ['-s=real', 'go-back'], ['-s=real', 'go-forward']]) {
    assert.equal(await main(argv, h.env), 2, argv.join(' '));
  }
  assert.equal(h.calls.filter((c) => c[0] !== 'list').length, 0);
  assert.equal(existsSync(path.join(h.home, 'audit.log')), false);
  assert.equal(await main(['-s=real', 'goto', 'https://site/logout', '--attached-writes'], h.env), 0);
  assert.deepEqual(h.calls.at(-1), ['-s=real', 'goto', 'https://site/logout']);
  assert.match(readFileSync(path.join(h.home, 'audit.log'), 'utf8'), /verb=goto session=real .*target=https:\/\/site\/logout flag=--attached-writes/);
  // open would make upstream stop the attached session: refused even with the flag; close is the verb
  assert.equal(await main(['-s=real', 'open', 'https://x'], h.env), 2);
  assert.equal(await main(['-s=real', 'open', 'https://x', '--attached-writes'], h.env), 2);
  assert.ok(h.err.at(-1).includes('close -s real'));
  assert.equal(h.calls.filter((c) => c.includes('open')).length, 0);
  assert.equal(await main(['-s=real', 'open', 'https://x', '--explain'], h.env), 0);
  assert.ok(h.out.at(-1).includes('refused'));
  // free on a non-attached session
  assert.equal(await main(['-s=iso', 'goto', 'https://x'], h.env), 0);
  assert.equal(await main(['-s=iso', 'open', 'https://x'], h.env), 0);
  for (const v of ['open', 'goto', 'go-back', 'go-forward', 'reload']) assert.ok(VERBS.interact.includes(v), v);
});

test('--attached-writes is a bare flag: a value form is a usage error', async () => {
  const h = harness({}, new Set(['real']));
  assert.equal(await main(['-s=real', 'click', 'e1', '--attached-writes=false'], h.env), 2);
  assert.equal(await main(['-s=real', 'click', 'e1', '--attached-writes=true'], h.env), 2);
  assert.equal(await main(['-s=iso', 'click', 'e1', '--attached-writes=false'], h.env), 2);
  assert.equal(h.calls.filter((c) => c.includes('click')).length, 0);
  assert.equal(await main(['-s=real', 'click', 'e1', '--attached-writes'], h.env), 0);
});

test('when playwright-cli cannot report attached-ness, page actions are refused; reads still run', async () => {
  for (const listResult of [{ status: 1, stdout: '', stderr: 'boom' }, { status: 0, stdout: 'not json', stderr: '' }, { status: 0, stdout: '{}', stderr: '' }]) {
    const h = harness();
    const base = h.env.spawn;
    h.env.spawn = (bin, args, opts) => (args[0] === 'list' ? (h.calls.push(args), listResult) : base(bin, args, opts));
    assert.equal(await main(['-s=x', 'click', 'e1'], h.env), 2);
    assert.equal(h.calls.filter((c) => c.includes('click')).length, 0);
    assert.ok(h.err.at(-1).includes('cannot tell'));
    assert.equal(await main(['-s=x', 'snapshot'], h.env), 0);
  }
});

test('approve replays the staged connect after the typed echo; record is single use', async () => {
  const h = harness();
  await main(['-s=real', 'connect', '--cdp=chrome'], h.env);
  const code = readdirSync(path.join(h.home, 'pending'))[0].replace(/\.json$/, '');
  assert.equal(await main(['approve', code], h.env), 4); // no tty: record kept
  assert.ok(existsSync(path.join(h.home, 'pending', `${code}.json`)));
  h.env.tty = { has: () => true, readLine: () => 'chrome', why: '' };
  assert.equal(await main(['approve', code], h.env), 0);
  assert.deepEqual(h.calls[0], ['-s=real', 'attach', '--cdp=chrome', `--config=${CONFIG_FILE}`]);
  assert.equal(existsSync(path.join(h.home, 'pending', `${code}.json`)), false);
  assert.equal(await main(['approve', code], h.env), 1);
});

test('launch-debug refuses a profile path and --explain runs nothing', async () => {
  const h = harness();
  assert.equal(await main(['launch-debug', '--profile=/Users/me/Library/Application Support/Google/Chrome'], h.env), 2);
  assert.equal(await main(['launch-debug', '--explain'], h.env), 0);
  assert.ok(h.out.some((l) => l.includes('--user-data-dir=' + path.join(h.home, 'profiles', 'default'))));
  assert.equal(h.calls.length, 0);
});

test('profile/config/session re-pointing flags are refused on every forwarding verb, nothing runs', async () => {
  const h = harness();
  for (const argv of [
    ['open', '--config=/tmp/c.json'], ['open', '--config', '/tmp/c.json'], ['open', '--persistent'],
    ['open', '--profile=/Users/me/Library/Application Support/Google/Chrome'], ['open', '--cdp=http://127.0.0.1:9222'],
    ['open', '--', '--config=/tmp/c.json'], ['-s=a', 'click', 'e1', '--session=real'], ['snapshot', '--extension'],
    ['open', '--storage-state=/tmp/s.json'], ['open', '--config=/tmp/c.json', '--explain'],
  ]) {
    assert.equal(await main(argv, h.env), 2, argv.join(' '));
  }
  assert.equal(h.calls.length, 0);
  assert.ok(h.err.every((l) => l.includes('not accepted')));
  // the two verbs that consume one of these themselves
  assert.equal(findRefusedFlag('connect', { cdp: 'chrome' }), null);
  assert.equal(findRefusedFlag('connect', { cdp: 'chrome', config: 'x' }), 'config');
  assert.equal(findRefusedFlag('launch-debug', { profile: 'work' }), null);
  assert.equal(findRefusedFlag('launch-debug', { config: 'x' }), 'config');
  for (const f of ['config', 'persistent', 'profile', 'cdp', 'endpoint', 'extension', 'session']) assert.ok(REFUSED_FLAGS.includes(f));
});

test('open is pinned to the tool config; PLAYWRIGHT_MCP_*/PLAYWRIGHT_CLI_*/PWTEST_* never reach playwright-cli', async () => {
  const h = harness();
  const saved = { ...process.env };
  process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = 'http://127.0.0.1:9599';
  process.env.PLAYWRIGHT_MCP_USER_DATA_DIR = '/tmp/real';
  process.env.PLAYWRIGHT_MCP_CONFIG = '/tmp/c.json';
  process.env.PLAYWRIGHT_CLI_SESSION = 'real';
  process.env.PWTEST_DAEMON_SESSION_DIR = '/tmp/elsewhere';
  try {
    assert.equal(await main(['open', 'https://example.com'], h.env), 0);
    assert.deepEqual(h.calls.at(-1), ['open', 'https://example.com', `--config=${CONFIG_FILE}`]);
    const childEnv = h.spawns.at(-1).env;
    assert.equal(Object.keys(childEnv).filter((k) => /^PLAYWRIGHT_(MCP|CLI)_|^PWTEST_/.test(k)).length, 0);
    assert.equal(childEnv.NO_UPDATE_NOTIFIER, '1');
    assert.ok(existsSync(CONFIG_FILE));
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    assert.equal(cfg.browser.isolated, true);
    assert.equal(cfg.browser.cdpEndpoint, undefined); assert.equal(cfg.browser.userDataDir, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
