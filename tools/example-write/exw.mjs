#!/usr/bin/env node
// exw — the gated-write example tool.
//
// It manages two plain-text files under ~/.local/share/exw so every write tier in
// SENSIBILITIES #2 can be exercised end-to-end against something harmless:
//
//   notes.txt          private and reversible  → `note add` / `note rm` run at once, loudly,
//                                                 and print their own undo.
//   shared-board.txt   stands in for a system   → `board post` previews by default, writes
//                      other people can see       with --yes, and STAGES for `toolbelt approve`
//                                                 when no human terminal is present.
//                                              → `board clear` is destructive: the operator
//                                                 types the word "clear" on /dev/tty; --force skips
//                                                 the word only where /dev/tty opens, never from a pipeline.
//
// Why /dev/tty and not stdin. Whoever spawned this process owns its stdin and can pipe any
// answer into it — an agent, a cron job, a shell one-liner. The controlling terminal is the
// one thing a subprocess cannot forge: either a human is sitting at it or it does not open.
// So a gate that reads /dev/tty is a gate only a human can pass, and a failure to open it is
// a reliable "no human here" signal that turns into an exit with the ways forward, never a
// default yes. Windows has no /dev/tty; there the typed-echo tier degrades to refuse-and-tell
// (see gateDevice()).
//
// Exit codes: 0 done or previewed · 1 declined / mistyped · 2 usage · 3 staged, awaiting a
// human (or approve declined) · 4 a gate needed a terminal and none was there.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  statSync, unlinkSync, writeFileSync, chmodSync, constants as FS } from 'node:fs';
import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOL = 'example-write';
export const CLI = 'exw';
export const PENDING_TTL_S = 15 * 60;
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;

// ---------------------------------------------------------------- tiers (data, not prose)

/** Every verb's tier, as the manifest declares it. The code consults this table, so the
 *  manifest and the behaviour cannot drift apart silently. */
export const VERBS = {
  list: { tier: 'read' },
  show: { tier: 'read' },
  'note add': { tier: 'write', blast: 'private + reversible' },
  'note rm': { tier: 'write', blast: 'private + reversible' },
  'board post': { tier: 'write-gated', gate: 'flag', blast: 'shared, reversible (a post can be removed by hand)' },
  'board clear': { tier: 'write-gated', gate: 'typed-echo', blast: 'shared, destructive' },
  approve: { tier: 'write-gated', gate: 'tty', blast: 'executes one staged board post' },
};

export function tierOf(verb) {
  return VERBS[verb] ?? null;
}

// ---------------------------------------------------------------- environment

export function makeEnv(overrides = {}) {
  const home = overrides.home ?? process.env.EXW_HOME ?? path.join(homedir(), '.local', 'share', 'exw');
  const platform = overrides.platform ?? process.platform;
  const env = {
    home,
    platform,
    notes: path.join(home, 'notes.txt'),
    board: path.join(home, 'shared-board.txt'),
    pending: path.join(home, 'pending'),
    out: overrides.out ?? ((s) => process.stdout.write(s + '\n')),
    err: overrides.err ?? ((s) => process.stderr.write(s + '\n')),
    now: overrides.now ?? (() => Date.now()),
    stdinIsTTY: overrides.stdinIsTTY ?? Boolean(process.stdin.isTTY),
  };
  env.tty = overrides.tty ?? gateDevice(env);
  return env;
}

