// Unit tests for gmf. No network, no Gmail: --live is exercised only against a fake gmh script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCli, clampMin, normalizeAddress, registrableDomain, parseUnsubscribe, parseEvidence, normalizePolicy,
  loadPolicy, listMatches, buildPlan, validatePlan, renderFiltersXml, filterProperties, xmlEscape, checkOutFile,
  writePrivateFile, addLiveCounts, renderShow, queryFor, auditLine,
  MAX_FILTERS, MIN_EVIDENCE, MIN_EVIDENCE_FLOOR, PLAN_SCHEMA,
  oneClickTarget, validateApproval, doneSenders, postOneClick, UNSUB_SCHEMA, MAX_UNSUB,
  parseHeaders, decodeWords, classifyUnsubscribe, dkimAligned,
} from '../gmf.mjs';

const GMF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gmf.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'gmf-'));

let seq = 0;
const rec = (from, bucket, extra = {}) => ({ message_id: `m${++seq}`, from, bucket, ...extra });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const recordsOf = (rows) => parseEvidence(jsonl(rows)).records;
const many = (n, from, bucket, extra) => Array.from({ length: n }, () => rec(from, bucket, extra));

// ---- a minimal XML 1.0 well-formedness parser (elements, attributes, entities) ----------
function parseXml(src) {
  let i = 0;
  const decode = (s) => {
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(s)) throw new Error(`bad entity in ${JSON.stringify(s)}`);
    return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]
      ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  };
  const decl = src.match(/^<\?xml [^?]*\?>/);
  if (!decl) throw new Error('missing XML declaration');
  i = decl[0].length;
  const root = { name: '#doc', attrs: {}, children: [], text: '' };
  const stack = [root];
  while (i < src.length) {
    if (src[i] === '<') {
      if (src[i + 1] === '/') {
        const m = src.slice(i).match(/^<\/([A-Za-z_][\w:.-]*)\s*>/);
        if (!m) throw new Error(`bad close tag at ${i}`);
        const top = stack.pop();
        if (top.name !== m[1]) throw new Error(`mismatched </${m[1]}> for <${top.name}>`);
        i += m[0].length;
        continue;
      }
      const m = src.slice(i).match(/^<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:'[^'<]*'|"[^"<]*"))*)\s*(\/?)>/);
      if (!m) throw new Error(`bad open tag at ${i}: ${src.slice(i, i + 60)}`);
      const attrs = {};
      for (const a of m[2].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/g)) {
        if (a[1] in attrs) throw new Error(`duplicate attribute ${a[1]}`);
        attrs[a[1]] = decode(a[2] ?? a[3]);
      }
      const el = { name: m[1], attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(el);
      if (!m[3]) stack.push(el);
      i += m[0].length;
    } else {
      const j = src.indexOf('<', i);
      const text = src.slice(i, j === -1 ? src.length : j);
      if (text.includes('>')) throw new Error('raw > in text');
      stack[stack.length - 1].text += decode(text);
      i = j === -1 ? src.length : j;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1].name}>`);
  if (root.children.length !== 1) throw new Error('document must have exactly one root element');
  return root.children[0];
}
const entries = (feed) => feed.children.filter((c) => c.name === 'entry');
const props = (entry) => Object.fromEntries(entry.children.filter((c) => c.name === 'apps:property').map((c) => [c.attrs.name, c.attrs.value]));

// ---- argument parsing + ceilings ------------------------------------------------------

test('ceilings are the constants the contract names', () => {
  assert.equal(MAX_FILTERS, 200);
  assert.equal(MIN_EVIDENCE, 3);
  assert.equal(MIN_EVIDENCE_FLOOR, 2);
});

test('min-evidence floor: default 3, 2 allowed, below 2 refused (exit 2)', () => {
  assert.equal(clampMin(undefined), 3);
  assert.equal(clampMin('2'), 2);
  assert.throws(() => clampMin('1'), (e) => e.exitCode === 2 && /below the floor of 2/.test(e.message));
  assert.throws(() => clampMin('0'), /floor/);
  assert.throws(() => clampMin('x'), /positive integer/);
  assert.throws(() => buildPlan([], { min: 1 }), /floor/);
  assert.throws(() => parseCli(['plan', '--evidence', 'a.jsonl', '--min', '1']), /floor/);
});

test('parseCli: verbs, flags per verb, positional evidence files', () => {
  const p = parseCli(['plan', '--evidence', 'a.jsonl', 'b.jsonl', '--min', '4']);
  assert.deepEqual(p.evidence, ['a.jsonl', 'b.jsonl']);
  assert.equal(p.min, 4);
  assert.throws(() => parseCli(['apply', '--plan', 'p']), /unknown verb "apply"/);
  assert.throws(() => parseCli(['plan']), /needs --evidence/);
  assert.throws(() => parseCli(['show', '--plan', 'p', '--live']), /--live does not apply to show/);
  assert.throws(() => parseCli(['export', '--plan', 'p']), /needs --out/);
  assert.equal(parseCli(['export', '--plan', 'p', '--explain']).explain, true);
});

// ---- evidence parsing ------------------------------------------------------------------

test('evidence: _meta lines skipped, extras ignored, missing sender/id counted, missing bucket kept as unclassified', () => {
  const text = [
    JSON.stringify({ _meta: { started: 'x' } }),
    JSON.stringify({ message_id: 'a', from: 'Deals <Deals@Shop.Example.com>', bucket: 'cleanup', facts: ['ignored'], latency_ms: 3 }),
    JSON.stringify({ message_id: 'b', from: null, bucket: 'cleanup' }),
    JSON.stringify({ from: 'x@y.com', bucket: 'cleanup' }),
    JSON.stringify({ message_id: 'c', from: 'x@y.com' }),
    '{not json',
  ].join('\n');
  const { records, stats } = parseEvidence(text);
  assert.equal(stats.meta, 1);
  assert.equal(stats.no_sender, 1);
  assert.equal(stats.no_message_id, 1);
  assert.equal(stats.malformed, 1);
  assert.equal(records.length, 2);
  assert.equal(records[0].sender, 'deals@shop.example.com');
  assert.equal(records[1].bucket, 'unclassified');
  assert.ok(!('facts' in records[0]));
});

test('address, domain and unsubscribe helpers', () => {
  assert.equal(normalizeAddress('A <b@c.io>'), 'b@c.io');
  assert.equal(normalizeAddress('not an address'), null);
  assert.equal(registrableDomain('email.nytimes.com'), 'nytimes.com');
  assert.equal(registrableDomain('mail.shop.co.uk'), 'shop.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.deepEqual(parseUnsubscribe('<mailto:u@x.com?subject=unsub>, <https://x.com/u?id=1>'), { mailto: 'mailto:u@x.com?subject=unsub', https: 'https://x.com/u?id=1' });
  assert.deepEqual(parseUnsubscribe('<http://insecure.example/u>, <javascript:alert(1)>'), null);
  assert.equal(parseUnsubscribe(null), null);
});

// ---- grouping + the blocked-sender guarantee -------------------------------------------

test('grouping: one row per qualifying sender with counts, buckets, ≤3 samples, approved false', () => {
  const plan = buildPlan(recordsOf([...many(5, 'news@a-shop.com', 'cleanup'), ...many(2, 'rare@b.com', 'cleanup')]));
  assert.equal(plan.schema, PLAN_SCHEMA);
  assert.equal(plan.filters.length, 1);
  const r = plan.filters[0];
  assert.equal(r.kind, 'address');
  assert.equal(r.criteria, 'from:(news@a-shop.com)');
  assert.deepEqual(r.match, { from: 'news@a-shop.com' });
  assert.equal(r.evidence_count, 5);
  assert.deepEqual(r.buckets, { cleanup: 5 });
  assert.equal(r.sample_message_ids.length, 3);
  assert.equal(r.approved, false);
  assert.deepEqual(r.action, { addLabel: 'Promo', archive: true, markRead: false });
  assert.match(r.id, /^f-[0-9a-f]{10}$/);
  assert.deepEqual(plan.below_min.map((b) => b.sender), ['rare@b.com']);
});

test('auto_handled → Receipts, or the policy per-domain label', () => {
  const policy = normalizePolicy({ labels: { auto_handled_by_domain: { 'uber.com': 'Receipts/Uber' } } });
  const plan = buildPlan(recordsOf([...many(3, 'noreply@uber.com', 'auto_handled'), ...many(3, 'orders@shop.com', 'auto_handled')]), { policy });
  const byFrom = Object.fromEntries(plan.filters.map((r) => [r.match.from, r.action.addLabel]));
  assert.equal(byFrom['noreply@uber.com'], 'Receipts/Uber');
  assert.equal(byFrom['orders@shop.com'], 'Receipts');
});

test('blocked guarantee: ONE fyi message blocks a sender with many cleanup messages', () => {
  const plan = buildPlan(recordsOf([...many(40, 'promo@store.com', 'cleanup'), rec('promo@store.com', 'fyi')]));
  assert.equal(plan.filters.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].sender, 'promo@store.com');
  assert.equal(plan.blocked[0].blocking, 1);
  assert.deepEqual(plan.blocked[0].buckets, { cleanup: 40, fyi: 1 });
});

test('blocked guarantee holds for every non-zero-touch bucket, unknown buckets and missing buckets', () => {
  for (const b of ['fyi', 'action', 'must_respond', 'needs_review', 'something_new', undefined]) {
    const plan = buildPlan(recordsOf([...many(5, 'x@y.com', 'cleanup'), rec('x@y.com', b)]));
    assert.equal(plan.filters.length, 0, `bucket ${b} must block`);
  }
});

test('blocked guarantee survives de-duplication: a message seen as cleanup in one run and action in another blocks', () => {
  const r = [...many(4, 'x@y.com', 'cleanup')];
  const again = { ...r[0], bucket: 'action' };
  const plan = buildPlan(recordsOf([...r, again]));
  assert.equal(plan.filters.length, 0);
  assert.equal(plan.inputs.duplicate_observations, 1);
  assert.equal(plan.inputs.messages, 4);
});

test('policy protect blocks a sender outright', () => {
  const policy = normalizePolicy({ protect: ['school.org'] });
  const plan = buildPlan(recordsOf(many(10, 'news@mail.school.org', 'cleanup')), { policy });
  assert.equal(plan.filters.length, 0);
  assert.equal(plan.blocked[0].reason, 'protected by policy');
});

// ---- domain collapse --------------------------------------------------------------------

test('domain collapse: ≥2 qualifying addresses, same action, nothing blocked → one domain row over exact hosts', () => {
  const plan = buildPlan(recordsOf([...many(3, 'a@news.brand.com', 'cleanup'), ...many(4, 'b@brand.com', 'cleanup')]));
  assert.equal(plan.filters.length, 1);
  const r = plan.filters[0];
  assert.equal(r.kind, 'domain');
  assert.equal(r.match.from, '@brand.com OR @news.brand.com');
  assert.equal(r.criteria, 'from:(@brand.com OR @news.brand.com)');
  assert.equal(r.evidence_count, 7);
  assert.deepEqual(r.senders, ['a@news.brand.com', 'b@brand.com']);
});

test('domain collapse withheld when any domain message is blocked; the clean addresses stay address rows', () => {
  const plan = buildPlan(recordsOf([
    ...many(3, 'a@brand.com', 'cleanup'), ...many(3, 'b@brand.com', 'cleanup'), rec('billing@brand.com', 'action'),
  ]));
  assert.deepEqual(plan.filters.map((r) => r.kind), ['address', 'address']);
  assert.ok(plan.filters.every((r) => /no domain filter/.test(r.note)));
  assert.deepEqual(plan.blocked.map((b) => b.sender), ['billing@brand.com']);
});

test('domain collapse withheld when one address is below --min, when actions differ, when policy protects an address there', () => {
  const below = buildPlan(recordsOf([...many(3, 'a@brand.com', 'cleanup'), ...many(3, 'b@brand.com', 'cleanup'), rec('c@brand.com', 'cleanup')]));
  assert.deepEqual(below.filters.map((r) => r.kind), ['address', 'address']);
  const mixed = buildPlan(recordsOf([...many(3, 'a@brand.com', 'cleanup'), ...many(3, 'b@brand.com', 'auto_handled')]));
  assert.deepEqual(mixed.filters.map((r) => r.kind), ['address', 'address']);
  const prot = buildPlan(recordsOf([...many(3, 'a@brand.com', 'cleanup'), ...many(3, 'b@brand.com', 'cleanup')]), { policy: normalizePolicy({ protect: ['ceo@brand.com'] }) });
  assert.deepEqual(prot.filters.map((r) => r.kind), ['address', 'address']);
  assert.match(prot.filters[0].note, /protects an address/);
  const single = buildPlan(recordsOf(many(6, 'only@solo.com', 'cleanup')));
  assert.equal(single.filters[0].kind, 'address');
});

// ---- trash, unsubscribe, ceiling -------------------------------------------------------

test('trash is never proposed without a policy match, and a match still needs explicit approval', () => {
  const plain = buildPlan(recordsOf(many(5, 'x@spam.com', 'cleanup')));
  assert.ok(!('trash' in plain.filters[0].action));
  assert.ok(!('requires_explicit_approval' in plain.filters[0]));
  const policy = normalizePolicy({ trash: ['spam.com'] });
  const t = buildPlan(recordsOf(many(5, 'x@spam.com', 'cleanup')), { policy }).filters[0];
  assert.equal(t.action.trash, true);
  assert.equal(t.requires_explicit_approval, true);
  assert.equal(t.approved_trash, false);
  assert.equal(t.approved, false);
});

test('unsubscribe metadata (mailto/https) is carried per sender', () => {
  const plan = buildPlan(recordsOf(many(3, 'x@n.com', 'cleanup', { list_unsubscribe: '<mailto:u@n.com>, <https://n.com/u>' })));
  assert.deepEqual(plan.filters[0].unsubscribe, [{ sender: 'x@n.com', mailto: 'mailto:u@n.com', https: 'https://n.com/u' }]);
  assert.equal(buildPlan(recordsOf(many(3, 'y@n2.com', 'cleanup'))).filters[0].unsubscribe, undefined);
});

test('MAX_FILTERS: proposals past the ceiling are counted, not kept', () => {
  const rows = [];
  for (let i = 0; i < MAX_FILTERS + 5; i++) rows.push(...many(3, `s${i}@d${i}.com`, 'cleanup'));
  const plan = buildPlan(recordsOf(rows));
  assert.equal(plan.filters.length, MAX_FILTERS);
  assert.equal(plan.omitted_over_ceiling, 5);
  assert.throws(() => validatePlan({ ...plan, filters: [...plan.filters, ...plan.filters.slice(0, 1)] }), /ceiling/);
});

// ---- export: approved-only, trash double approval, escaping ----------------------------

const planWith = (mut) => {
  const p = buildPlan(recordsOf([...many(3, 'a@one.com', 'cleanup'), ...many(4, 'b@two.com', 'auto_handled')]), { policy: normalizePolicy({ trash: ['one.com'] }) });
  mut?.(p);
  return p;
};

test('export renders only approved rows', () => {
  const p = planWith((pl) => { pl.filters.find((r) => r.match.from === 'b@two.com').approved = true; });
  const rows = validatePlan(p);
  assert.equal(rows.length, 1);
  const feed = parseXml(renderFiltersXml(rows, { now: new Date('2026-09-23T10:00:00.123Z') }));
  assert.equal(entries(feed).length, 1);
  assert.deepEqual(props(entries(feed)[0]), { from: 'b@two.com', label: 'Receipts', shouldArchive: 'true' });
  assert.deepEqual(validatePlan(planWith()), []);
});

test('"approved" must be a JSON boolean — a string "true" is a problem, not an approval', () => {
  const p = planWith((pl) => { pl.filters[0].approved = 'true'; });
  assert.throws(() => validatePlan(p), /must be true or false/);
});

test('trash double approval: approved alone refuses; approved + approved_trash emits shouldTrash', () => {
  const p = planWith((pl) => { pl.filters.find((r) => r.match.from === 'a@one.com').approved = true; });
  assert.throws(() => validatePlan(p), /approved_trash: true/);
  const row = p.filters.find((r) => r.match.from === 'a@one.com');
  row.approved_trash = true;
  const feed = parseXml(renderFiltersXml(validatePlan(p)));
  assert.equal(props(entries(feed)[0]).shouldTrash, 'true');
  // trash switched off by the reviewer: exports the archive+label action, no shouldTrash
  row.approved_trash = false;
  row.action.trash = false;
  const feed2 = parseXml(renderFiltersXml(validatePlan(p)));
  assert.equal(props(entries(feed2)[0]).shouldTrash, undefined);
  assert.equal(props(entries(feed2)[0]).shouldArchive, 'true');
  // a hand-added trash on a row the policy never marked is refused
  const q = planWith((pl) => { const r = pl.filters.find((x) => x.match.from === 'b@two.com'); r.approved = true; r.action.trash = true; r.approved_trash = true; });
  assert.throws(() => validatePlan(q), /requires_explicit_approval/);
  assert.equal(filterProperties({ approved: true, match: { from: 'x' }, action: { trash: true }, approved_trash: true }).some(([n]) => n === 'shouldTrash'), false);
});

test('XML: exact Gmail shape, well-formed, and hostile values round-trip through escaping', () => {
  const nasty = `@x.com OR "a&b" <c> 'd'`;
  const rows = [{
    id: 'f-1', approved: true, match: { from: nasty, hasTheWord: 'unsubscribe & <b>' },
    criteria: queryFor({ from: nasty, hasTheWord: 'unsubscribe & <b>' }),
    action: { addLabel: "Promo/R&D <'x'>", archive: true, markRead: true, neverSpam: true },
  }];
  const xml = renderFiltersXml(validatePlan({ schema: PLAN_SCHEMA, filters: rows }), { now: new Date('2026-09-23T10:00:00.123Z') });
  assert.ok(xml.startsWith("<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>"));
  assert.match(xml, /<title>Mail Filters<\/title>/);
  assert.match(xml, /<updated>2026-09-23T10:00:00Z<\/updated>/);
  assert.match(xml, /<category term='filter'><\/category>/);
  assert.match(xml, /<id>tag:mail\.google\.com,2008:filter:\d+<\/id>/);
  assert.ok(!/value='[^']*[<>&"][^']*'/.test(xml.replace(/&(amp|lt|gt|quot|apos);/g, '')), 'no raw metacharacters inside attribute values');
  const feed = parseXml(xml);
  assert.equal(feed.name, 'feed');
  assert.equal(feed.attrs['xmlns:apps'], 'http://schemas.google.com/apps/2006');
  const p = props(entries(feed)[0]);
  assert.deepEqual(p, {
    from: nasty, hasTheWord: 'unsubscribe & <b>', label: "Promo/R&D <'x'>",
    shouldArchive: 'true', shouldMarkAsRead: 'true', shouldNeverSpam: 'true',
  });
  const names = entries(feed)[0].children.filter((c) => c.name === 'apps:property').map((c) => c.attrs.name);
  assert.deepEqual(names, ['from', 'hasTheWord', 'label', 'shouldArchive', 'shouldMarkAsRead', 'shouldNeverSpam']);
});

test('xmlEscape escapes all five metacharacters and refuses characters XML cannot carry', () => {
  assert.equal(xmlEscape(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
  assert.throws(() => xmlEscape('a\u0001b'), /cannot carry/);
});

test('validatePlan: wrong schema, criteria/match drift and unknown action keys are refused', () => {
  assert.throws(() => validatePlan({ schema: 'other', filters: [] }), /schema/);
  const drift = planWith((pl) => { pl.filters[0].approved = true; pl.filters[0].approved_trash = true; pl.filters[0].criteria = 'from:(someone@else.com)'; });
  assert.throws(() => validatePlan(drift), /does not equal the query/);
  const bad = planWith((pl) => { const r = pl.filters.find((x) => x.match.from === 'b@two.com'); r.approved = true; r.action.forwardTo = 'x@y.com'; });
  assert.throws(() => validatePlan(bad), /action.forwardTo is not supported/);
});

// ---- output paths + overwrite refusal --------------------------------------------------

test('checkOutFile refuses /, $HOME itself, the belt, and directories', () => {
  const home = tmp();
  const belt = path.join(home, 'Toolbelt');
  try {
    const opts = { home, roots: [belt], cwd: home };
    assert.throws(() => checkOutFile('/plan.json', opts), /refused/);
    assert.throws(() => checkOutFile('~/plan.json', opts), /home directory itself/);
    assert.throws(() => checkOutFile(home, opts), /home directory itself/);
    assert.throws(() => checkOutFile(path.join(belt, 'x', 'plan.json'), opts), /inside the Toolbelt tree/);
    assert.throws(() => checkOutFile(path.join(home), { ...opts, home: '/nonexistent-home' }), /is a directory/);
    assert.equal(checkOutFile('~/gmf/plan.json', opts), path.join(home, 'gmf', 'plan.json'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writePrivateFile writes 600 and refuses to overwrite', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'sub', 'mailFilters.xml');
    writePrivateFile(f, 'one');
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.throws(() => writePrivateFile(f, 'two'), (e) => e.exitCode === 2 && /already exists/.test(e.message));
    assert.equal(readFileSync(f, 'utf8'), 'one');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---- policy file -----------------------------------------------------------------------

test('policy: absent → defaults; loose mode refused; unknown keys and bad labels refused; example parses', () => {
  const d = tmp();
  try {
    assert.equal(loadPolicy(path.join(d, 'none.json')).source, null);
    const f = path.join(d, 'policy.json');
    writeFileSync(f, JSON.stringify({ labels: { cleanup: 'Promo' }, trash: ['x.com'] }));
    chmodSync(f, 0o644);
    assert.throws(() => loadPolicy(f), /chmod 600/);
    chmodSync(f, 0o600);
    assert.deepEqual(loadPolicy(f).policy.trash, ['x.com']);
    assert.throws(() => normalizePolicy({ trahs: [] }), /unknown key "trahs"/);
    assert.throws(() => normalizePolicy({ labels: { cleanup: '/Promo' } }), /not a label name/);
    const example = JSON.parse(readFileSync(path.join(path.dirname(GMF), 'policy.json.example'), 'utf8'));
    assert.doesNotThrow(() => normalizePolicy(example));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('listMatches: exact address, bare domain, @domain, subdomains', () => {
  assert.ok(listMatches('a@x.com', ['a@x.com']));
  assert.ok(!listMatches('b@x.com', ['a@x.com']));
  assert.ok(listMatches('b@mail.x.com', ['x.com']));
  assert.ok(listMatches('b@x.com', ['@x.com']));
  assert.ok(!listMatches('b@notx.com', ['x.com']));
});

// ---- --live via a fake gmh -------------------------------------------------------------

test('--live adds 90-day counts through gmh list and degrades on the first failure', async () => {
  const plan = buildPlan(recordsOf([...many(3, 'a@one.com', 'cleanup'), ...many(4, 'b@two.com', 'cleanup')]));
  const calls = [];
  await addLiveCounts(plan, {
    bin: '/fake/gmh.mjs',
    run: async (cmd, args) => { calls.push(args); return { stdout: JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ id: `${i}` }))) }; },
  });
  assert.equal(calls[0][0], '/fake/gmh.mjs');
  assert.deepEqual(calls[0].slice(1), ['list', '--query', `${plan.filters[0].criteria} newer_than:90d`, '--max', '500', '--json']);
  assert.ok(plan.filters.every((r) => r.live_count_90d === 7));
  const p2 = buildPlan(recordsOf([...many(3, 'a@one.com', 'cleanup'), ...many(4, 'b@two.com', 'cleanup')]));
  await addLiveCounts(p2, { bin: 'gmh', run: async () => { const e = new Error('exit 1'); e.stderr = 'gmh: re-run `gmh auth`'; throw e; } });
  assert.match(p2.live.error, /re-run `gmh auth`/);
  assert.equal(p2.live.calls, 1);
  assert.ok(p2.filters.every((r) => r.live_count_90d === undefined));
});

// ---- show + audit ----------------------------------------------------------------------

test('renderShow lists proposals and blocked senders; auditLine carries no content', () => {
  const plan = buildPlan(recordsOf([...many(3, 'a@one.com', 'cleanup'), rec('b@two.com', 'fyi')]));
  const out = renderShow(plan);
  assert.match(out, /1 proposed · 0 approved · 1 blocked/);
  assert.match(out, /from:\(a@one\.com\)/);
  assert.match(out, /b@two\.com/);
  assert.equal(auditLine({ verb: 'plan', records: 3, out: undefined }, new Date('2026-01-01T00:00:00Z')), '[gmf audit] 2026-01-01T00:00:00.000Z verb="plan" records=3');
});

// ---- end to end through the CLI (HOME redirected so the audit log lands in a temp dir) ----

test('CLI: plan → show → export, overwrite refused, exit codes', () => {
  const home = tmp();
  try {
    const ev = path.join(home, 'work', 'run.jsonl');
    execFileSync('mkdir', ['-p', path.dirname(ev)]);
    writeFileSync(ev, [JSON.stringify({ _meta: {} }), jsonl([...many(3, 'a@one.com', 'cleanup'), ...many(3, 'b@one.com', 'cleanup'), rec('c@two.com', 'must_respond')])].join('\n'));
    const env = { ...process.env, HOME: home, GMF_POLICY: path.join(home, 'none.json') };
    const run = (...args) => execFileSync(process.execPath, [GMF, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const planFile = path.join(home, 'work', 'plan.json');
    run('plan', '--evidence', ev, '--out', planFile);
    assert.equal(statSync(planFile).mode & 0o777, 0o600);
    const plan = JSON.parse(readFileSync(planFile, 'utf8'));
    assert.equal(plan.filters.length, 1);
    assert.equal(plan.filters[0].criteria, 'from:(@one.com)');
    assert.throws(() => run('plan', '--evidence', ev, '--out', planFile), (e) => e.status === 2);
    assert.match(run('show', '--plan', planFile), /1 proposed · 0 approved · 1 blocked/);
    const xml = path.join(home, 'work', 'mailFilters.xml');
    assert.throws(() => run('export', '--plan', planFile, '--out', xml), (e) => e.status === 1 && /0 rows approved/.test(e.stderr));
    assert.ok(!existsSync(xml));
    plan.filters[0].approved = true;
    writeFileSync(planFile, JSON.stringify(plan));
    run('export', '--plan', planFile, '--out', xml);
    assert.equal(statSync(xml).mode & 0o777, 0o600);
    assert.equal(entries(parseXml(readFileSync(xml, 'utf8'))).length, 1);
    assert.throws(() => run('export', '--plan', planFile, '--out', xml), (e) => e.status === 2 && /already exists/.test(e.stderr));
    assert.throws(() => run('plan', '--evidence', ev, '--min', '1'), (e) => e.status === 2);
    const log = readFileSync(path.join(home, '.local', 'share', 'toolbelt', 'gmail-filters', 'audit.log'), 'utf8');
    assert.match(log, /verb="plan"/);
    assert.match(log, /verb="export" .*exported=1/);
    assert.ok(!log.includes('a@one.com'), 'audit log never names senders');
    assert.equal(statSync(path.join(home, '.local', 'share', 'toolbelt', 'gmail-filters', 'audit.log')).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


// ---- unsubscribe (RFC 8058 one-click) — fake fetch only, never the network ----------------

const approval = (rows, extra = {}) => ({ schema: UNSUB_SCHEMA, approved_by: 'rob', words: 'unsub these', approved: rows, ...extra });

test('unsubscribe: parseCli needs --approved and keeps --yes off by default', () => {
  assert.throws(() => parseCli(['unsubscribe']), /needs --approved/);
  assert.equal(parseCli(['unsubscribe', '--approved', 'a.json']).yes, false);
  assert.equal(parseCli(['unsubscribe', '--approved', 'a.json', '--yes']).yes, true);
  assert.throws(() => parseCli(['plan', '--evidence', 'e.jsonl', '--yes']), /does not apply/);
});

test('unsubscribe: only public https targets', () => {
  assert.ok(oneClickTarget('https://manage.kmail-lists.com/u?a=1'));
  for (const bad of ['http://x.com/u', 'mailto:u@x.com', 'https://localhost/u', 'https://10.0.0.1/u', 'https://[::1]/u',
    // a URL with embedded credentials must be refused; the "credentials" are a fixture
    'https://printer.local/u', 'https://user:pw@x.com/u', 'not a url', `https://x.com/${'a'.repeat(2100)}`]) { // pragma: allowlist secret
    assert.equal(oneClickTarget(bad), null, bad);
  }
});

