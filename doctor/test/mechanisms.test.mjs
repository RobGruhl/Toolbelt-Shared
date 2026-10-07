// The belt's mechanisms whose rules must not drift: the three-state auth classifier, the derived-
// artifact drift detector, and the permission-profile merge (adds, never removes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/authcmd.mjs';
import { diff, wrap, markers, current, replace } from '../lib/derived.mjs';
import { merge, profileFor } from '../lib/permissions.mjs';
import { renderSystems, systemsRows } from '../lib/systems.mjs';

test('auth classify: absent is quiet, expired is loud, live is live', () => {
  const pass = (id) => ({ id, status: 'pass' });
  const fail = (id) => ({ id, status: 'fail' });
  const warn = (id) => ({ id, status: 'warn' });
  assert.equal(classify([pass('auth.live_token')], false), 'live');
  assert.equal(classify([warn('auth.file_cache')], true), 'live', 'a loose file mode is not a dead credential');
  // nothing on disk, presence check fails, nothing else passes → never set up here
  assert.equal(classify([fail('auth.file_cache'), fail('auth.live_token')], false), 'absent');
  // the cache is there but the live probe fails → it WAS working; say so loudly
  assert.equal(classify([pass('auth.file_cache'), fail('auth.live_token')], true), 'expired');
  assert.equal(classify([fail('auth.live_token')], true), 'expired', 'a cache on disk with a failing probe is expired, not absent');
  assert.equal(classify([], false), 'absent');
  assert.equal(classify([], true), 'live', 'caches present and nothing to probe: nothing says it is dead');
});

test('derived: drift is line-level and names what changed; replace appends when no block exists', () => {
  const m = markers('x', 'hint');
  const a = wrap('| r1 |\n| r2 |', m);
  const b = wrap('| r1 |\n| r3 |', m);
  assert.equal(diff(a, a).drifted, false);
  const d = diff(a, b, 'T');
  assert.equal(d.drifted, true);
  assert.match(d.summary, /\+1 line\(s\) to add, -1 stale/);
  assert.match(d.summary, /r3/);
  assert.equal(diff(null, b).drifted, true);
  const text = replace('# Head\n', b, m);
  assert.equal(current(text, m), b);
  assert.equal(replace(text, a, m), '# Head\n' + a + '\n');
});

test('permissions: merge adds rules once and never removes existing ones', () => {
  const existing = { permissions: { allow: ['Bash(ls:*)'], deny: ['mcp__x__y'] }, other: 1 };
  const { settings, added } = merge(existing, { allow: ['Bash(ls:*)', 'mcp__a__b'], deny: ['mcp__x__y'] });
  assert.deepEqual(added, { allow: ['mcp__a__b'], deny: [] });
  assert.deepEqual(settings.permissions.allow.sort(), ['Bash(ls:*)', 'mcp__a__b']);
  assert.deepEqual(settings.permissions.deny, ['mcp__x__y']);
  assert.equal(settings.other, 1);
  const again = merge(settings, { allow: ['mcp__a__b'], deny: [] });
  assert.deepEqual(again.added, { allow: [], deny: [] });
});

test('permissions: only mcp-surface verbs become tool rules; write tiers never do', () => {
  const manifests = [
    { name: 't', mcp: { server_name: 's' }, verbs: [
      { name: 'read_it', tier: 'read', surface: 'mcp' },
      { name: 'cli_read', tier: 'read', surface: 'cli' },
      { name: 'send', tier: 'write-gated', gate: 'tty', surface: 'mcp' },
      { name: 'nuke', tier: 'never', surface: 'mcp' },
    ] },
    { name: 'nomcp', verbs: [{ name: 'q', tier: 'read' }] },
  ];
  const p = profileFor(manifests, '/tb');
  assert.ok(p.allow.includes('mcp__s__read_it'));
  assert.ok(!p.allow.some((r) => r.includes('cli_read') || r.includes('send') || r.includes('nomcp')));
  assert.deepEqual(p.deny, ['mcp__s__nuke']);
  assert.ok(p.allow.some((r) => r.startsWith('Bash(/tb/bin/toolbelt doctor')));
});

