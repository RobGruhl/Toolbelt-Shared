import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmpVersions, expandPath } from '../lib/platform.mjs';
import { applySeverity, rollup, registry } from '../lib/runner.mjs';
import { registerReadProbe } from '../lib/checks/mcp.mjs';
import { classifyDataPlane, DATA_PLANE_PROBES, classifyArtifactory, artifactoryCredential, NETWORK_PATH_HINT, REGISTRY_DEFAULT_PATH } from '../lib/checks/auth.mjs';

test('cmpVersions handles majors, minors, v-prefix', () => {
  assert.ok(cmpVersions('22.22.0', '18') > 0);
  assert.ok(cmpVersions('v18.0.0', '18') === 0);
  assert.ok(cmpVersions('3.13', '3.13') === 0);
  assert.ok(cmpVersions('3.9', '3.13') < 0);   // numeric, not lexicographic
  assert.ok(cmpVersions('3.14.4', '3.13') > 0);
});

test('expandPath expands {TOOLBELT} and ~', () => {
  const opts = { toolbelt: '/tb', home: '/home/u' };
  assert.equal(expandPath('{TOOLBELT}/tools/slack', opts), '/tb/tools/slack');
  assert.equal(expandPath('~/.cache/x', opts), '/home/u/.cache/x');
  assert.equal(expandPath('~', opts), '/home/u');
  assert.equal(expandPath('/abs/path', opts), '/abs/path');
});

test('applySeverity downgrades fail to warn only when declared', () => {
  assert.equal(applySeverity({ status: 'fail' }, { severity: 'warn' }).status, 'warn');
  assert.equal(applySeverity({ status: 'fail' }, {}).status, 'fail');
  assert.equal(applySeverity({ status: 'pass' }, { severity: 'warn' }).status, 'pass');
});

test('rollup picks the worst status; all-skip rolls up to skip', () => {
  assert.equal(rollup([{ status: 'pass' }, { status: 'warn' }]), 'warn');
  assert.equal(rollup([{ status: 'pass' }, { status: 'fail' }]), 'fail');
  assert.equal(rollup([{ status: 'skip' }, { status: 'skip' }]), 'skip');
  assert.equal(rollup([{ status: 'pass' }]), 'pass');
});

test('files.env_set: env var wins, then key_file, mirroring how a tool resolves its key', async () => {
  const impl = registry['files.env_set'].impl.darwin;
  const ctx = { expand: (p) => p };
  const NAME = 'TOOLBELT_TEST_KEY_THAT_IS_UNSET';
  delete process.env[NAME];

  // no env, no key_file → fail (old behavior preserved)
  assert.equal((await impl(ctx, { name: NAME })).status, 'fail');

  // env var set → pass, regardless of key_file
  process.env[NAME] = 'x';
  assert.equal((await impl(ctx, { name: NAME, key_file: '/nope' })).status, 'pass');
  delete process.env[NAME];

  // env unset + key_file present at mode 600 → pass
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-env-'));
  const key = path.join(dir, 'user.key');
  writeFileSync(key, 'fake-key-material');
  chmodSync(key, 0o600);
  assert.equal((await impl(ctx, { name: NAME, key_file: key })).status, 'pass');

  // loose perms → fail, never green on a file the tool would reject
  chmodSync(key, 0o644);
  assert.equal((await impl(ctx, { name: NAME, key_file: key })).status, 'fail');

  // key_file declared but absent → fail
  assert.equal((await impl(ctx, { name: NAME, key_file: path.join(dir, 'absent.key') })).status, 'fail');

  // Exported-but-empty is absence, not presence — no tool can authenticate with "".
  for (const blank of ['', '   ', '\n']) {
    process.env[NAME] = blank;
    const r = await impl(ctx, { name: NAME });
    assert.equal(r.status, 'fail', `blank env value ${JSON.stringify(blank)} must not pass`);
    assert.match(r.detail, /set but empty/);
  }
  delete process.env[NAME];

  // Same for a key file that was touched but never filled.
  const blankKey = path.join(dir, 'blank.key');
  writeFileSync(blankKey, '\n  \n');
  chmodSync(blankKey, 0o600);
  const blankRes = await impl(ctx, { name: NAME, key_file: blankKey });
  assert.equal(blankRes.status, 'fail');
  assert.match(blankRes.detail, /empty/);
});

