// imsg tests — run against a synthetic chat.db and Contacts store built in a temp dir, so no
// real message is read and nothing is sent: osascript and /dev/tty are injected fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { main, VERBS, TEXT_MAX, parseSince } from '../imsg.mjs';
import { decodeAttributedBody, messageText } from '../lib/typedstream.mjs';
import { handleKey, looksLikeHandle } from '../lib/contacts.mjs';
import { appleToMs, msToApple } from '../lib/db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- fixtures

/** A typedstream NSAttributedString blob shaped like Messages writes it. */
function archive(text, { mutable = false } = {}) {
  const body = Buffer.from(text, 'utf8');
  let len;
  if (body.length < 0x80) len = Buffer.from([body.length]);
  else if (body.length < 0x10000) { len = Buffer.alloc(3); len[0] = 0x81; len.writeUInt16LE(body.length, 1); }
  else { len = Buffer.alloc(5); len[0] = 0x82; len.writeUInt32LE(body.length, 1); }
  const chain = mutable ? Buffer.concat([Buffer.from([0x84, 0x84, 0x0f]), Buffer.from('NSMutableString'), Buffer.from([0x01, 0x84, 0x84, 0x08])]) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped'), Buffer.from([0x81, 0xe8, 0x03]),
    Buffer.from([0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]), Buffer.from('NSAttributedString'), Buffer.from([0x00, 0x84, 0x84, 0x08]), Buffer.from('NSObject'),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84]), chain,
    Buffer.from('NSString'), Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b]), len, body,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
  ]);
}

const T0 = Date.parse('2026-09-01T12:00:00Z');
const at = (min) => msToApple(T0 + min * 60_000);