test('systems: one system from two entries needs a preferred one', () => {
  const mk = (name, systems, kind = 'tool') => ({ name, kind, systems, risk: { read_only: true } });
  const ok = [mk('a', [{ name: 'X', read: 'a q', preferred: true }]), mk('b', [{ name: 'X', read: 'b q' }])];
  assert.match(renderSystems(ok), /\| X \| `a` — also `b` \|/);
  const bad = [mk('a', [{ name: 'X', read: 'a q' }]), mk('b', [{ name: 'X', read: 'b q' }])];
  assert.deepEqual(systemsRows(bad).ambiguous, ['X: a, b']);
  assert.throws(() => renderSystems(bad), /preferred/);
  // same name, different kind → labelled by path
  const dup = [mk('hub', [{ name: 'S', read: 'x', preferred: true }]), mk('hub', [{ name: 'S', read: 'y' }], 'connector')];
  assert.match(renderSystems(dup), /`tools\/hub` — also `connectors\/hub`/);
});

test('secrets: rc classifier flags literals, passes references and paths', async () => {
  const { rcLiteralExports, envSecretNames } = await import('../lib/checks/secrets.mjs');
  const rc = [
    'export REGISTRY_TOKEN="abc123"',
    'export GITHUB_TOKEN=$(security find-generic-password -w -s gh)',
    'export NPM_TOKEN=$OTHER',
    'export EXAMPLE_API_KEY_FILE=~/.config/toolbelt/example.key',
    'export SSH_AUTH_SOCK=/tmp/x',
    'export EDITOR=vim',
    '# export OLD_SECRET=xyz',
    'CLIENT_SECRET=""',
  ].join('\n');
  assert.deepEqual(rcLiteralExports(rc), ['REGISTRY_TOKEN']);
  assert.deepEqual(envSecretNames({ FOO_TOKEN: 'x', BAR_TOKEN_FILE: '/p', EMPTY_SECRET: '', PATH: '/bin' }), ['FOO_TOKEN']);
});

test('secrets: key=value files count only when a KEY is secret-shaped (values are never read for meaning)', async () => {
  const { kvHasSecretKey } = await import('../lib/checks/secrets.mjs');
  assert.equal(kvHasSecretKey('APP_DEFAULT_PROJECT=foo\nAPP_REGION=US\n'), false);
  assert.equal(kvHasSecretKey('# comment\nexport WIKI_PAT=xyz\n'), true);
  assert.equal(kvHasSecretKey('[api]\nclient_secret: abc\n'), true);
  assert.equal(kvHasSecretKey('Client ID: abc\nAccess token: def\n'), true, 'a pasted credential note is not config');
  assert.equal(kvHasSecretKey('# only comments\n'), false);
});

test('setup: every step is explained — what, why, yes, no — before it asks', async () => {
  const { explainStep } = await import('../lib/setup.mjs');
  const ctx = { toolDir: process.cwd(), manifest: { name: 't' }, expand: (x) => x };
  const rich = explainStep({ action: 'git_config', key: 'core.hooksPath', value: '.githooks', description: 'D', why: 'W', yes: 'Y', no: 'N' }, ctx, 1, 2);
  for (const needle of ['Step 1 of 2 — D', 'what:', 'why:   W', 'yes →  Y', 'no  →  N']) assert.ok(rich.includes(needle), needle);
  const plain = explainStep({ run: 'npm ci' }, ctx, 2, 2);
  assert.match(plain, /yes →  runs `npm ci` in/);
  assert.match(plain, /no  →  skipped; nothing changes/);
  assert.ok(!plain.includes('why:'), 'no invented why');
});