test('unsubscribe: the approval must be signed and in the right schema', () => {
  assert.throws(() => validateApproval({ ...approval([]), schema: 'x' }), /schema/);
  assert.throws(() => validateApproval(approval([], { words: ' ' })), /own words/);
  const { rows, skipped } = validateApproval(approval([
    { sender: 'A <a@x.com>', do: 'one_click', https: 'https://x.com/u' },
    { sender: 'a@x.com', do: 'one_click', https: 'https://x.com/u2' },
    { sender: 'b@y.com', do: 'filter_archive', https: null },
    { sender: 'c@z.com', do: 'one_click', https: 'http://z.com/u' },
  ]));
  assert.deepEqual(rows.map((r) => r.sender), ['a@x.com']);
  assert.deepEqual(skipped, { not_one_click: 1, bad_target: 1, duplicate: 1 });
  const many = Array.from({ length: MAX_UNSUB + 1 }, (_, i) => ({ sender: `s${i}@x.com`, do: 'one_click', https: `https://x.com/${i}` }));
  assert.throws(() => validateApproval(approval(many)), /ceiling/);
});

test('unsubscribe: results log — only a last ok line counts as done', () => {
  const log = [{ sender: 'a@x.com', ok: false }, { sender: 'a@x.com', ok: true }, { sender: 'b@y.com', ok: true }, { sender: 'b@y.com', ok: false }]
    .map((r) => JSON.stringify(r)).join('\n');
  assert.deepEqual([...doneSenders(log)], ['a@x.com']);
});