test('auth.live_token: a bad provider or missing scope fails loudly, never greens', async () => {
  const impl = registry['auth.live_token'].impl.darwin;
  const ctx = { expand: (p) => p };

  const unknown = await impl(ctx, { provider: 'nope' });
  assert.equal(unknown.status, 'fail');
  assert.match(unknown.detail, /unknown provider/);

  const noScope = await impl(ctx, { provider: 'azure' });
  assert.equal(noScope.status, 'fail');
  assert.match(noScope.detail, /requires a "scope"/);
});

test('auth.live_token: a dead grant fails even though the cached profile still reads clean', async () => {
  // The regression this check exists for: `az account show` answers from
  // ~/.azure/azureProfile.json and exits 0 with the MSAL token cache emptied, so a
  // doctor that asserts on it goes green against an Azure grant that cannot mint.
  const azureConfig = mkdtempSync(path.join(tmpdir(), 'tb-az-'));
  writeFileSync(path.join(azureConfig, 'azureProfile.json'), JSON.stringify({
    subscriptions: [{
      id: '00000000-0000-0000-0000-000000000000',
      name: 'probe', state: 'Enabled', isDefault: true,
      user: { name: 'nobody@example.com', type: 'user' },
      tenantId: '00000000-0000-0000-0000-000000000000',
      environmentName: 'AzureCloud',
    }],
  }));
  // No msal_token_cache.json written — that is exactly the dead-grant shape.
  const prior = process.env.AZURE_CONFIG_DIR;
  process.env.AZURE_CONFIG_DIR = azureConfig;
  try {
    const cached = await registry['cli.authed'].impl.darwin({ expand: (p) => p },
      { command: 'az account show --query user.name -o tsv' });
    const live = await registry['auth.live_token'].impl.darwin({ expand: (p) => p },
      { provider: 'azure', scope: 'https://management.azure.com/.default' });

    if (cached.status !== 'pass') return;  // az not installed here; nothing to regress against
    assert.equal(live.status, 'fail', 'live token must fail where the cached profile passes');
    assert.doesNotMatch(live.detail, /[A-Za-z0-9_=-]{40,}/, 'must never echo token-shaped material');
  } finally {
    if (prior === undefined) delete process.env.AZURE_CONFIG_DIR;
    else process.env.AZURE_CONFIG_DIR = prior;
  }
});

test('auth.key_accepted: skips with no credential, rejects a bogus one, never echoes it', async () => {
  const impl = registry['auth.key_accepted'].impl.darwin;
  const ctx = { expand: (p) => p };
  const NAME = 'TOOLBELT_TEST_NR_KEY';
  delete process.env[NAME];

  const bad = await impl(ctx, { provider: 'nope', env: NAME });
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /unknown provider/);

  // No credential is the neighbouring files.env_set check's business, not this one's —
  // it must not manufacture a pass or a fail from nothing.
  const none = await impl(ctx, { provider: 'newrelic', env: NAME, key_file: '/nope/absent.key' });
  assert.equal(none.status, 'skip');

  // An empty key file reads as "no credential", not as a credential worth sending.
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-key-'));
  const empty = path.join(dir, 'empty.key');
  writeFileSync(empty, '   \n');
  assert.equal((await impl(ctx, { provider: 'newrelic', env: NAME, key_file: empty })).status, 'skip');
});

