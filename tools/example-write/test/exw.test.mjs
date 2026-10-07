// exw tests — tiering, preview rendering, the staging record, typed-echo parsing, and the
// approve path. A temp home per test; the terminal is injected, never /dev/tty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, tierOf, VERBS, typedEchoMatches, yesMatches, renderPostPreview, makeEnv, stageWrite, loadPending, listPending, parseArgs, PENDING_TTL_S, TOOL } from '../exw.mjs';

/** A harness: temp home, captured stdout/stderr, a scripted terminal, a frozen clock. */
function rig({ tty = 'absent', answers = [], platform = 'darwin', now } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'exw-'));
  const out = [];
  const err = [];
  const prompts = [];
  const clock = { t: now ?? Date.UTC(2026, 7, 22, 12, 0, 0) };
  const term = tty === 'absent'
    ? { has: () => false, readLine: () => null, why: 'test: no terminal' }
    : { has: () => true, readLine: (p) => { prompts.push(p); return answers.shift() ?? ''; }, why: null };
  const run = (argv, extra = {}) => main(argv, { home, out: (s) => out.push(s), err: (s) => err.push(s), tty: term, platform, now: () => clock.t, stdinIsTTY: false, ...extra });
  const notes = () => (existsSync(path.join(home, 'notes.txt')) ? readFileSync(path.join(home, 'notes.txt'), 'utf8') : '');
  const board = () => (existsSync(path.join(home, 'shared-board.txt')) ? readFileSync(path.join(home, 'shared-board.txt'), 'utf8') : '');
  const pending = () => (existsSync(path.join(home, 'pending')) ? readdirSync(path.join(home, 'pending')) : []);
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  return { home, out, err, prompts, clock, run, notes, board, pending, cleanup, all: () => [...out, ...err].join('\n') };
}

test('tiers: every verb is declared and the tiers match the manifest vocabulary', () => {
  assert.equal(tierOf('list').tier, 'read');
  assert.equal(tierOf('show').tier, 'read');
  assert.equal(tierOf('note add').tier, 'write');
  assert.equal(tierOf('note rm').tier, 'write');
  assert.deepEqual([tierOf('board post').tier, tierOf('board post').gate], ['write-gated', 'flag']);
  assert.deepEqual([tierOf('board clear').tier, tierOf('board clear').gate], ['write-gated', 'typed-echo']);
  assert.equal(tierOf('nope'), null);
  const manifest = JSON.parse(readFileSync(new URL('../toolbelt.json', import.meta.url), 'utf8'));
  for (const v of manifest.verbs) {
    const code = VERBS[v.name];
    assert.ok(code, `manifest verb ${v.name} has no code tier`);
    assert.equal(v.tier, code.tier, `${v.name} tier`);
    assert.equal(v.gate, code.gate, `${v.name} gate`);
  }
  assert.equal(manifest.entrypoints.approve, 'node exw.mjs approve');
});

test('parseArgs: flags anywhere, --discard takes a value, -- ends flags', () => {
  assert.deepEqual(parseArgs(['board', 'post', 'hi', 'there', '--yes']), { flags: { yes: true }, positional: ['board', 'post', 'hi', 'there'] });
  assert.deepEqual(parseArgs(['approve', '--discard', 'abc123']).flags, { discard: 'abc123' });
  assert.deepEqual(parseArgs(['note', 'add', '--', '--not-a-flag']).positional, ['note', 'add', '--not-a-flag']);
});

test('reads: list and show on empty and populated files', () => {
  const r = rig();
  try {
    assert.equal(r.run(['list']), 0);
    assert.match(r.all(), /notes — .*notes\.txt \(0 lines\)/);
    assert.equal(r.run(['show', '1']), 2);
    r.run(['note', 'add', 'first']);
    r.out.length = 0;
    assert.equal(r.run(['show', '1']), 0);
    assert.equal(r.out.at(-1), 'first');
  } finally { r.cleanup(); }
});

test('note add (write tier): runs at once, loud line with undo, audit line, re-read reported', () => {
  const r = rig();
  try {
    assert.equal(r.run(['note', 'add', 'hello', 'world']), 0);
    assert.equal(r.notes(), 'hello world\n');
    assert.ok(r.out.some((l) => /^wrote .*notes\.txt \(\+1 line\) — undo: exw note rm 1$/.test(l)), r.out.join('\n'));
    assert.ok(r.err.some((l) => /^\[exw audit\] \S+ verb="note add" target=\S+notes\.txt bytes=\+12 lines=\+1$/.test(l)), r.err.join('\n'));
    assert.ok(r.err.some((l) => l.startsWith('re-read confirms:')));
    assert.ok(r.err.includes('  + hello world'));
    assert.equal(statSync(path.join(r.home, 'notes.txt')).mode & 0o777, 0o600);
  } finally { r.cleanup(); }
});