function buildWorld() {
  const dir = mkdtempSync(path.join(tmpdir(), 'imsg-test-'));
  const chatDb = path.join(dir, 'chat.db');
  const db = new DatabaseSync(chatDb);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, date_read INTEGER, date_delivered INTEGER,
      is_from_me INTEGER, is_sent INTEGER, is_delivered INTEGER, is_read INTEGER, error INTEGER, service TEXT, item_type INTEGER,
      associated_message_type INTEGER, associated_message_emoji TEXT, cache_has_attachments INTEGER, date_edited INTEGER, date_retracted INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, filename TEXT, mime_type TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins(`INSERT INTO handle VALUES (1, '+15550100001', 'iMessage'), (2, '+15550100001', 'SMS'), (3, 'bob@example.com', 'iMessage'), (4, '+15550100003', 'iMessage')`);
  ins(`INSERT INTO chat VALUES (1, 'iMessage;-;+15550100001', '+15550100001', NULL, 'iMessage', 45),
                              (2, 'SMS;-;+15550100001', '+15550100001', NULL, 'SMS', 45),
                              (3, 'iMessage;+;chat900', 'chat900', 'Book Club', 'iMessage', 43),
                              (4, 'iMessage;-;bob@example.com', 'bob@example.com', NULL, 'iMessage', 45)`);
  ins(`INSERT INTO chat_handle_join VALUES (1,1),(2,2),(3,1),(3,3),(4,3)`);
  let rowid = 0;
  const msg = (chat, { text = null, body = null, min, me = 0, handle = 1, service = 'iMessage', amt = 0, item = 0, att = 0 }) => {
    rowid++;
    ins(`INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, is_sent, is_delivered, is_read, error, service, item_type, associated_message_type, cache_has_attachments, handle_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`, rowid, `G-${rowid}`, text, body, at(min), me, me, me, service, item, amt, att, handle);
    ins(`INSERT INTO chat_message_join VALUES (?, ?, ?)`, chat, rowid, at(min));
    return rowid;
  };
  msg(1, { text: 'hello from alice', min: 1 });
  msg(1, { body: archive('only in the archive, pineapple'), min: 2 });
  msg(1, { body: archive('reply from me'), min: 3, me: 1 });
  msg(2, { text: 'an sms thread message', min: 4, handle: 2, service: 'SMS' });
  msg(1, { text: null, body: null, min: 5, amt: 2000 });
  const withPic = msg(1, { body: archive('￼a photo'), min: 6, att: 1 });
  ins(`INSERT INTO attachment VALUES (1, 'IMG_0001.HEIC', '~/Library/Messages/Attachments/x/IMG_0001.HEIC', 'image/heic', 2200000)`);
  ins(`INSERT INTO message_attachment_join VALUES (?, 1)`, withPic);
  msg(3, { text: 'group hello', min: 7, handle: 3 });
  msg(4, { body: archive('x'.repeat(300), { mutable: true }), min: 8, handle: 3 });

  const contactsDir = path.join(dir, 'AddressBook');
  const src = path.join(contactsDir, 'Sources', 'A');
  mkdirSync(src, { recursive: true });
  const cdb = new DatabaseSync(path.join(src, 'AddressBook-v22.abcddb'));
  cdb.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
    INSERT INTO ZABCDRECORD VALUES (1, 'Alice', 'Example', NULL, NULL), (2, 'Bob', 'Sample', NULL, NULL), (3, 'Alicia', 'Other', NULL, NULL), (4, 'Carol', 'Newperson', NULL, NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '(555) 010-0001'), (2, 3, '555-010-0003'), (3, 4, '555-010-0099'), (4, 4, '555-010-0098');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 2, 'Bob@Example.com');
  `);
  cdb.close();
  return { dir, chatDb, contactsDir, db, home: path.join(dir, 'home'), nextRowid: () => ++rowid, insertMessage: msg };
}

function run(world, argv, extra = {}) {
  const out = [];
  const err = [];
  const code = main(argv, {
    chatDb: world.chatDb, contactsDir: world.contactsDir, home: world.home,
    out: (s) => out.push(s), err: (s) => err.push(s),
    tty: extra.tty ?? { has: () => false, readLine: () => null, why: 'test: no terminal' },
    osascript: extra.osascript ?? (() => { throw new Error('osascript must not be called'); }),
    sleep: () => {}, verifyTimeoutMs: extra.verifyTimeoutMs ?? 0,
    ...extra.overrides,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), outLines: out };
}

const tty = (answer) => ({ has: () => true, readLine: () => answer, why: null });

// ---------------------------------------------------------------- decoding and helpers

test('decodeAttributedBody: short, long (0x81), mutable class chain, junk', () => {
  assert.equal(decodeAttributedBody(archive('hi there')), 'hi there');
  const long = 'é'.repeat(200);
  assert.equal(decodeAttributedBody(archive(long)), long);
  assert.equal(decodeAttributedBody(archive('mutable one', { mutable: true })), 'mutable one');
  assert.equal(decodeAttributedBody(Buffer.from('no marker here')), null);
  const cut = archive('truncated text');
  assert.equal(decodeAttributedBody(cut.subarray(0, cut.indexOf('truncated') + 4)), null);
  assert.equal(decodeAttributedBody(null), null);
  assert.equal(decodeAttributedBody(new Uint8Array(archive('from a Uint8Array'))), 'from a Uint8Array');
});

test('messageText prefers text, falls back to the archive, strips U+FFFC', () => {
  assert.equal(messageText({ text: 'plain', attributedBody: archive('other') }), 'plain');
  assert.equal(messageText({ text: null, attributedBody: archive('￼ caption') }), 'caption');
  assert.equal(messageText({ text: '', attributedBody: null }), null);
});

test('handleKey matches spellings of one handle; looksLikeHandle separates names', () => {
  assert.equal(handleKey('+1 (555) 010-0001'), handleKey('5550100001'));
  assert.equal(handleKey('Bob@Example.com'), 'bob@example.com');
  assert.ok(looksLikeHandle('+15550100001'));
  assert.ok(looksLikeHandle('bob@example.com'));
  assert.ok(!looksLikeHandle('Alice Example'));
  assert.ok(!looksLikeHandle('42'));
});

test('apple timestamps: nanoseconds and legacy seconds', () => {
  assert.equal(appleToMs(msToApple(T0)), T0);
  assert.equal(appleToMs(Math.round(T0 / 1000 - 978307200)), T0);
  assert.equal(appleToMs(0), null);
});

test('parseSince: spans and ISO', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  assert.equal(parseSince('2d', now), now - 2 * 86400e3);
  assert.equal(parseSince('2026-09-01', now), Date.parse('2026-09-01'));
  assert.equal(parseSince('nonsense', now), undefined);
  assert.equal(parseSince(undefined, now), null);
});

// ---------------------------------------------------------------- reads

test('chats: newest first, names from Contacts, groups flagged', () => {
  const w = buildWorld();
  const r = run(w, ['chats', '--json']);
  assert.equal(r.code, 0);
  const rows = r.outLines.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((c) => c.id), [4, 3, 1, 2]);
  assert.equal(rows.find((c) => c.id === 3).label, 'Book Club');
  assert.equal(rows.find((c) => c.id === 3).group, true);
  assert.equal(rows.find((c) => c.id === 1).label, 'Alice Example');
  assert.equal(rows.find((c) => c.id === 4).label, 'Bob Sample');
});

test('history by name merges the iMessage and SMS threads, oldest first, archive text decoded', () => {
  const w = buildWorld();
  const r = run(w, ['history', 'Alice Example', '--json']);
  assert.equal(r.code, 0);
  const rows = r.outLines.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((m) => m.text), ['hello from alice', 'only in the archive, pineapple', 'reply from me', 'an sms thread message', 'loved a message', 'a photo']);
  assert.equal(rows[2].from, 'me');
  assert.equal(rows[4].kind, 'reaction');
  assert.equal(rows[5].attachments[0].name, 'IMG_0001.HEIC');
  const human = run(w, ['history', '+1 555 010 0001', '--limit', '2']);
  assert.match(human.out, /\[attachment IMG_0001\.HEIC, image\/heic, 2\.1 MB\]/);
  assert.equal(human.outLines.length, 2);
});

test('history: unknown name, ambiguous name, unknown chat id are usage errors', () => {
  const w = buildWorld();
  assert.equal(run(w, ['history', 'Nobody Atall']).code, 2);
  const amb = run(w, ['history', 'Ali']);
  assert.equal(amb.code, 2);
  assert.match(amb.err, /matches 2 contacts/);
  assert.equal(run(w, ['history', '9999']).code, 2);
});

test('search finds text that exists only in attributedBody, and reports what it scanned', () => {
  const w = buildWorld();
  const r = run(w, ['search', 'PINEAPPLE', '--json']);
  assert.equal(r.code, 0);
  const hits = r.outLines.map((l) => JSON.parse(l));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chat_label, 'Alice Example');
  assert.match(r.err, /1 hit\(s\) .* in 8 message\(s\) scanned/);
});

test('whois: name → handles → chats', () => {
  const w = buildWorld();
  const r = run(w, ['whois', 'bob', '--json']);
  const o = JSON.parse(r.outLines[0]);
  assert.equal(o.name, 'Bob Sample');
  assert.deepEqual(o.handles[0].chats.map((c) => c.id), [4]);
});

test('export writes JSONL 600 and never overwrites', () => {
  const w = buildWorld();
  const out = path.join(w.dir, 'x', 'alice.jsonl');
  const r = run(w, ['export', 'Alice', 'Example', '--out', out]);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 6);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(run(w, ['export', 'Alice', 'Example', '--out', out]).code, 2);
});

test('watch prints only rows that arrive after it starts', () => {
  const w = buildWorld();
  let calls = 0;
  let now = 0;
  const r = run(w, ['watch', '--interval', '1', '--for', '3', '--json'], {
    overrides: {
      now: () => now,
      sleep: () => { now += 1000; if (++calls === 1) w.insertMessage(4, { text: 'new arrival', min: 30, handle: 3 }); },
    },
  });
  assert.equal(r.code, 0);
  const rows = r.outLines.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((m) => m.text), ['new arrival']);
});

// ---------------------------------------------------------------- send: the gate

test('send --explain previews and never calls osascript', () => {
  const w = buildWorld();
  const r = run(w, ['send', 'Bob Sample', 'see you at 7', '--explain']);
  assert.equal(r.code, 0);
  assert.match(r.out, /To: +Bob Sample <bob@example\.com>/i);
  assert.match(r.out, /existing conversation/);
});

test('send with no terminal stages (even with --yes): 600 record, exit 3, nothing sent', () => {
  const w = buildWorld();
  const r = run(w, ['send', '+15550100001', 'running late', '--yes']);
  assert.equal(r.code, 3);
  const res = JSON.parse(r.outLines.at(-1));
  assert.equal(res.error, 'pending_confirmation');
  const file = path.join(w.home, 'pending', `${res.code}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(w.home, 'pending')).mode & 0o777, 0o700);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(rec.args, { recipient: '+15550100001', chat: null, service: null, text: 'running late' });
  assert.match(r.err, /--yes is honored only at a terminal/);
});