test('auth.file_cache: a recorded expiry beats mtime, which only knows when a file was written', async () => {
  // The regression: a token cache rewritten seconds ago can hold an already-dead token, so
  // judging it by mtime reports green over a credential nothing can use.
  const impl = registry['auth.file_cache'].impl.darwin;
  const ctx = { expand: (p) => p };
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-cache-'));

  const write = (name, expires) => {
    const p = path.join(dir, name);
    writeFileSync(p, JSON.stringify({ expires_on: expires, secret: 'x'.repeat(64) }));
    chmodSync(p, 0o600);
    return p;
  };
  const iso = (offsetSeconds) => new Date(Date.now() + offsetSeconds * 1000).toISOString();

  const dead = await impl(ctx, { path: write('dead', iso(-3600)), expiry_field: 'expires_on' });
  assert.equal(dead.status, 'fail', 'an expired token must fail however fresh the file is');
  assert.match(dead.detail, /expired/);
  assert.doesNotMatch(dead.detail, /x{40,}/, 'must never echo token material');

  const live = await impl(ctx, { path: write('live', iso(3600)), expiry_field: 'expires_on' });
  assert.equal(live.status, 'pass');
  assert.match(live.detail, /valid/);

  // Epoch seconds and ISO must read alike — auth.py accepts both, so the doctor must too.
  const epoch = await impl(ctx, { path: write('epoch', Math.floor(Date.now() / 1000) + 3600), expiry_field: 'expires_on' });
  assert.equal(epoch.status, 'pass');

  // A spent access token that a refresh grant renews without a human is not a problem to
  // report; a check that cries wolf on the routine case gets ignored on the real one.
  const refreshable = await impl(ctx, { path: write('stale', iso(-3600)), expiry_field: 'expires_on', refreshable: true });
  assert.equal(refreshable.status, 'pass');
  assert.match(refreshable.detail, /no human/);

  // Declared-but-unreadable must say so rather than silently falling back to mtime.
  const bare = path.join(dir, 'bare');
  writeFileSync(bare, 'not json');
  chmodSync(bare, 0o600);
  const drifted = await impl(ctx, { path: bare, expiry_field: 'expires_on' });
  assert.equal(drifted.status, 'warn');
  assert.match(drifted.detail, /expiry is unknown/);
});

test('auth.file_cache: for a rotating credential the age is reported as a floor, not proof', async () => {
  // A refresh grant rewrites the file without extending the token's lifetime, so the mtime
  // can read hours younger than a token that is already dead.
  const impl = registry['auth.file_cache'].impl.darwin;
  const ctx = { expand: (p) => p };
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-rot-'));
  const p = path.join(dir, '.refresh');
  writeFileSync(p, 'opaque-refresh-token');
  chmodSync(p, 0o600);

  const r = await impl(ctx, { path: p, max_age_hours: 24, rotates: true });
  assert.equal(r.status, 'pass');
  assert.match(r.detail, /floor, not proof/);
  assert.match(r.detail, /live mint/, 'must name what would actually settle it');
});

test('mcp.stdio_read: a server that starts fine but cannot read fails, and never echoes the payload', async () => {
  // The regression this check exists for: initialize + tools/list succeed against a dead
  // credential, because starting the process does not touch the token — a server can pass
  // every handshake with a refresh token that has been expired for hours.
  const impl = registry['mcp.stdio_read'].impl.darwin;
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-mcp-'));
  writeFileSync(path.join(dir, 'fake-server.mjs'), `
    let buf = '';
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
        else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: process.env.FAKE_TOOL }] } });
        else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: process.env.FAKE_MODE === 'dead'
          ? JSON.stringify({ ok: false, error: 'interaction_required' })
          : JSON.stringify({ ok: true, count: 1, events: [{ subject: 'PRIVATESUBJECT' }] }) }] } });
      }
    });
  `);

  // The probe registry is keyed by manifest name, so the test pins one for its fake server.
  registerReadProbe('fake-mcp', { tool: 'list_calendar_events', args: () => ({ top: 1 }), proves: 'the fake chain' });
  const ctxFor = (mode, tool = 'list_calendar_events') => ({
    expand: (p) => p,
    toolDir: dir,
    manifest: {
      name: 'fake-mcp',
      entrypoints: { mcp_server: 'fake-server.mjs' },
      env: [{ name: 'FAKE_MODE', value: mode }, { name: 'FAKE_TOOL', value: tool }],
    },
  });

  const dead = await impl(ctxFor('dead'), { timeout_ms: 15_000 });
  assert.equal(dead.status, 'fail', 'a tool result of ok:false must fail even though the handshake worked');
  assert.match(dead.detail, /interaction_required/);

  const ok = await impl(ctxFor('ok'), { timeout_ms: 15_000 });
  assert.equal(ok.status, 'pass');
  assert.doesNotMatch(ok.detail, /PRIVATESUBJECT/, 'a calendar read is PII — only the verdict may be reported');

  // A renamed tool is drift to report, not a call to attempt blind.
  const drift = await impl(ctxFor('ok', 'renamed_tool'), { timeout_ms: 15_000 });
  assert.equal(drift.status, 'fail');
  assert.match(drift.detail, /drifted/);

  // A tool with no pinned probe must skip rather than invent a call to make.
  const unpinned = await impl({ ...ctxFor('ok'), manifest: { ...ctxFor('ok').manifest, name: 'not-a-probed-tool' } }, {});
  assert.equal(unpinned.status, 'skip');
});