test('unsubscribe: postOneClick sends the RFC 8058 body, does not follow redirects, maps outcomes', async () => {
  const seen = [];
  const fake = (status) => async (url, init) => { seen.push({ url, init }); return { status }; };
  assert.deepEqual(await postOneClick('https://x.com/u', { fetchImpl: fake(200) }), { ok: true, status: 200, note: null });
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.body, 'List-Unsubscribe=One-Click');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.equal(seen[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal((await postOneClick('https://x.com/u', { fetchImpl: fake(302) })).note, 'redirect not followed');
  // followed redirects stay POSTs with the RFC 8058 body, to the resolved Location
  const hops = [];
  const chain = async (url, init) => { hops.push([url, init.method, init.body]); return hops.length < 3 ? { status: 302, headers: new Headers({ location: hops.length === 1 ? 'https://y.com/u2' : '/u3' }) } : { status: 200 }; };
  assert.deepEqual(await postOneClick('https://x.com/u', { fetchImpl: chain, follow: true }), { ok: true, status: 200, note: 'after 2 redirect(s)' });
  assert.deepEqual(hops.map((h) => h[0]), ['https://x.com/u', 'https://y.com/u2', 'https://y.com/u3']);
  assert.ok(hops.every((h) => h[1] === 'POST' && h[2] === 'List-Unsubscribe=One-Click'));
  const toLocal = async () => ({ status: 302, headers: new Headers({ location: 'https://localhost/x' }) });
  assert.equal((await postOneClick('https://x.com/u', { fetchImpl: toLocal, follow: true })).note, 'redirect to a refused target');
  const loop = async () => ({ status: 302, headers: new Headers({ location: 'https://x.com/again' }) });
  assert.match((await postOneClick('https://x.com/u', { fetchImpl: loop, follow: true })).note, /more than 5 redirects/);
  assert.equal((await postOneClick('https://x.com/u', { fetchImpl: fake(500) })).ok, false);
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await postOneClick('https://x.com/u', { fetchImpl: boom })).note, 'ECONNREFUSED');
});