test('send at a terminal: anything but the exact word "send" aborts', () => {
  const w = buildWorld();
  for (const answer of ['y', 'yes', 'Send', '', 'send it']) {
    const r = run(w, ['send', 'Bob Sample', 'hi'], { tty: tty(answer) });
    assert.equal(r.code, 1, `answer ${JSON.stringify(answer)} must abort`);
  }
});

function fakeMessages(world, calls) {
  return (req) => {
    calls.push(req);
    // Messages writes the outgoing row; the tool must find it on re-read.
    world.insertMessage(req.kind === 'chat' && req.target.includes('bob') ? 4 : 1, { text: req.text, min: 60, me: 1, handle: req.target.includes('bob') ? 3 : 1 });
    return { status: 0, stdout: 'sent', stderr: '' };
  };
}

test('send at a terminal with "send": osascript gets the chat guid and text as argv; re-read confirms; audit has no text', () => {
  const w = buildWorld();
  const calls = [];
  const r = run(w, ['send', 'Bob Sample', 'dinner at 7? -e "quoted"'], { tty: tty('send'), osascript: fakeMessages(w, calls) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls, [{ target: 'iMessage;-;bob@example.com', text: 'dinner at 7? -e "quoted"', kind: 'chat' }]);
  assert.match(r.out, /re-read confirms message \d+/);
  const log = readFileSync(path.join(w.home, 'audit.log'), 'utf8');
  assert.match(log, /verb=send via=terminal .* result=sent rowid=\d+/);
  assert.doesNotMatch(log, /dinner/);
  assert.equal(statSync(path.join(w.home, 'audit.log')).mode & 0o777, 0o600);
});

test('send to a handle with no conversation goes as a participant of the service', () => {
  const w = buildWorld();
  const calls = [];
  const r = run(w, ['send', '+15550100077', 'hello new person', '--service', 'sms'], {
    tty: tty('send'),
    osascript: (req) => { calls.push(req); w.db.prepare(`INSERT INTO handle VALUES (9, '+15550100077', 'SMS')`).run(); w.insertMessage(99, { text: req.text, min: 61, me: 1, handle: 9, service: 'SMS' }); return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls[0], { target: '+15550100077', text: 'hello new person', kind: 'SMS' });
  assert.match(r.err, /NEW conversation/);
});

test('send: Messages says ok but no row appears → RE-READ MISMATCH, exit 1', () => {
  const w = buildWorld();
  const r = run(w, ['send', 'Bob Sample', 'ghost'], { tty: tty('send'), osascript: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /RE-READ MISMATCH/);
  assert.match(readFileSync(path.join(w.home, 'audit.log'), 'utf8'), /result=unverified/);
});

test('send: osascript failure is reported with a hint, exit 1', () => {
  const w = buildWorld();
  const r = run(w, ['send', 'Bob Sample', 'x'], { tty: tty('send'), osascript: () => ({ status: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Messages. (-1743)' }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /Automation/);
});

test('send refusals: ambiguous name, multi-handle contact with no chat, over the ceiling, no text', () => {
  const w = buildWorld();
  assert.equal(run(w, ['send', 'Ali', 'hi']).code, 2);
  const carol = run(w, ['send', 'Carol', 'hi']);
  assert.equal(carol.code, 2);
  assert.match(carol.err, /2 handles and no conversation/);
  assert.equal(run(w, ['send', 'Bob Sample', 'x'.repeat(TEXT_MAX + 1)]).code, 2);
  assert.equal(run(w, ['send', 'Bob Sample']).code, 2);
  assert.equal(run(w, ['send', '--chat', '3', '--service', 'sms', 'hi']).code, 2);
});

test('send --chat targets a group by guid', () => {
  const w = buildWorld();
  const r = run(w, ['send', '--chat', '3', 'hi all', '--explain']);
  assert.equal(r.code, 0);
  assert.match(r.out, /GROUP — 2 people/);
});

// ---------------------------------------------------------------- approve

function stage(w, argv) {
  const r = run(w, argv);
  assert.equal(r.code, 3);
  return JSON.parse(r.outLines.at(-1)).code;
}

test('approve: no terminal refuses and keeps the record; wrong word keeps it; "send" delivers once', () => {
  const w = buildWorld();
  const code = stage(w, ['send', 'Bob Sample', 'staged hello']);
  assert.equal(run(w, ['approve', code]).code, 4);
  assert.ok(existsSync(path.join(w.home, 'pending', `${code}.json`)));
  assert.equal(run(w, ['approve', code], { tty: tty('yes') }).code, 3);
  assert.ok(existsSync(path.join(w.home, 'pending', `${code}.json`)));
  const calls = [];
  const ok = run(w, ['approve', code], { tty: tty('send'), osascript: fakeMessages(w, calls) });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'staged hello');
  assert.ok(!existsSync(path.join(w.home, 'pending', `${code}.json`)), 'single use');
  assert.equal(run(w, ['approve', code], { tty: tty('send') }).code, 1);
});

test('approve --list and --discard; an expired record is never run', () => {
  const w = buildWorld();
  const code = stage(w, ['send', 'Bob Sample', 'to discard']);
  assert.match(run(w, ['approve', '--list']).out, new RegExp(code));
  assert.equal(JSON.parse(run(w, ['approve', '--discard', code]).out).existed, true);
  assert.equal(readdirSync(path.join(w.home, 'pending')).length, 0);
  const late = stage(w, ['send', 'Bob Sample', 'too late']);
  const r = run(w, ['approve', late], { tty: tty('send'), overrides: { now: () => Date.now() + 16 * 60_000 } });
  assert.equal(r.code, 1);
  assert.match(r.out, /no_such_pending/);
});

// ---------------------------------------------------------------- the manifest must not lie

test('manifest verbs[] matches the VERBS table in code', () => {
  const m = JSON.parse(readFileSync(path.join(HERE, '..', 'toolbelt.json'), 'utf8'));
  const declared = Object.fromEntries(m.verbs.filter((v) => v.tier !== 'never').map((v) => [v.name, { tier: v.tier, gate: v.gate }]));
  const code = Object.fromEntries(Object.entries(VERBS).map(([k, v]) => [k, { tier: v.tier, gate: v.gate }]));
  assert.deepEqual(declared, code);
});

test.after(() => {
  for (const d of readdirSync(tmpdir())) if (d.startsWith('imsg-test-')) rmSync(path.join(tmpdir(), d), { recursive: true, force: true });
});