// ---------------------------------------------------------------------------
// mcp.http_reachable
//
// Stub `fetch` rather than reach the network: a unit test that depends on being
// on-tunnel is a coin flip, and this check's whole subject is what happens when
// you are off it. Only `status` and `text()` are consumed by the check.
// ---------------------------------------------------------------------------

/**
 * The shared network-path hint, asserted verbatim: mcp.http_reachable and the data-plane probe
 * must say the same thing. Wording drift between the two is the bug this constant catches.
 */
const NET_HINT = NETWORK_PATH_HINT;

/** What Azure Cognitive Services actually returns when the source IP is off-allowlist. */
const ALLOWLIST_403 = JSON.stringify({
  error: { code: 'Forbidden', message: 'Access denied due to Virtual Network/Firewall rules.' },
});

/** What a bare 403 from the same endpoint looks like: a missing RBAC role. */
const RBAC_403 = JSON.stringify({
  error: { code: 'PermissionDenied', message: 'Principal does not have access to API/Operation.' },
});

const AZURE_URL = 'https://example-resource.openai.azure.com/';
const REACHABLE_SUFFIX = ' (auth happens in-session — reachable)';

async function httpReachable({ status, body = '' }, params = {}) {
  const impl = registry['mcp.http_reachable'].impl.darwin;
  const prior = globalThis.fetch;
  globalThis.fetch = async () => ({ status, text: async () => body });
  try {
    return await impl({ expand: (p) => p }, { url: AZURE_URL, ...params });
  } finally {
    globalThis.fetch = prior;
  }
}

test('mcp.http_reachable: Azure\'s IP-allowlist 403 fails and hands over the network-path hint', async () => {
  // The false green this branch exists for: a 403 that reads as "auth happens in-session —
  // reachable" reports the endpoint up while every real call is being rejected at the front
  // door for an off-allowlist source IP.
  const r = await httpReachable({ status: 403, body: ALLOWLIST_403 });
  assert.equal(r.status, 'fail');
  assert.ok(r.detail.includes(NET_HINT), 'the detail must carry the shared hint wording verbatim');
  assert.ok(r.detail.startsWith(`${AZURE_URL} answered HTTP 403 — off-allowlist source IP.`));
  assert.ok(!r.detail.includes(REACHABLE_SUFFIX), 'must not also claim reachable');

  // The match is case-folded, so casing changes on Azure's side cannot silently un-detect it.
  const shouty = await httpReachable({ status: 403, body: 'ACCESS DENIED DUE TO VIRTUAL NETWORK/FIREWALL RULES.' });
  assert.equal(shouty.status, 'fail');
  assert.ok(shouty.detail.includes(NET_HINT));
});