test('unsubscribe: preview via the CLI sends nothing and writes no results', () => {
  const d = tmp();
  const f = path.join(d, 'approved.json');
  writeFileSync(f, JSON.stringify(approval([{ sender: 'a@x.com', do: 'one_click', https: 'https://x.com/u' }])));
  const out = execFileSync(process.execPath, [GMF, 'unsubscribe', '--approved', f], { encoding: 'utf8', env: { ...process.env, HOME: d } });
  assert.match(out, /would POST .* for 1 approved sender/);
  assert.match(out, /nothing sent/);
  assert.equal(existsSync(path.join(d, 'approved.results.jsonl')), false);
  rmSync(d, { recursive: true, force: true });
});


test('unsub-plan: header parsing unfolds and keeps every Authentication-Results', () => {
  const h = parseHeaders('From: A <a@x.com>\r\nList-Unsubscribe:\r\n <https://x.com/u>\r\nAuthentication-Results: one\r\nAuthentication-Results: two\r\n\r\nbody');
  assert.equal(h.first['list-unsubscribe'], '<https://x.com/u>');
  assert.deepEqual(h.all['authentication-results'], ['one', 'two']);
});

test('unsub-plan: classify one-click, mailto, landing, none — including encoded and bracketless headers', () => {
  const post = 'List-Unsubscribe=One-Click';
  assert.equal(classifyUnsubscribe('<mailto:u@x.com>, <https://x.com/u>', post).method, 'one_click');
  assert.equal(classifyUnsubscribe('<mailto:u@x.com>, <https://x.com/u>', '').method, 'mailto');
  assert.equal(classifyUnsubscribe('<https://x.com/u>', '').method, 'landing');
  assert.equal(classifyUnsubscribe('', '').method, 'none');
  const q = '=?us-ascii?Q?=3Chttps=3A=2F=2Fm=2Ek=2Ecom=2Fu=3Fa=3D1?= =?us-ascii?Q?&c=3D2=3E?=';
  assert.equal(decodeWords(q), '<https://m.k.com/u?a=1&c=2>');
  assert.deepEqual(classifyUnsubscribe(q, post), { method: 'one_click', https: 'https://m.k.com/u?a=1&c=2', mailto: null });
  assert.equal(classifyUnsubscribe('=?utf-8?q?https=3A=2F=2Fs=2Eexample=2Ecom=2Fopt?=', post).https, 'https://s.example.com/opt');
});

test('unsub-plan: DKIM alignment by registrable domain', () => {
  const ar = ['mx.google.com; dkim=pass header.i=@e.shop.com header.s=s1; spf=pass'];
  assert.equal(dkimAligned(ar, 'news@mail.shop.com'), true);
  assert.equal(dkimAligned(ar, 'news@other.com'), false);
  assert.equal(dkimAligned(['mx; dkim=fail header.d=shop.com'], 'a@shop.com'), false);
});