test('note rm: removes the line, undo names the exact text; bad index is a usage error', () => {
  const r = rig();
  try {
    r.run(['note', 'add', 'keep']);
    r.run(['note', 'add', "it's gone"]);
    assert.equal(r.run(['note', 'rm', '2']), 0);
    assert.equal(r.notes(), 'keep\n');
    assert.ok(r.out.some((l) => l.includes(`undo: exw note add 'it'\\''s gone'`)), r.out.join('\n'));
    assert.equal(r.run(['note', 'rm', '9']), 2);
  } finally { r.cleanup(); }
});

test('--explain on every write verb writes nothing', () => {
  const r = rig({ tty: 'present', answers: ['clear'] });
  try {
    r.run(['board', 'post', 'seed', '--yes']);
    const before = { notes: r.notes(), board: r.board() };
    assert.equal(r.run(['note', 'add', 'x', '--explain']), 0);
    assert.equal(r.run(['note', 'rm', '1', '--explain']), 2); // no note 1 exists — usage, still no write
    assert.equal(r.run(['board', 'post', 'x', '--explain']), 0);
    assert.equal(r.run(['board', 'clear', '--explain']), 0);
    assert.deepEqual({ notes: r.notes(), board: r.board() }, before);
    assert.equal(r.pending().length, 0);
    assert.equal(r.prompts.length, 0, 'explain never prompts');
    assert.ok(r.out.some((l) => l.startsWith('would delete all 1 line(s)')));
    assert.ok(r.out.includes('  - seed'));
  } finally { r.cleanup(); }
});

test('board post at a terminal: preview only, exit 0, nothing written, exact --yes re-run printed', () => {
  const r = rig({ tty: 'present' });
  try {
    assert.equal(r.run(['board', 'post', 'ship', 'it']), 0);
    assert.equal(r.board(), '');
    assert.equal(r.pending().length, 0);
    const text = r.err.join('\n');
    assert.match(text, /── board post preview ──/);
    assert.match(text, /Target: .*shared-board\.txt  \(0 lines now; this is the SHARED target/);
    assert.match(text, /Append:  line 1, 8 bytes/);
    assert.ok(text.split('\n').includes('ship it'), 'the literal text is in the preview');
    assert.ok(r.err.includes("  exw board post 'ship it' --yes"), text);
    assert.equal(r.prompts.length, 0, 'preview does not prompt');
  } finally { r.cleanup(); }
});

test('renderPostPreview shows the exact bytes and the current line count', () => {
  const r = rig();
  try {
    r.run(['board', 'post', 'one', '--yes']);
    const env = makeEnv({ home: r.home });
    const p = renderPostPreview(env, 'two');
    assert.match(p, /\(1 line now;/);
    assert.match(p, /Append:  line 2, 4 bytes/);
    assert.ok(p.split('\n').includes('two'));
  } finally { r.cleanup(); }
});

test('board post --yes writes, audits, re-reads', () => {
  const r = rig();
  try {
    assert.equal(r.run(['board', 'post', 'hello', '--yes']), 0);
    assert.equal(r.board(), 'hello\n');
    assert.ok(r.err.some((l) => /verb="board post" target=\S+shared-board\.txt bytes=\+6 lines=\+1/.test(l)), r.err.join('\n'));
    assert.ok(r.err.some((l) => l.startsWith('re-read confirms:')));
  } finally { r.cleanup(); }
});

test('board post with no terminal and no --yes: stages, exit 3, record matches the approve contract', () => {
  const r = rig();
  try {
    assert.equal(r.run(['board', 'post', 'from an agent']), 3);
    assert.equal(r.board(), '', 'nothing written');
    const files = r.pending();
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-z0-9]{6}\.json$/);
    const code = files[0].slice(0, 6);
    assert.equal(statSync(path.join(r.home, 'pending')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(r.home, 'pending', files[0])).mode & 0o777, 0o600);
    const rec = JSON.parse(readFileSync(path.join(r.home, 'pending', files[0]), 'utf8'));
    assert.deepEqual(Object.keys(rec).sort(), ['args', 'code', 'created', 'expires', 'expires_epoch', 'summary', 'tool', 'verb']);
    assert.equal(rec.code, code);
    assert.equal(rec.tool, TOOL);
    assert.equal(rec.verb, 'board post');
    assert.deepEqual(rec.args, ['from an agent']);
    assert.equal(rec.created, '2026-08-22T12:00:00Z');
    assert.equal(rec.expires, '2026-08-22T12:15:00Z');
    assert.equal(rec.expires_epoch, Math.floor(r.clock.t / 1000) + PENDING_TTL_S);
    assert.ok(r.err.includes(`staged — confirm with: toolbelt approve example-write ${code}`), r.err.join('\n'));
    const json = JSON.parse(r.out.at(-1));
    assert.equal(json.error, 'pending_confirmation');
    assert.equal(json.approve, `toolbelt approve example-write ${code}`);
    assert.ok(r.err.join('\n').split('\n').includes('from an agent'), 'the staged text is shown in the preview');
  } finally { r.cleanup(); }
});