test('mcp.http_reachable: a 403 without the whole signature stays reachable', async () => {
  // The regression guard for every non-Azure manifest on this check, whose fix text promises
  // that any HTTP answer — 403 included — counts as up. A bare 403 is also the shape of a
  // genuine missing role, and routing that user to reconnect a VPN is worse than saying nothing.
  const expected = `${AZURE_URL} answered HTTP 403${REACHABLE_SUFFIX}`;
  for (const body of [RBAC_403, '', '<html><body>Forbidden</body></html>']) {
    const r = await httpReachable({ status: 403, body });
    assert.equal(r.status, 'pass', `403 with body ${JSON.stringify(body.slice(0, 24))} must stay pass`);
    assert.equal(r.detail, expected);
  }

  // Conjunction, not disjunction: either phrase alone is ordinary 403 prose. "firewall" on
  // its own turns up in proxy blocks; "virtual network" on its own in unrelated Azure errors.
  for (const half of [
    'Access denied due to Virtual Network rules.',
    'Request blocked by firewall policy.',
  ]) {
    const r = await httpReachable({ status: 403, body: half });
    assert.equal(r.status, 'pass', `one signature phrase alone must not fail: ${half}`);
    assert.equal(r.detail, expected);
  }

  // The match window is the first 400 characters of the body. Azure leads with the message,
  // so this bounds the work done on a hostile body; a signature buried past it reads as a
  // bare 403.
  const buried = await httpReachable({ status: 403, body: 'x'.repeat(400) + ALLOWLIST_403 });
  assert.equal(buried.status, 'pass');
});

test('mcp.http_reachable: every other status reads exactly as it did before', async () => {
  for (const status of [200, 429, 500]) {
    const r = await httpReachable({ status });
    assert.equal(r.status, 'pass', `HTTP ${status} with no expect_status is still any-answer-counts`);
    assert.equal(r.detail, `${AZURE_URL} answered HTTP ${status}`);
  }

  // 401 keeps the in-session wording; only 403 gained a branch, and only on the body.
  const unauth = await httpReachable({ status: 401, body: ALLOWLIST_403 });
  assert.equal(unauth.status, 'pass');
  assert.equal(unauth.detail, `${AZURE_URL} answered HTTP 401${REACHABLE_SUFFIX}`);

  // expect_status still narrows: an answer outside the declared set is a plain fail.
  const narrow = await httpReachable({ status: 429 }, { expect_status: [200] });
  assert.equal(narrow.status, 'fail');
  assert.equal(narrow.detail, `${AZURE_URL} answered unexpected HTTP 429`);

  // And a transport failure is still a transport failure, not a network-path verdict.
  const prior = globalThis.fetch;
  globalThis.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  try {
    const dead = await registry['mcp.http_reachable'].impl.darwin({ expand: (p) => p }, { url: AZURE_URL });
    assert.equal(dead.status, 'fail');
    assert.match(dead.detail, /unreachable \(ENOTFOUND\)/);
    assert.ok(!dead.detail.includes(NET_HINT), 'DNS failure is not the allowlist story');
  } finally {
    globalThis.fetch = prior;
  }
});

test('mcp.http_reachable: the allowlist signature outranks expect_status', async () => {
  // A manifest may list 403 in expect_status. The branch sits ahead of the expect evaluation
  // deliberately: a manifest declaring 403 acceptable is saying "an unauthenticated answer
  // proves the host is up", which an allowlist rejection at the front door does not. A
  // manifest cannot opt back into the false green.
  const lenient = { expect_status: [200, 401, 403] };
  const signature = await httpReachable({ status: 403, body: ALLOWLIST_403 }, lenient);
  assert.equal(signature.status, 'fail');
  assert.ok(signature.detail.includes(NET_HINT));

  // The rest of the declared set is untouched.
  const bare = await httpReachable({ status: 403, body: RBAC_403 }, lenient);
  assert.equal(bare.status, 'pass');
  assert.equal(bare.detail, `${AZURE_URL} answered HTTP 403${REACHABLE_SUFFIX}`);
});

test('mcp.http_reachable: a warn-severity consumer downgrades the status, never the hint', async () => {
  // A tool may declare this check severity:warn, so the user sees warn rather than a red run —
  // the endpoint being off-allowlist does not mean the install is broken. The diagnosis has to
  // survive the downgrade, or the warn says nothing actionable.
  const raw = await httpReachable({ status: 403, body: ALLOWLIST_403 });
  const shown = applySeverity(raw, { severity: 'warn' });
  assert.equal(shown.status, 'warn');
  assert.ok(shown.detail.includes(NET_HINT));
});