/** The display form of a path: the operator's home collapses to `~`. */
export function display(p) {
  const h = homedir();
  return p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

// ---------------------------------------------------------------- the controlling terminal

/**
 * The human gate's device. `has()` answers "could a human be asked right now"; `readLine()`
 * puts a prompt on stderr and returns one line typed at the controlling terminal, or null
 * when there is none. Reads are synchronous on purpose: a stream on /dev/tty parks a
 * blocking read in libuv's threadpool that node must join at exit, so the process would hang
 * after the work is done waiting for a keypress that never comes.
 *
 * Windows has no /dev/tty. A console stdin is the nearest thing, but stdin is exactly what
 * a spawner can feed, so this tier does not accept it: on win32 `has()` is false and the
 * destructive and approve gates refuse and tell the operator what to run by hand.
 */
export function gateDevice(env) {
  if (env.platform === 'win32') {
    return { has: () => false, readLine: () => null, why: 'Windows has no /dev/tty' };
  }
  return {
    has() {
      try { closeSync(openSync('/dev/tty', 'r')); return true; } catch { return false; }
    },
    readLine(prompt) {
      let fd;
      try { fd = openSync('/dev/tty', 'r'); } catch { return null; }
      try {
        process.stderr.write(prompt);
        const buf = Buffer.alloc(256);
        let line = '';
        for (;;) {
          let n;
          try { n = readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
          if (n <= 0) break;
          line += buf.toString('utf8', 0, n);
          if (line.includes('\n')) break;
        }
        return line.replace(/\r?\n$/, '');
      } finally { closeSync(fd); }
    },
    why: null,
  };
}

/** Typed-echo parsing: the answer must be the expected word, exactly — trimmed of the line
 *  ending only, case-sensitive. "Clear", "yes" and "clear please" all decline. */
export function typedEchoMatches(answer, expected) {
  if (answer === null || answer === undefined) return false;
  return answer.replace(/\r?\n$/, '') === expected;
}

export function yesMatches(answer) {
  return typeof answer === 'string' && /^(y|yes)$/i.test(answer.trim());
}

// ---------------------------------------------------------------- files

function ensureHome(env) {
  if (!existsSync(env.home)) mkdirSync(env.home, { recursive: true, mode: 0o700 });
}

export function readLines(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

function writeLines(env, file, lines) {
  ensureHome(env);
  writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
}

function byteSize(file) {
  try { return statSync(file).size; } catch { return 0; }
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Every write goes through here. The file is snapshotted, mutated, then RE-READ from disk:
 * a successful writeFileSync is a claim, the re-read is the evidence. The audit line goes
 * to stderr so it survives a redirected stdout (SENSIBILITIES #7).
 */
function performWrite(env, { verb, file, mutate, expect }) {
  const before = readLines(file);
  const bytesBefore = byteSize(file);
  const next = mutate(before.slice());
  writeLines(env, file, next);
  const after = readLines(file);
  const bytesAfter = byteSize(file);
  const stamp = new Date(env.now()).toISOString();
  env.err(`[${CLI} audit] ${stamp} verb="${verb}" target=${display(file)} bytes=${signed(bytesAfter - bytesBefore)} lines=${signed(after.length - before.length)}`);
  const ok = expect(after);
  const verdict = ok ? 're-read confirms' : 'RE-READ MISMATCH';
  env.err(`${verdict}: ${display(file)} now ${after.length} line(s), ${bytesAfter} bytes (was ${before.length} line(s), ${bytesBefore} bytes)`);
  const added = after.filter((l) => !before.includes(l));
  const removed = before.filter((l) => !after.includes(l));
  for (const l of removed) env.err(`  - ${l}`);
  for (const l of added) env.err(`  + ${l}`);
  return { ok, before, after, bytesBefore, bytesAfter };
}

// ---------------------------------------------------------------- reads

function cmdList(env, what) {
  const show = (label, file) => {
    const lines = readLines(file);
    env.out(`${label} — ${display(file)} (${lines.length} line${lines.length === 1 ? '' : 's'})`);
    lines.forEach((l, i) => env.out(`  ${i + 1}. ${l}`));
  };
  if (!what || what === 'notes') show('notes', env.notes);
  if (!what || what === 'board') show('board', env.board);
  if (what && what !== 'notes' && what !== 'board') return usage(env, `list takes "notes" or "board", not "${what}"`);
  return 0;
}

function cmdShow(env, n) {
  const idx = Number.parseInt(n, 10);
  const lines = readLines(env.notes);
  if (!Number.isInteger(idx) || idx < 1 || idx > lines.length) {
    env.err(`${CLI}: no note ${n} — ${display(env.notes)} has ${lines.length} line(s). Try: ${CLI} list notes`);
    return 2;
  }
  env.out(lines[idx - 1]);
  return 0;
}

// ---------------------------------------------------------------- write tier: private + reversible

function cmdNoteAdd(env, text, flags) {
  if (!text) return usage(env, 'note add needs the text to add');
  if (flags.explain) {
    env.out(`would append 1 line to ${display(env.notes)} (tier: write — private, reversible, no gate):`);
    env.out(`  + ${text}`);
    env.out(`undo afterwards: ${CLI} note rm ${readLines(env.notes).length + 1}`);
    return 0;
  }
  const r = performWrite(env, {
    verb: 'note add', file: env.notes,
    mutate: (lines) => { lines.push(text); return lines; },
    expect: (after) => after[after.length - 1] === text,
  });
  env.out(`wrote ${display(env.notes)} (+1 line) — undo: ${CLI} note rm ${r.after.length}`);
  return r.ok ? 0 : 1;
}

function cmdNoteRm(env, n, flags) {
  const idx = Number.parseInt(n, 10);
  const lines = readLines(env.notes);
  if (!Number.isInteger(idx) || idx < 1 || idx > lines.length) {
    env.err(`${CLI}: no note ${n} to remove — ${display(env.notes)} has ${lines.length} line(s)`);
    return 2;
  }
  const victim = lines[idx - 1];
  if (flags.explain) {
    env.out(`would remove line ${idx} from ${display(env.notes)} (tier: write — private, reversible, no gate):`);
    env.out(`  - ${victim}`);
    env.out(`undo afterwards: ${CLI} note add ${quote(victim)}`);
    return 0;
  }
  const r = performWrite(env, {
    verb: 'note rm', file: env.notes,
    mutate: (ls) => { ls.splice(idx - 1, 1); return ls; },
    expect: (after) => after.length === lines.length - 1,
  });
  env.out(`wrote ${display(env.notes)} (-1 line) — undo: ${CLI} note add ${quote(victim)}`);
  return r.ok ? 0 : 1;
}

export function quote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- write-gated tier: shared board

/** The preview a human judges before typing --yes: exactly the bytes that would land. */
export function renderPostPreview(env, text) {
  const current = readLines(env.board);
  return [
    `── board post preview ───────────────────────────`,
    `Target:  ${display(env.board)}  (${current.length} line${current.length === 1 ? '' : 's'} now; this is the SHARED target — others see it)`,
    `Append:  line ${current.length + 1}, ${Buffer.byteLength(text + '\n')} bytes`,
    `─────────────────────────────────────────────────`,
    text,
    `─────────────────────────────────────────────────`,
  ].join('\n');
}

// approve's one-shot, in-process approval. A module variable and nothing else on purpose:
// no env var, flag, or stdin can set it, so a subprocess caller has no way to pre-approve.
// It is consumed on first check and matches only the exact staged payload.
let approved = null;

function markApproved(record) {
  approved = { verb: record.verb, args: [...record.args] };
}

function consumeApproval(verb, args) {
  if (!approved) return false;
  const same = approved.verb === verb && approved.args.length === args.length && approved.args.every((a, i) => a === args[i]);
  approved = null; // single use, match or not
  return same;
}

function cmdBoardPost(env, text, flags) {
  if (!text) return usage(env, 'board post needs the text to post');
  if (flags.explain) {
    env.out(`would append 1 line to ${display(env.board)} (tier: write-gated — shared; preview by default, --yes executes, no terminal → staged for toolbelt approve):`);
    env.out(`  + ${text}`);
    return 0;
  }
  const go = flags.yes || consumeApproval('board post', [text]);
  if (!go) {
    const humanHere = env.tty.has() || (env.platform === 'win32' && env.stdinIsTTY);
    if (flags.stage || !humanHere) {
      const record = stageWrite(env, { verb: 'board post', args: [text], summary: `board post: ${JSON.stringify(text)} → ${display(env.board)}` });
      env.err(renderPostPreview(env, text));
      env.err(`staged — confirm with: toolbelt approve ${TOOL} ${record.code}`);
      env.err(`(nothing was written; the staged payload lives in ${display(env.pending)}/${record.code}.json until ${record.expires}; it runs only after a human types "yes" at a real terminal)`);
      env.out(JSON.stringify({ ok: false, error: 'pending_confirmation', code: record.code, approve: `toolbelt approve ${TOOL} ${record.code}`, expires: record.expires, summary: record.summary }));
      return 3;
    }
    env.err(renderPostPreview(env, text));
    env.err(`[board post] Preview only — nothing written. To post exactly this, re-run:`);
    env.err(`  ${CLI} board post ${quote(text)} --yes`);
    return 0;
  }
  const r = performWrite(env, {
    verb: 'board post', file: env.board,
    mutate: (lines) => { lines.push(text); return lines; },
    expect: (after) => after[after.length - 1] === text,
  });
  env.out(`wrote ${display(env.board)} (+1 line, now ${r.after.length}) — shared target; remove by hand with: ${CLI} board clear (destructive) or edit the file`);
  return r.ok ? 0 : 1;
}

function cmdBoardClear(env, flags) {
  const lines = readLines(env.board);
  if (flags.explain) {
    env.out(`would delete all ${lines.length} line(s) of ${display(env.board)} (tier: write-gated, gate: typed-echo — type "clear" on /dev/tty; --force skips the word only where /dev/tty opens; no --yes):`);
    for (const l of lines) env.out(`  - ${l}`);
    return 0;
  }
  if (lines.length === 0) {
    env.out(`${display(env.board)} is already empty — nothing to clear`);
    return 0;
  }
  const manual = `run this at a terminal you are sitting at:  ${CLI} board clear`;
  if (flags.yes) {
    env.err(`${CLI}: board clear takes no --yes — the gate is the word "clear" typed at /dev/tty, or --force from a terminal. ${manual}`);
    return 2;
  }
  if (flags.force) {
    // --force is a deliberate human's act and is honored (harm reduction, not prohibition) — but
    // only where a human could have typed it: /dev/tty must open. From a pipeline the flag is
    // indistinguishable from an agent's guess, so it is refused with the way forward, never
    // silently honored. The terminal test is about the harness, not the caller: a process that
    // inherits the operator's terminal session passes it, which is why the contract in CLAUDE.md
    // tells an agent never to pass --force itself.
    if (!env.tty.has()) {
      env.err(`${CLI}: --force is honored only at a terminal (${env.tty.why ?? 'no /dev/tty here'}); refusing to clear ${lines.length} line(s). ${manual}`);
      return 4;
    }
    env.err(`--force: skipping the typed-echo gate on your say-so.`);
  } else {
    const prompt = [
      ``,
      `DESTRUCTIVE — board clear`,
      `  What:  delete all ${lines.length} line(s) of ${display(env.board)}. This is the shared target: other people's posts go with yours.`,
      `  Why the gate: there is no undo for this file, so the word is typed rather than "y" — it proves you read the count.`,
      `  Type "clear" to delete ${lines.length} line(s); anything else (or Enter) leaves the board untouched.`,
      `> `,
    ].join('\n');
    const answer = env.tty.readLine(prompt);
    if (answer === null) {
      env.err(`${CLI}: board clear needs a human at /dev/tty to type "clear" (${env.tty.why ?? 'no controlling terminal here'}); nothing cleared. ${manual}`);
      if (env.platform === 'win32') env.err(`On Windows there is no /dev/tty: delete the file by hand if you mean it — ${env.board}`);
      return 4;
    }
    if (!typedEchoMatches(answer, 'clear')) {
      env.err(`aborted — you typed ${JSON.stringify(answer)}, not "clear"; ${display(env.board)} untouched (${lines.length} line(s)).`);
      return 1;
    }
  }
  const r = performWrite(env, {
    verb: 'board clear', file: env.board,
    mutate: () => [],
    expect: (after) => after.length === 0,
  });
  env.out(`cleared ${display(env.board)} (-${lines.length} line(s)) — no undo; the removed lines are listed above on stderr`);
  return r.ok ? 0 : 1;
}

// ---------------------------------------------------------------- staging (the approve contract)

/*
 * Staging contract, shared with `toolbelt approve <tool> <code>`:
 *   directory   $EXW_HOME/pending/  (default ~/.local/share/exw/pending/), mode 700
 *   file        <code>.json, mode 600, created O_EXCL — never overwritten
 *   code        6 chars of [a-z0-9], randomInt
 *   record      { code, tool, verb, args[], summary, created, expires, expires_epoch }
 *   expiry      15 minutes; pruned on every touch; an expired record is never executed
 *   single use  the record is deleted after approve runs, whether the write succeeded or not
 *   never       a credential (this tool has none, and the contract forbids one regardless)
 * The belt's approve verb runs entrypoints.approve from the manifest with [code] | --list |
 * --discard <code>; it adds nothing to the gate, the gate is cmdApprove below.
 */

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function newCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function pruneExpired(env) {
  if (!existsSync(env.pending)) return 0;
  let n = 0;
  for (const f of readdirSync(env.pending)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(env.pending, f);
    let expired;
    try { expired = env.now() >= Number(JSON.parse(readFileSync(p, 'utf8')).expires_epoch) * 1000; } catch { expired = true; }
    if (expired) { unlinkSync(p); n++; }
  }
  return n;
}

export function stageWrite(env, { verb, args, summary }) {
  ensureHome(env);
  mkdirSync(env.pending, { recursive: true, mode: 0o700 });
  chmodSync(env.pending, 0o700);
  pruneExpired(env);
  const now = env.now();
  const record = { code: newCode(), tool: TOOL, verb, args: [...args], summary, created: iso(now), expires: iso(now + PENDING_TTL_S * 1000), expires_epoch: Math.floor((now + PENDING_TTL_S * 1000) / 1000) };
  for (;;) {
    try {
      const fd = openSync(path.join(env.pending, `${record.code}.json`), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
      writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
      closeSync(fd);
      return record;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      record.code = newCode();
    }
  }
}

export function loadPending(env, code) {
  pruneExpired(env);
  const p = path.join(env.pending, `${code}.json`);
  if (!/^[a-z0-9]{6}$/.test(code) || !existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function listPending(env) {
  pruneExpired(env);
  if (!existsSync(env.pending)) return [];
  return readdirSync(env.pending).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { return JSON.parse(readFileSync(path.join(env.pending, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

export function discardPending(env, code) {
  const p = path.join(env.pending, `${code}.json`);
  if (existsSync(p)) { unlinkSync(p); return true; }
  return false;
}

function cmdApprove(env, positional, flags) {
  if (flags.list || (!positional[0] && !flags.discard)) {
    const pending = listPending(env);
    if (!pending.length) { env.out(`No staged writes pending under ${display(env.pending)}.`); return 0; }
    for (const r of pending) env.out(`${r.code}  expires ${r.expires}  ${r.summary}`);
    return 0;
  }
  if (flags.discard) {
    const gone = discardPending(env, flags.discard);
    env.out(JSON.stringify({ ok: true, discarded: flags.discard, existed: gone }));
    return 0;
  }
  const code = positional[0];
  const record = loadPending(env, code);
  if (!record) {
    env.out(JSON.stringify({ ok: false, error: 'no_such_pending', message: `No staged write ${JSON.stringify(code)} (staged writes live ${PENDING_TTL_S / 60} minutes; it may have expired). Ask the agent to compose it again.` }));
    return 1;
  }
  if (record.tool !== TOOL || record.verb !== 'board post' || !Array.isArray(record.args) || record.args.length !== 1) {
    discardPending(env, code);
    env.out(JSON.stringify({ ok: false, error: 'bad_record', message: `Refusing to run a record for ${record.tool}/${record.verb}; record discarded.` }));
    return 1;
  }
  const [text] = record.args;
  env.err(`\nStaged write ${code} — ${record.summary}\n  staged : ${record.created}   expires: ${record.expires}`);
  env.err(renderPostPreview(env, text));
  const prompt = [
    `CONFIRM — ${TOOL} board post`,
    `  What:  append the line above to ${display(env.board)}, the shared target.`,
    `  Why:   an agent composed this without a terminal; the write waits for you, not for it (SENSIBILITIES #2).`,
    `  Type "yes" to post it now; anything else keeps it staged (discard with: toolbelt approve ${TOOL} --discard ${code}).`,
    `> `,
  ].join('\n');
  const answer = env.tty.readLine(prompt);
  if (answer === null) {
    // No terminal: refuse. Never re-stage, never auto-approve. The deliberate operator still
    // has a path — the same write, typed by hand with --yes at a console.
    env.err(`${CLI}: approve needs /dev/tty to take a typed "yes" (${env.tty.why ?? 'no controlling terminal here'}). Record kept. Run \`toolbelt approve ${TOOL} ${code}\` in a real terminal, or post it yourself: ${CLI} board post ${quote(text)} --yes`);
    return 4;
  }
  if (!yesMatches(answer)) {
    env.out(JSON.stringify({ ok: false, error: 'write_not_confirmed', message: `Not approved. Staged write ${code} is kept until ${record.expires}; discard with: toolbelt approve ${TOOL} --discard ${code}` }));
    return 3;
  }
  markApproved(record);
  let rc;
  try {
    rc = cmdBoardPost(env, text, {});
  } finally {
    discardPending(env, code); // single-use, whether the write succeeded or not
    approved = null;
  }
  return rc;
}

// ---------------------------------------------------------------- cli

const HELP = `${CLI} — the gated-write example: two local text files, every write tier

reads (free)
  ${CLI} list [notes|board]          both files, numbered
  ${CLI} show <n>                    note n

write — private + reversible (runs at once, prints its undo)
  ${CLI} note add <text>
  ${CLI} note rm <n>

write-gated — shared target (preview by default)
  ${CLI} board post <text>           preview only, exit 0
  ${CLI} board post <text> --yes     write, after a human approved the preview
  ${CLI} board post <text> --stage   stage for approve even at a terminal
      with no terminal and no --yes the post is STAGED: toolbelt approve ${TOOL} <code>

write-gated — destructive (typed-echo on /dev/tty)
  ${CLI} board clear                 type "clear" at the controlling terminal; there is no --yes
  ${CLI} board clear --force         skip the typed word — honored only where /dev/tty opens, never from a pipeline

approve (what \`toolbelt approve ${TOOL} …\` runs)
  ${CLI} approve <code> | --list | --discard <code>

flags   --explain  print what a write verb would do, write nothing (note add, note rm, board post, board clear)
env     EXW_HOME   where the files live (default ~/.local/share/exw)`;

function usage(env, msg) {
  env.err(`${CLI}: ${msg}\n\n${HELP}`);
  return 2;
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a === '--discard') { flags.discard = argv[++i]; continue; }
    if (a.startsWith('--discard=')) { flags.discard = a.slice(10); continue; }
    if (a.startsWith('--')) { flags[a.slice(2)] = true; continue; }
    positional.push(a);
  }
  return { flags, positional };
}

export function main(argv, overrides = {}) {
  const env = makeEnv(overrides);
  const { flags, positional } = parseArgs(argv);
  const [v1, v2, ...rest] = positional;
  if (!v1 || flags.help || v1 === 'help') { env.out(HELP); return v1 ? 0 : 2; }
  switch (v1) {
    case 'list': return cmdList(env, v2);
    case 'show': return v2 ? cmdShow(env, v2) : usage(env, 'show needs a note number');
    case 'note':
      if (v2 === 'add') return cmdNoteAdd(env, rest.join(' '), flags);
      if (v2 === 'rm') return cmdNoteRm(env, rest[0], flags);
      return usage(env, `note takes "add" or "rm"`);
    case 'board':
      if (v2 === 'post') return cmdBoardPost(env, rest.join(' '), flags);
      if (v2 === 'clear') return cmdBoardClear(env, flags);
      return usage(env, `board takes "post" or "clear"`);
    case 'approve': return cmdApprove(env, [v2, ...rest].filter(Boolean), flags);
    default: return usage(env, `unknown verb "${v1}"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