test('--stage forces staging even at a terminal', () => {
  const r = rig({ tty: 'present' });
  try {
    assert.equal(r.run(['board', 'post', 'test the approve path', '--stage']), 3);
    assert.equal(r.pending().length, 1);
    assert.equal(r.board(), '');
  } finally { r.cleanup(); }
});

test('approve: --list, typed yes executes once and discards, a decline keeps the record', () => {
  const r = rig({ tty: 'present', answers: ['no', 'yes'] });
  try {
    r.run(['board', 'post', 'staged line', '--stage']);
    const code = r.pending()[0].slice(0, 6);
    r.out.length = 0;
    assert.equal(r.run(['approve', '--list']), 0);
    assert.match(r.out[0], new RegExp(`^${code}  expires 2026-08-22T12:15:00Z  board post: "staged line"`));
    assert.equal(r.run(['approve']), 0, 'bare approve lists');

    r.out.length = 0;
    assert.equal(r.run(['approve', code]), 3, 'declined');
    assert.equal(r.board(), '');
    assert.equal(r.pending().length, 1, 'record kept on decline');
    assert.match(r.out.at(-1), /write_not_confirmed/);
    assert.match(r.prompts[0], /Type "yes" to post it now; anything else keeps it staged/);
    assert.match(r.prompts[0], /Why: /);

    assert.equal(r.run(['approve', code]), 0, 'approved');
    assert.equal(r.board(), 'staged line\n');
    assert.equal(r.pending().length, 0, 'single use');
    assert.ok(r.err.some((l) => /verb="board post"/.test(l)), 'audit line on the approved write');

    r.out.length = 0;
    assert.equal(r.run(['approve', code]), 1, 'a consumed code is gone');
    assert.match(r.out.at(-1), /no_such_pending/);
  } finally { r.cleanup(); }
});

test('approve with no terminal refuses, never re-stages, never auto-approves', () => {
  const r = rig();
  try {
    r.run(['board', 'post', 'waiting']);
    const code = r.pending()[0].slice(0, 6);
    assert.equal(r.run(['approve', code]), 4);
    assert.equal(r.board(), '');
    assert.equal(r.pending().length, 1);
    assert.ok(r.err.some((l) => l.includes(`toolbelt approve example-write ${code}`) && l.includes(`exw board post 'waiting' --yes`)));
  } finally { r.cleanup(); }
});

test('approve --discard drops a record; expired records are pruned and unapprovable', () => {
  const r = rig({ tty: 'present', answers: ['yes'] });
  try {
    r.run(['board', 'post', 'a', '--stage']);
    r.run(['board', 'post', 'b', '--stage']);
    const [c1, c2] = r.pending().map((f) => f.slice(0, 6));
    assert.equal(r.run(['approve', '--discard', c1]), 0);
    assert.deepEqual(r.pending().map((f) => f.slice(0, 6)), [c2]);
    r.clock.t += PENDING_TTL_S * 1000; // exactly at expiry: gone
    assert.equal(r.run(['approve', c2]), 1);
    assert.equal(r.pending().length, 0);
    assert.equal(r.board(), '');
  } finally { r.cleanup(); }
});

test('approve refuses a record that is not a board post and discards it', () => {
  const r = rig({ tty: 'present', answers: ['yes'] });
  try {
    const env = makeEnv({ home: r.home, now: () => r.clock.t });
    const rec = stageWrite(env, { verb: 'board clear', args: [], summary: 'forged' });
    writeFileSync(path.join(r.home, 'pending', `${rec.code}.json`), JSON.stringify({ ...rec, verb: 'board clear' }));
    assert.equal(r.run(['approve', rec.code]), 1);
    assert.match(r.out.at(-1), /bad_record/);
    assert.equal(r.pending().length, 0);
    assert.equal(loadPending(env, rec.code), null);
    assert.equal(listPending(env).length, 0);
  } finally { r.cleanup(); }
});