// ---------------------------------------------------------------------------
// auth.data_plane_accepted (classifyDataPlane)
//
// The authenticated companion to the mcp.http_reachable tests above: the same
// allowlist rejection, seen from inside a real data-plane call — the only probe
// shape that sees it under every front-door behavior observed so far (an
// unauthenticated GET has answered 401 as well as the allowlist 403).
// classifyDataPlane is pure, so no fetch stub or az grant is needed — which
// matters, because the red state cannot be reproduced on demand once a zero-trust
// client has classified the hostname.
// ---------------------------------------------------------------------------

test('auth.data_plane_accepted: an IP-allowlist 403 goes red, and is told apart from an authz 403', () => {
  // The regression this check exists for: a tool reports every check PASS while every call it
  // makes returns 403 "Access denied due to Virtual Network/Firewall rules." from a resource
  // whose networkAcls.defaultAction is Deny over a short IP allowlist.
  const probe = DATA_PLANE_PROBES['azure-openai'];

  const denied = classifyDataPlane(probe, 403, ALLOWLIST_403);
  assert.equal(denied.status, 'fail', 'an allowlist 403 must be able to fail, never warn');
  assert.match(denied.detail, /credential is fine/, 'must not send the reader to re-run az login');
  assert.match(denied.fix.description, /VPN \/ zero-trust client/, 'the fix has to name the thing to reconnect');
  assert.ok(denied.fix.description.includes(NET_HINT), 'the fix must carry the shared hint wording verbatim');

  // A content-policy or role 403 is NOT a network problem, and telling a user to reconnect
  // a VPN for one sends them chasing the wrong layer.
  const authz = classifyDataPlane(probe, 403, RBAC_403);
  assert.equal(authz.status, 'fail');
  assert.doesNotMatch(authz.detail, /Virtual Network/, 'an authz 403 must not be reported as an allowlist rejection');
  assert.equal(authz.fix, undefined, 'a bare 403 must not hand over the network remedy');

  // Conjunction, not disjunction: either signature phrase alone is ordinary 403 prose.
  for (const half of [
    'Access denied due to Virtual Network rules.',
    'Request blocked by firewall policy.',
  ]) {
    const one = classifyDataPlane(probe, 403, half);
    assert.equal(one.fix, undefined, `one signature phrase alone must not read as the allowlist: ${half}`);
  }

  assert.equal(classifyDataPlane(probe, 200).status, 'pass');
  assert.equal(classifyDataPlane(probe, 401, '').status, 'fail');
});

test('auth.data_plane_accepted: a 429 passes, because the rate limiter is past the ACL', () => {
  // Several tools may declare this probe against one shared deployment, and `doctor`
  // with no tool argument runs them concurrently against its RPM limit — so treating
  // 429 as a failure makes the doctor go red on its own load. It is also simply wrong:
  // reaching the rate limiter proves the call cleared both the IP allowlist and auth,
  // which is the entire claim this check makes.
  const probe = DATA_PLANE_PROBES['azure-openai'];
  const limited = classifyDataPlane(probe, 429, '{"error":{"code":"429","message":"RateLimitReached"}}');
  assert.equal(limited.status, 'pass');
  assert.match(limited.detail, /cleared the IP allowlist/, 'must say why a 429 is still a pass');
});

