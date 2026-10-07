#!/usr/bin/env node
/**
 * Test suite for slack-cli.
 *
 *   node test.js          unit + fixture tests: no auth, no network, no
 *                         configured workspace needed. Exit 0/1 by pass/fail.
 *   node test.js --live   also runs the integration tests against your
 *                         workspace. Needs SLACK_WORKSPACE_URL (or the config
 *                         file), SLACK_TEST_CHANNEL (a public channel name or
 *                         C… id you are a member of), and optionally
 *                         SLACK_TEST_QUERY (a keyword that appears in that
 *                         channel; default "the"). Uses a throwaway Chrome
 *                         profile; reuses a cached session under 36 hours old.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, existsSync, statSync } from 'fs';

const LIVE = process.argv.includes('--live');

// Unit fixtures need a workspace host to assert permalink shapes against. The
// operator's real setting (if any) is honored; otherwise a placeholder is used
// so the offline run never depends on configuration.
const FIXTURE_WORKSPACE = 'https://example.slack.com/';
const HAD_WORKSPACE_ENV = process.env.SLACK_WORKSPACE_URL !== undefined && process.env.SLACK_WORKSPACE_URL.trim() !== '';
if (!LIVE && !HAD_WORKSPACE_ENV) process.env.SLACK_WORKSPACE_URL = FIXTURE_WORKSPACE;

// A throwaway profile so live runs never touch the operator's SSO session.
const TEMP_PROFILE = join(tmpdir(), `slack-cli-test-${Date.now()}`);
process.env.SLACK_CLI_PROFILE = TEMP_PROFILE;

// Import after the env is arranged.
const config = await import('./lib/config.js');
const { AUTH_FILE, CONFIG_FILE } = config;
const { getAuthCookies, callSlackApi, callEdgeApi, resolveUsername, lookupUser, getCurrentUser, deleteAuthFile } = await import('./auth.js');
const { getThreadReplies, buildPermalink } = await import('./lib/queries.js');
const { mapMessageToExport, exportThreadToJSON } = await import('./lib/export.js');
const { parsePermalink } = await import('./lib/files.js');
const { computeNewText, renderDiff, lossyReasons } = await import('./lib/edit.js');
const { validateInviteTarget, slackErrorCode, describeChannel } = await import('./lib/invite.js');
const { isSinglePageRead, channelReadExemption, SINGLE_PAGE_SIZE, checkBusinessHours } = await import('./lib/safeguards.js');
const { validateChannelName } = await import('./lib/create-channel.js');

const PERMALINK_BASE = config.getPermalinkBase();

// Auth TTL for live runs: 36 hours
const AUTH_TTL_MS = 36 * 60 * 60 * 1000;
function isAuthFresh() {
  if (!existsSync(AUTH_FILE)) return false;
  try {
    return Date.now() - statSync(AUTH_FILE).mtimeMs < AUTH_TTL_MS;
  } catch {
    return false;
  }
}

// Placeholder ids for fixtures. They are shaped like Slack ids so the same
// regexes the CLI applies accept them; they belong to no real workspace.
const TEST_CHANNEL_ID = 'CTESTCHAN01';
const TEST_CHANNEL_NAME = 'example-channel';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    const result = await fn();
    console.log(`PASSED${result ? ` (${result})` : ''}`);
    passed++;
    return true;
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
    failed++;
    return false;
  }
}

console.log('='.repeat(60));
console.log('slack-cli - Test Suite');
console.log('='.repeat(60));
console.log(LIVE
  ? `Mode: live (temp profile ${TEMP_PROFILE}; cached auth ${isAuthFresh() ? 'fresh, reusing' : 'expired or missing'})`
  : 'Mode: offline (unit + fixture tests only; no auth, no network)');
console.log('');

async function unitTests() {
  console.log('[0] Unit — configuration (no network)');

  await test('normalizeWorkspaceUrl accepts host forms and pins https + trailing slash', async () => {
    const n = config.normalizeWorkspaceUrl;
    if (n('yourco.slack.com') !== 'https://yourco.slack.com/') throw new Error('bare host not normalized');
    if (n('https://grid-yourco.enterprise.slack.com') !== 'https://grid-yourco.enterprise.slack.com/') throw new Error('grid host mangled');
    if (n('https://YourCo.slack.com/some/path') !== 'https://yourco.slack.com/') throw new Error('path/case not stripped');
    for (const bad of ['http://yourco.slack.com', 'https://evil.example.com', 'https://slack.com.evil.example/']) {
      let threw = null;
      try { n(bad); } catch (e) { threw = e; }
      if (!threw?.isConfigError) throw new Error(`${bad} accepted`);
    }
    return 'https + .slack.com enforced';
  });

  await test('getWorkspaceUrl stops-and-tells when nothing is configured', async () => {
    if (existsSync(CONFIG_FILE)) return `skipped: ${CONFIG_FILE} exists on this machine`;
    const saved = process.env.SLACK_WORKSPACE_URL;
    delete process.env.SLACK_WORKSPACE_URL;
    try {
      let threw = null;
      try { config.getWorkspaceUrl(); } catch (e) { threw = e; }
      if (!threw?.isConfigError) throw new Error('did not throw a ConfigError');
      if (!threw.message.includes('SLACK_WORKSPACE_URL') || !threw.message.includes(CONFIG_FILE)) {
        throw new Error(`message names neither the env var nor the file: ${threw.message}`);
      }
      return 'names the env var and the config file';
    } finally {
      if (saved !== undefined) process.env.SLACK_WORKSPACE_URL = saved;
    }
  });

  await test('getBusinessHours parses HH-HH and rejects nonsense', async () => {
    const saved = { h: process.env.SLACK_BUSINESS_HOURS, tz: process.env.SLACK_BUSINESS_TZ };
    try {
      delete process.env.SLACK_BUSINESS_HOURS;
      delete process.env.SLACK_BUSINESS_TZ;
      const d = config.getBusinessHours();
      if (d.startHour !== 6 || d.endHour !== 18) throw new Error(`default window is ${d.startHour}-${d.endHour}`);
      if (!d.timeZone) throw new Error('no default time zone');

      process.env.SLACK_BUSINESS_HOURS = '09-17';
      process.env.SLACK_BUSINESS_TZ = 'Europe/London';
      const w = config.getBusinessHours();
      if (w.startHour !== 9 || w.endHour !== 17 || w.timeZone !== 'Europe/London') throw new Error(`custom window wrong: ${JSON.stringify(w)}`);

      for (const bad of ['9-5pm', '18-06', '00-25']) {
        process.env.SLACK_BUSINESS_HOURS = bad;
        let threw = null;
        try { config.getBusinessHours(); } catch (e) { threw = e; }
        if (!threw?.isConfigError) throw new Error(`"${bad}" accepted`);
      }
      process.env.SLACK_BUSINESS_HOURS = '06-18';
      process.env.SLACK_BUSINESS_TZ = 'Not/AZone';
      let tzThrew = null;
      try { config.getBusinessHours(); } catch (e) { tzThrew = e; }
      if (!tzThrew?.isConfigError) throw new Error('bad time zone accepted');
      return 'default 06-18 local; custom honored; bad input refused';
    } finally {
      if (saved.h === undefined) delete process.env.SLACK_BUSINESS_HOURS; else process.env.SLACK_BUSINESS_HOURS = saved.h;
      if (saved.tz === undefined) delete process.env.SLACK_BUSINESS_TZ; else process.env.SLACK_BUSINESS_TZ = saved.tz;
    }
  });

  await test('checkBusinessHours decides by the configured zone, not the host clock', async () => {
    const window = { startHour: 6, endHour: 18, timeZone: 'America/Los_Angeles' };
    // 2026-03-04 is a Wednesday. 17:30 UTC = 09:30 PST (in hours); 03:00 UTC = 19:00 PST the day before (outside).
    const inside = checkBusinessHours(new Date('2026-03-04T17:30:00Z'), window);
    if (!inside.isBusinessHours) throw new Error(`Wed 09:30 PST reported off-hours: ${inside.currentTime}`);
    const evening = checkBusinessHours(new Date('2026-03-04T03:00:00Z'), window);
    if (evening.isBusinessHours) throw new Error(`Tue 19:00 PST reported business hours: ${evening.currentTime}`);
    // Saturday noon PST (2026-03-07T20:00Z) is a weekend.
    const weekend = checkBusinessHours(new Date('2026-03-07T20:00:00Z'), window);
    if (weekend.isBusinessHours) throw new Error('Saturday reported business hours');
    // A different zone flips the same instant: 17:30 UTC is 18:30 in Berlin (outside a 06-18 window).
    const berlin = checkBusinessHours(new Date('2026-03-04T17:30:00Z'), { ...window, timeZone: 'Europe/Berlin' });
    if (berlin.isBusinessHours) throw new Error('Berlin 18:30 reported business hours');
    return 'weekday/hour/zone all honored';
  });

  console.log('');
  console.log('[1] Unit — permalinks, export normalization, edit-mode math (no network)');

  await test('parsePermalink handles a reply permalink with ?thread_ts', async () => {
    const url = `${PERMALINK_BASE}archives/${TEST_CHANNEL_ID}/p1786141626136899?thread_ts=1786113519.937029&cid=${TEST_CHANNEL_ID}`;
    const parsed = parsePermalink(url);
    if (!parsed || parsed.channel !== TEST_CHANNEL_ID) {
      throw new Error(`channel not parsed: ${JSON.stringify(parsed)}`);
    }
    if (parsed.ts !== '1786141626.136899') {
      throw new Error(`ts dot not reinserted: ${parsed.ts}`);
    }
    return `${parsed.channel} / ${parsed.ts}`;
  });

  await test('buildPermalink uses the configured host and adds ?thread_ts only for replies', async () => {
    const parentTs = '1786113519.937029';
    const replyTs = '1786141626.136899';
    const parentLink = buildPermalink(TEST_CHANNEL_ID, parentTs, parentTs);
    const replyLink = buildPermalink(TEST_CHANNEL_ID, replyTs, parentTs);
    if (parentLink !== `${PERMALINK_BASE}archives/${TEST_CHANNEL_ID}/p1786113519937029`) {
      throw new Error(`parent link wrong: ${parentLink}`);
    }
    const expected = `${PERMALINK_BASE}archives/${TEST_CHANNEL_ID}/p1786141626136899`
      + `?thread_ts=${parentTs}&cid=${TEST_CHANNEL_ID}`;
    if (replyLink !== expected) {
      throw new Error(`reply link wrong: ${replyLink}`);
    }
    return 'parent bare, reply carries thread_ts + cid';
  });

  await test('mapMessageToExport normalizes a raw reply (fixture)', async () => {
    // Shape of a raw conversations.replies reply: no channel, no permalink.
    const rawReply = {
      ts: '1786141626.136899',
      thread_ts: '1786113519.937029',
      user: 'U0TESTUSER',
      text: 'a reply',
      type: 'message',
      subtype: 'thread_broadcast',
      reactions: [{ name: 'eyes', count: 2, users: ['U0TESTUSER'] }],
    };
    const mapped = mapMessageToExport(rawReply, { channelId: TEST_CHANNEL_ID, channelName: TEST_CHANNEL_NAME });
    if (mapped.channelId !== TEST_CHANNEL_ID || mapped.channel !== TEST_CHANNEL_NAME) {
      throw new Error('channel context not synthesized');
    }
    const linkRe = new RegExp(`/archives/${TEST_CHANNEL_ID}/p\\d+\\?thread_ts=\\d+\\.\\d+&cid=${TEST_CHANNEL_ID}$`);
    if (!linkRe.test(mapped.permalink)) {
      throw new Error(`permalink not synthesized as a reply link: ${mapped.permalink}`);
    }
    if (mapped.threadTs !== rawReply.thread_ts) throw new Error('threadTs not mapped');
    if (mapped.subtype !== 'thread_broadcast') throw new Error('subtype not mapped');
    if (mapped.reactions?.[0]?.name !== 'eyes' || mapped.reactions?.[0]?.count !== 2) {
      throw new Error('reactions not passed through');
    }
    return 'channel/permalink synthesized, subtype + reactions mapped';
  });

  await test('exportThreadToJSON envelope (fixture) — metadata keys + undefined dropped', async () => {
    const parent = { ts: '1786113519.937029', thread_ts: '1786113519.937029', user: 'U0TESTUSER', text: 'parent', reply_count: 1 };
    const reply = { ts: '1786141626.136899', thread_ts: '1786113519.937029', user: 'U0TESTUSER', text: 'reply' };
    const json = JSON.parse(exportThreadToJSON([parent, reply], {
      channelId: TEST_CHANNEL_ID,
      channelName: TEST_CHANNEL_NAME,
      threadTs: parent.ts,
      total: 2,
    }));
    const keys = Object.keys(json.metadata);
    const expected = ['channel', 'channelId', 'thread_ts', 'total', 'count', 'fetchedAt'];
    if (keys.length !== expected.length || !expected.every(k => keys.includes(k))) {
      throw new Error(`metadata keys are ${keys.join(',')}`);
    }
    if (json.metadata.total !== 2 || json.metadata.count !== 2) {
      throw new Error(`total/count wrong: ${json.metadata.total}/${json.metadata.count}`);
    }
    if (json.messages[0].ts !== parent.ts) throw new Error('parent not first');
    // No subtype on either fixture message → the key must be absent, not null.
    if ('subtype' in json.messages[0] || 'subtype' in json.messages[1]) {
      throw new Error('undefined subtype was serialized');
    }
    return 'metadata exact, subtype additive-only';
  });

  await test('computeNewText: append keeps the original and adds a line', async () => {
    const current = '*heading*\nbody line\n*Ask:* do the thing';
    const { text, mode } = computeNewText(current, { append: '_Basis: read the page._' });
    if (mode !== 'append') throw new Error(`mode is ${mode}`);
    if (!text.startsWith(current)) throw new Error('original text not preserved verbatim');
    if (text !== `${current}\n_Basis: read the page._`) throw new Error(`joined wrong: ${JSON.stringify(text)}`);
    return 'original preserved, single newline join';
  });

  await test('computeNewText: --sub demands a unique match unless --all', async () => {
    const current = 'line one\nline two\nline three';
    const unique = computeNewText(current, { sub: 'two', with: '2' });
    if (unique.text !== 'line one\nline 2\nline three') throw new Error(`substituted wrong: ${unique.text}`);

    let threw = null;
    try { computeNewText(current, { sub: 'line', with: 'L' }); } catch (e) { threw = e.message; }
    if (!threw || !threw.includes('appears 3 times')) throw new Error(`ambiguous match not refused: ${threw}`);

    const all = computeNewText(current, { sub: 'line', with: 'L', all: true });
    if (all.text !== 'L one\nL two\nL three') throw new Error(`--all substituted wrong: ${all.text}`);
    return 'unique enforced, --all opts out';
  });

  await test('computeNewText: a missing --sub target fails instead of no-oping', async () => {
    let threw = null;
    try { computeNewText('some text', { sub: 'not present', with: 'x' }); } catch (e) { threw = e.message; }
    if (!threw || !threw.includes('not found')) throw new Error(`silent no-op: ${threw}`);

    // --with is required, because "" (delete the match) must be explicit.
    let noWith = null;
    try { computeNewText('some text', { sub: 'some' }); } catch (e) { noWith = e.message; }
    if (!noWith || !noWith.includes('--with')) throw new Error(`--sub without --with allowed: ${noWith}`);
    return 'miss and missing --with both refused';
  });

  await test('renderDiff collapses untouched runs and marks the delta', async () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
    const diff = renderDiff(before, `${before}\nNEW`);
    if (!diff.includes('+ NEW')) throw new Error('added line not marked');
    if (!diff.includes('unchanged lines')) throw new Error(`long run not collapsed:\n${diff}`);
    if (diff.split('\n').some((l) => l.startsWith('- '))) throw new Error('append reported a removal');

    const sub = renderDiff('a\nb\nc', 'a\nB\nc');
    if (!sub.includes('- b') || !sub.includes('+ B')) throw new Error(`substitution not shown:\n${sub}`);
    return 'collapse + append/substitute both read right';
  });

  await test('backupMessage chains revisions instead of overwriting', async () => {
    const { backupMessage } = await import('./lib/edit.js');
    const { mkdtempSync, readFileSync: read, statSync: stat, writeFileSync: write } = await import('fs');
    const dir = mkdtempSync(join(tmpdir(), 'slack-edit-backup-'));

    const path = backupMessage(dir, 'C1', { ts: '1.1', user: 'U1', text: 'v1' }, 'v2');
    if (!path) throw new Error('first backup returned null');
    backupMessage(dir, 'C1', { ts: '1.1', user: 'U1', text: 'v2' }, 'v3');
    const chained = JSON.parse(read(path, 'utf8'));
    if (chained.revisions?.length !== 2) throw new Error(`revisions not chained: ${JSON.stringify(chained.revisions)}`);
    if (chained.revisions[0].textBefore !== 'v1') throw new Error('the earliest text was overwritten');
    if (process.platform !== 'win32' && (stat(path).mode & 0o777) !== 0o600) throw new Error('backup is not mode 600');

    // A corrupt existing file must be preserved, not silently dropped.
    const otherPath = join(dir, 'C1-9.9.json');
    write(otherPath, 'not json{');
    backupMessage(dir, 'C1', { ts: '9.9', user: 'U1', text: 'x' }, 'y');
    const salvaged = JSON.parse(read(otherPath, 'utf8'));
    if (salvaged.priorFileUnparsed !== 'not json{') throw new Error('unparsable prior file was discarded');
    rmSync(dir, { recursive: true, force: true });
    return 'append-only chain, mode 600, corrupt prior file salvaged';
  });

  await test('lossyReasons flags files/attachments/custom blocks, passes plain text', async () => {
    const clean = lossyReasons({ text: 'hi', blocks: [{ type: 'rich_text' }] });
    if (clean.length !== 0) throw new Error(`plain message flagged: ${clean.join('; ')}`);

    const risky = lossyReasons({
      files: [{ id: 'F1' }],
      attachments: [{}, {}],
      blocks: [{ type: 'rich_text' }, { type: 'section' }],
    });
    if (risky.length !== 3) throw new Error(`expected 3 reasons, got ${risky.length}: ${risky.join('; ')}`);
    return `${risky.length} hazards named, rich_text round-trips`;
  });

  await test('validateChannelName normalizes case, rejects everything else', async () => {
    const ok = validateChannelName('  Team-Alpha_2 ');
    if (ok.name !== 'team-alpha_2' || !ok.normalized) throw new Error(`case not normalized: ${JSON.stringify(ok)}`);
    for (const bad of ['', '#general', 'has space', 'dot.name', '-leading', 'x'.repeat(81)]) {
      let threw = null;
      try { validateChannelName(bad); } catch (e) { threw = e.message; }
      if (!threw) throw new Error(`"${bad}" accepted`);
    }
    return 'lowercase only; spaces, periods, #, leading hyphen, >80 chars refused';
  });

  await test('validateInviteTarget rejects a DM and a person in the channel slot', async () => {
    // A C…/#name target passes through untouched.
    if (validateInviteTarget(`  ${TEST_CHANNEL_ID} `) !== TEST_CHANNEL_ID) throw new Error('channel id not trimmed/accepted');
    if (validateInviteTarget('#some-channel') !== '#some-channel') throw new Error('#name rejected');

    // A DM roster is fixed — Slack cannot add to it at all.
    let threw = null;
    try { validateInviteTarget('DTESTDM0001'); } catch (e) { threw = e.message; }
    if (!threw || !/DM/.test(threw)) throw new Error(`DM target not rejected: ${threw}`);

    // A person in the channel position would otherwise fail as channel_not_found.
    for (const person of ['UTESTUSER01', '@jane']) {
      let e2 = null;
      try { validateInviteTarget(person); } catch (e) { e2 = e.message; }
      if (!e2 || !/person, not a channel/.test(e2)) throw new Error(`${person} not rejected: ${e2}`);
    }
    return 'C…/#name pass; D…, U…, @name refused pre-network';
  });

  await test('slackErrorCode recovers the code auth.js buries in a thrown message', async () => {
    // callSlackApi NEVER returns {ok:false} — auth.js throws `"<api> error: <code>"`.
    // Reading r.error would make already_in_channel look like a failure.
    if (slackErrorCode(new Error('Slack API error: already_in_channel')) !== 'already_in_channel') {
      throw new Error('already_in_channel not recovered');
    }
    if (slackErrorCode(new Error('conversations.invite error: cant_invite_self')) !== 'cant_invite_self') {
      throw new Error('cant_invite_self not recovered');
    }
    // A message with no code must degrade to itself, never to a bogus code.
    if (slackErrorCode(new Error('socket hang up')) !== 'socket hang up') throw new Error('non-API error mangled');
    if (slackErrorCode(undefined) !== 'unknown_error') throw new Error('missing error not defaulted');
    return 'codes recovered from throws; non-API messages preserved';
  });

  await test('describeChannel fails CLOSED — an unreadable channel is private', async () => {
    // Privacy drives the history-disclosure warning, so a read that fails must
    // never render as "public". Both failure shapes are checked: a throw (what
    // auth.js actually does) and an ok:false payload.
    const throwing = async () => { throw new Error('conversations.info error: channel_not_found'); };
    const denied = await describeChannel(TEST_CHANNEL_ID, {}, 't', throwing);
    if (denied.checked !== false) throw new Error('a failed read reported as checked');
    if (denied.isPrivate !== true) throw new Error('unreadable channel defaulted to public — silence must warn');

    const notOk = await describeChannel('C1', {}, 't', async () => ({ ok: false, error: 'x' }));
    if (notOk.isPrivate !== true || notOk.checked !== false) throw new Error('ok:false payload failed open');

    // And a successful read must report the real values, not the safe defaults.
    const real = await describeChannel('C1', {}, 't', async () => ({
      ok: true, channel: { name: 'private-example', is_private: true, num_members: 23, is_channel: true },
    }));
    if (!real.checked || real.name !== 'private-example' || real.numMembers !== 23) {
      throw new Error(`success path mangled: ${JSON.stringify(real)}`);
    }
    const pub = await describeChannel('C1', {}, 't', async () => ({ ok: true, channel: { name: 'general', is_private: false } }));
    if (pub.isPrivate !== false) throw new Error('a genuinely public channel reported private');
    return 'throw + ok:false both fail closed; success path reports truth';
  });

  await test('Off-hours exemption: single page of a private channel you are in, nothing else', async () => {
    // Shape: only a request that cannot exceed one search page qualifies.
    if (!isSinglePageRead({ maxPages: 1 })) throw new Error('--max-pages 1 not single page');
    if (!isSinglePageRead({ maxResults: SINGLE_PAGE_SIZE })) throw new Error('--max-results at page size not single page');
    if (isSinglePageRead({ maxResults: SINGLE_PAGE_SIZE + 1 })) throw new Error('over page size counted as single page');
    if (isSinglePageRead({ maxPages: 2 })) throw new Error('two pages counted as single page');
    if (isSinglePageRead({})) throw new Error('unbounded read counted as single page');
    if (isSinglePageRead({ maxResults: Infinity })) throw new Error('Infinity counted as single page');

    const priv = async () => ({ ok: true, channel: { is_private: true, is_member: true } });
    const pub = async () => ({ ok: true, channel: { is_private: false, is_member: true } });
    const notMember = async () => ({ ok: true, channel: { is_private: true } });
    const denied = async () => { throw new Error('conversations.info error: channel_not_found'); };
    const notOk = async () => ({ ok: false, error: 'missing_scope' });
    const one = { maxPages: 1 };

    if (!(await channelReadExemption(one, 'C1', {}, 't', priv)).exempt) throw new Error('private+member single page was gated');
    if ((await channelReadExemption(one, 'C1', {}, 't', pub)).exempt) throw new Error('public channel was exempted');
    if ((await channelReadExemption(one, 'C1', {}, 't', notMember)).exempt) throw new Error('missing is_member failed open');
    if ((await channelReadExemption(one, 'C1', {}, 't', denied)).exempt) throw new Error('a thrown info read failed open');
    if ((await channelReadExemption(one, 'C1', {}, 't', notOk)).exempt) throw new Error('ok:false info failed open');
    // A multi-page read never consults the API — the gate applies on shape alone.
    let called = false;
    const spy = async () => { called = true; return priv(); };
    if ((await channelReadExemption({ maxPages: 3 }, 'C1', {}, 't', spy)).exempt || called) throw new Error('multi-page read reached the API or was exempted');
    return 'one page + private + member exempt; public, non-member, unreadable, multi-page all gated';
  });

  console.log('');
}

async function liveTests() {
  const TEST_CHANNEL = process.env.SLACK_TEST_CHANNEL;
  const TEST_QUERY = process.env.SLACK_TEST_QUERY || 'the';
  if (!TEST_CHANNEL) {
    console.log('[live] SLACK_TEST_CHANNEL is not set — name a public channel (or C… id) you are a member of. Skipping live tests.');
    failed++;
    return;
  }

  // Only clear auth if expired (older than 36 hours)
  if (!isAuthFresh()) {
    deleteAuthFile();
  }

  console.log('[2] Authentication Flow');
  console.log(isAuthFresh()
    ? '    Using cached auth (less than 36 hours old)'
    : "    A browser will open. Complete your company's sign-in if prompted.");
  console.log('');

  let cookies, token;
  // Authenticated user's own identity — keeps the username/search/lookup tests
  // portable (no hardcoded colleague names).
  let selfId, selfDisplayName;
  let channelId, channelName;

  const authPassed = await test('Get auth cookies and token', async () => {
    const auth = await getAuthCookies();
    if (!auth.cookies || auth.cookies.length === 0) throw new Error('No cookies returned');
    if (!auth.token) throw new Error('No token returned');
    cookies = auth.cookies;
    token = auth.token;
    return `${auth.cookies.length} cookies, token present (${token.length} chars)`;
  });

  if (!authPassed) {
    console.log('\nAuth failed - cannot continue live tests');
    return;
  }

  console.log('');
  console.log('[3] Resolve the test channel and read history');

  await test(`Resolve ${TEST_CHANNEL}`, async () => {
    const { resolveChannel } = await import('./auth.js');
    ({ channelId, channelName } = await resolveChannel(TEST_CHANNEL, cookies, token));
    return `${channelName ? '#' + channelName : ''} ${channelId}`.trim();
  });

  let threadTs = null;
  let replyTs = null;

  await test('Fetch channel history and find a thread', async () => {
    const data = await callSlackApi('conversations.history', { channel: channelId, limit: 50 }, cookies, token);
    if (!data.messages || data.messages.length === 0) throw new Error('No messages returned');
    const threadMsg = data.messages.find(m => m.reply_count && m.reply_count > 0);
    if (threadMsg) threadTs = threadMsg.ts;
    return `${data.messages.length} messages, ${threadMsg ? `thread found (${threadMsg.reply_count} replies)` : 'no threads'}`;
  });

  await test('Fetch thread with all replies', async () => {
    if (!threadTs) throw new Error('No thread found - skipping');
    const data = await callSlackApi('conversations.replies', { channel: channelId, ts: threadTs }, cookies, token);
    if (!data.messages || data.messages.length === 0) throw new Error('No thread messages returned');
    if (data.messages.length > 1) replyTs = data.messages[1].ts;
    return `${data.messages.length} messages in thread`;
  });

  console.log('');
  console.log('[4] Thread Fetch Engine (getThreadReplies — backs CLI `thread`)');

  await test('Paginated fetch: parent first, deduped, complete', async () => {
    if (!threadTs) throw new Error('No thread found - skipping');
    // Tiny limit forces multiple cursor pages — the regression test for the
    // parent-repeats-on-every-page behavior (deduped by ts).
    const result = await getThreadReplies({ cookies, token }, { channel: channelId, threadTs, limit: 2, delay: 50 });
    if (!result.messages.length) throw new Error('No messages returned');
    if (result.messages[0].ts !== threadTs) throw new Error(`Parent not first: ${result.messages[0].ts}`);
    const tsSet = new Set(result.messages.map(m => m.ts));
    if (tsSet.size !== result.messages.length) throw new Error(`Duplicate ts in results`);
    if (result.messages.length !== result.total) throw new Error(`Fetched ${result.messages.length} but Slack reports total ${result.total}`);
    return `${result.messages.length}/${result.total} messages, no duplicates`;
  });

  await test('Raw reply normalizes into the export contract shape', async () => {
    if (!threadTs || !replyTs) throw new Error('No thread/reply found - skipping');
    const result = await getThreadReplies({ cookies, token }, { channel: channelId, threadTs, delay: 50 });
    const rawReply = result.messages.find(m => m.ts !== threadTs);
    if (!rawReply) throw new Error('Thread has no replies - skipping');
    const mapped = mapMessageToExport(rawReply, { channelId: result.channel.id, channelName: result.channel.name });
    if (mapped.channelId !== channelId) throw new Error('channelId not populated');
    if (mapped.threadTs !== threadTs) throw new Error(`threadTs is ${mapped.threadTs}`);
    if (!new RegExp(`/archives/${channelId}/p\\d+\\?thread_ts=\\d+\\.\\d+&cid=${channelId}$`).test(mapped.permalink)) {
      throw new Error(`reply permalink wrong: ${mapped.permalink}`);
    }
    return `reply ${mapped.ts} → contract shape with thread permalink`;
  });

  console.log('');
  console.log('[5] Search');

  await test(`search.messages in the test channel for "${TEST_QUERY}"`, async () => {
    const inFilter = channelName ? `in:#${channelName}` : `in:<#${channelId}>`;
    const data = await callSlackApi('search.messages', { query: `${inFilter} ${TEST_QUERY}`, count: 5, sort: 'timestamp', sort_dir: 'desc' }, cookies, token);
    const total = data.messages?.total || 0;
    if (total === 0) throw new Error(`no results for "${TEST_QUERY}" — set SLACK_TEST_QUERY to a word that appears in the channel`);
    return `${data.messages.matches.length} results (${total} total)`;
  });

  await test('search.messages relevance sort', async () => {
    const inFilter = channelName ? `in:#${channelName}` : `in:<#${channelId}>`;
    const data = await callSlackApi('search.messages', { query: `${inFilter} ${TEST_QUERY}`, count: 3, sort: 'score', sort_dir: 'desc' }, cookies, token);
    return `${data.messages?.total || 0} results (sorted by relevance)`;
  });

  console.log('');
  console.log('[6] Identity and user resolution (auth.test + Edge API)');

  await test('Resolve authenticated user identity (auth.test)', async () => {
    const me = await getCurrentUser(cookies, token);
    if (!me.userId) throw new Error('auth.test did not return a username');
    selfId = me.userId;
    const profile = await lookupUser(selfId, cookies, token);
    if (profile.user) {
      selfDisplayName = profile.user.profile?.display_name || profile.user.profile?.first_name || profile.user.name;
    }
    return `self: ${selfDisplayName || '(no display name)'} (@${selfId})${me.enterpriseId ? `, org ${me.enterpriseId}` : ''}`;
  });

  await test('Edge API user search (self display name)', async () => {
    if (!selfDisplayName) throw new Error('No self display name resolved - skipping');
    const data = await callEdgeApi('users/search', { query: selfDisplayName, count: 5 }, cookies, token);
    if (!data.results || data.results.length === 0) throw new Error('No users found');
    return `${data.results.length} results`;
  });

  await test('Resolve unique username (self)', async () => {
    if (!selfDisplayName) throw new Error('No self display name resolved - skipping');
    const result = await resolveUsername(selfDisplayName, cookies, token);
    if (result.error) throw new Error(result.error);
    return `${result.displayName} -> @${result.userId}`;
  });

  await test('Search with from:<self> resolution', async () => {
    if (!selfId) throw new Error('No self username resolved - skipping');
    const data = await callSlackApi('search.messages', { query: `from:${selfId}`, count: 3, sort: 'timestamp', sort_dir: 'desc' }, cookies, token);
    return `${data.messages?.total || 0} messages from you`;
  });

  await test('Lookup a clearly-fake name returns no match', async () => {
    const result = await lookupUser('Zzqx Notarealperson 99999', cookies, token);
    if (!result.error) throw new Error('Expected error/no match for a clearly-fake name');
    return 'correctly returned no match';
  });

  console.log('');
  console.log('[7] Channel discovery (Edge API)');

  await test('Edge API channel search', async () => {
    const data = await callEdgeApi('channels/search', { query: channelName || 'general', count: 3 }, cookies, token);
    if (!data.results || data.results.length === 0) throw new Error('No channels found');
    return `${data.results.length} channels, first: #${data.results[0].name}`;
  });

  console.log('');
  console.log('[8] Auth Caching');

  await test('Cached auth works without browser', async () => {
    const auth = await getAuthCookies();
    if (!auth.token) throw new Error('Cached auth not found');
    return 'using cached auth';
  });
}

try {
  await unitTests();
  if (LIVE) await liveTests();
} finally {
  if (LIVE) {
    console.log('');
    console.log('[Cleanup]');
    if (existsSync(TEMP_PROFILE)) {
      rmSync(TEMP_PROFILE, { recursive: true, force: true });
      console.log(`  Removed temp profile: ${TEMP_PROFILE}`);
    }
    console.log('  Auth file preserved for next run (36hr TTL)');
  }
}

console.log('');
console.log('='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