test('typed-echo parsing: exact word only', () => {
  assert.equal(typedEchoMatches('clear', 'clear'), true);
  assert.equal(typedEchoMatches('clear\n', 'clear'), true);
  assert.equal(typedEchoMatches('clear\r\n', 'clear'), true);
  assert.equal(typedEchoMatches('Clear', 'clear'), false);
  assert.equal(typedEchoMatches(' clear', 'clear'), false);
  assert.equal(typedEchoMatches('clear please', 'clear'), false);
  assert.equal(typedEchoMatches('yes', 'clear'), false);
  assert.equal(typedEchoMatches('', 'clear'), false);
  assert.equal(typedEchoMatches(null, 'clear'), false);
  assert.equal(yesMatches('yes'), true);
  assert.equal(yesMatches('Y'), true);
  assert.equal(yesMatches('yes please'), false);
});

test('board clear: typed "clear" deletes; anything else leaves the board; the prompt explains itself', () => {
  const r = rig({ tty: 'present', answers: ['Clear', 'clear'] });
  try {
    r.run(['board', 'post', 'one', '--yes']);
    r.run(['board', 'post', 'two', '--yes']);
    assert.equal(r.run(['board', 'clear']), 1, 'mistyped');
    assert.equal(r.board(), 'one\ntwo\n');
    assert.match(r.prompts[0], /delete all 2 line\(s\)/);
    assert.match(r.prompts[0], /Why the gate:/);
    assert.match(r.prompts[0], /Type "clear" to delete 2 line\(s\); anything else \(or Enter\) leaves the board untouched/);
    assert.equal(r.run(['board', 'clear']), 0);
    assert.equal(r.board(), '');
    assert.ok(r.err.some((l) => /verb="board clear" target=\S+shared-board\.txt bytes=-8 lines=-2/.test(l)), r.err.join('\n'));
    assert.ok(r.err.includes('  - one') && r.err.includes('  - two'), 'the removed lines are reported');
    assert.equal(r.run(['board', 'clear']), 0, 'empty board: nothing to do, no prompt');
    assert.equal(r.prompts.length, 2);
  } finally { r.cleanup(); }
});

test('board clear with no terminal: refuses with the one command, exit 4; --force from a pipeline is refused too; nothing is staged', () => {
  const r = rig();
  try {
    r.run(['board', 'post', 'keep me', '--yes']);
    assert.equal(r.run(['board', 'clear']), 4);
    assert.equal(r.board(), 'keep me\n');
    assert.ok(r.err.some((l) => l.includes('run this at a terminal you are sitting at:  exw board clear')), r.err.join('\n'));
    assert.equal(r.run(['board', 'clear', '--force']), 4, '--force without /dev/tty is a guess, not a human');
    assert.equal(r.board(), 'keep me\n');
    assert.ok(r.err.some((l) => l.includes('--force is honored only at a terminal')));
    assert.equal(r.pending().length, 0, 'destructive tier never stages');
  } finally { r.cleanup(); }
});

test('board clear --force at a terminal: honored, no prompt, still reports what it did; --yes is a usage error everywhere', () => {
  for (const opts of [{}, { tty: 'present' }]) {
    const r = rig(opts);
    try {
      r.run(['board', 'post', 'x', '--yes']);
      assert.equal(r.run(['board', 'clear', '--yes']), 2, 'typed-echo has no --yes');
      assert.equal(r.board(), 'x\n');
      assert.equal(r.prompts.length, 0);
    } finally { r.cleanup(); }
  }
  const r = rig({ tty: 'present' });
  try {
    r.run(['board', 'post', 'x', '--yes']);
    assert.equal(r.run(['board', 'clear', '--force']), 0);
    assert.equal(r.board(), '');
    assert.equal(r.prompts.length, 0, 'the typed word is skipped on a deliberate --force at a terminal');
    assert.ok(r.out.some((l) => l.startsWith('cleared ') && l.includes('(-1 line(s))')));
    assert.ok(r.err.includes('  - x'));
  } finally { r.cleanup(); }
});

test('win32: no /dev/tty — board clear refuses and tells; board post previews when stdin is a console, stages otherwise', () => {
  const r = rig({ platform: 'win32' });
  try {
    r.run(['board', 'post', 'w', '--yes']);
    assert.equal(r.run(['board', 'clear']), 4);
    assert.equal(r.board(), 'w\n');
    assert.ok(r.err.some((l) => l.startsWith('On Windows there is no /dev/tty: delete the file by hand')));
    assert.equal(r.run(['board', 'post', 'p'], { stdinIsTTY: true }), 0, 'preview');
    assert.equal(r.run(['board', 'post', 'p'], { stdinIsTTY: false }), 3, 'staged');
    assert.equal(r.board(), 'w\n');
  } finally { r.cleanup(); }
});

test('usage errors exit 2 and print help', () => {
  const r = rig();
  try {
    assert.equal(r.run([]), 2);
    assert.equal(r.run(['help']), 0);
    assert.equal(r.run(['dance']), 2);
    assert.equal(r.run(['board', 'post']), 2);
    assert.equal(r.run(['note', 'add']), 2);
  } finally { r.cleanup(); }
});