test('auth.data_plane_accepted: pins its own path so a manifest cannot re-blind it', () => {
  // A manifest that could choose the URL could choose the endpoint root again, which is
  // exactly the blind spot this check was added to close.
  const probe = DATA_PLANE_PROBES['azure-openai'];
  assert.match(probe.path, /^openai\//, 'path must be on the data plane, not the root');
  assert.match(probe.path, /api-version=/, 'AOAI data-plane calls require an api-version');
  assert.ok(!probe.path.startsWith('/'), 'path is joined to a host, so it must not be absolute');
});

test('registry: every check declares darwin impl or explicit null, and a category', () => {
  for (const [id, def] of Object.entries(registry)) {
    assert.ok(def.title, `${id} missing title`);
    assert.ok(def.category, `${id} missing category`);
    assert.ok('darwin' in def.impl, `${id} missing darwin key`);
    assert.ok('win32' in def.impl, `${id} missing win32 key (use null for not-yet-implemented)`);
  }
});

// --- auth.artifactory: the three states a teammate actually hits, without a network ---

const HOST = 'registry.example.com';

test('registry: connect failure is network, not credentials', () => {
  const r = classifyArtifactory({ status: null, error: 'ENOTFOUND' }, { token: 'x', source: '$ARTIFACTORY_TOKEN' }, HOST);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /registry\.example\.com unreachable/);
  assert.match(r.fix.description, /VPN \/ zero-trust client/);
});

test('registry: no token configured names every store; a 401 makes it a fail', () => {
  const r = classifyArtifactory({ status: 401 }, { token: null, source: null }, HOST);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /no identity token/);
  assert.match(r.detail, /~\/.npmrc/);
  assert.equal(classifyArtifactory({ status: 200 }, { token: null, source: null }, HOST).status, 'warn');
});

test('registry: 401 with a token is expired/revoked and says where the token came from', () => {
  const r = classifyArtifactory({ status: 401 }, { token: 'x', source: '~/.npmrc' }, HOST);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /rejected the token from ~\/.npmrc/);
  assert.doesNotMatch(JSON.stringify(r), /"x"/);
});

test('registry: 200 is a pass; a loose ~/.npmrc mode downgrades it to warn with the chmod', () => {
  assert.equal(classifyArtifactory({ status: 200 }, { token: 'x', source: '$ARTIFACTORY_TOKEN' }, HOST).status, 'pass');
  const r = classifyArtifactory({ status: 200 }, { token: 'x', source: '~/.npmrc', loose: '644' }, HOST);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /chmod 600 ~\/.npmrc/);
});

test('registry: credential resolution order is env, poetry env, then ~/.npmrc for the declared host; placeholders do not count', () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-art-'));
  assert.equal(artifactoryCredential(home, {}, HOST).token, null);
  assert.equal(artifactoryCredential(home, { ARTIFACTORY_TOKEN: 'a', POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD: 'b' }, HOST).source, '$ARTIFACTORY_TOKEN');
  assert.equal(artifactoryCredential(home, { POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD: 'b' }, HOST).source, '$POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD');
  writeFileSync(join(home, '.npmrc'), `registry=https://${HOST}/artifactory/api/npm/npm/\n//${HOST}/artifactory/api/npm/npm/:_authToken=\${NPM_TOKEN}\n`);
  assert.equal(artifactoryCredential(home, {}, HOST).token, null, 'a ${VAR} placeholder is not a token');
  // Assembled at runtime so the repo's own credential-literal check never sees a token-shaped value in a tracked file.
  const fake = ['fixture', 'not', 'a', 'token'].join('-');
  writeFileSync(join(home, '.npmrc'), `//${HOST}/artifactory/api/npm/npm/:_authToken=${fake}\n`, { mode: 0o644 });
  const c = artifactoryCredential(home, {}, HOST);
  assert.equal(c.source, '~/.npmrc');
  assert.equal(c.loose, '644');
  // Another host's token is not this registry's token.
  assert.equal(artifactoryCredential(home, {}, 'other.example.org').token, null);
  // And with no host at all, ~/.npmrc is never consulted.
  assert.equal(artifactoryCredential(home, {}).token, null);
  rmSync(home, { recursive: true, force: true });
});

test('registry: the check skips, clearly, when the manifest declares no host', async () => {
  const impl = registry['auth.artifactory'].impl.darwin;
  const ctx = { expand: (p) => p, home: tmpdir() };
  for (const params of [undefined, {}, { host: '' }, { host: '   ' }]) {
    const r = await impl(ctx, params);
    assert.equal(r.status, 'skip');
    assert.match(r.detail, /needs a "host"/);
  }
  assert.ok(REGISTRY_DEFAULT_PATH.startsWith('/'), 'the default path joins onto https://<host>');
});
