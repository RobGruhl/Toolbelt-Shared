// gate.mjs — the human gate in front of `send`, and the staging queue behind `toolbelt approve`.
//
// Why /dev/tty and not stdin: whoever spawned this process owns its stdin and can pipe any
// answer into it — an agent, a cron job, a one-liner. The controlling terminal is the one thing
// a subprocess cannot forge: either a human is sitting at it or it does not open. A failure to
// open it is therefore a reliable "no human here", and it turns into staging, never a default
// yes. The staging contract matches tools/example-write (see the block comment below).
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  unlinkSync, writeFileSync, constants as FS } from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';

export const PENDING_TTL_S = 15 * 60;
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;

/**
 * `has()` answers "could a human be asked right now"; `readLine()` puts a prompt on stderr and
 * returns one line typed at the controlling terminal, or null when there is none. Reads are
 * synchronous: a stream on /dev/tty parks a blocking read that node would join at exit.
 */
export function ttyDevice() {
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

/** The confirmation word, exactly: "send". "y", "yes", "Send" and Enter all decline. */
export function typedEchoMatches(answer, expected) {
  if (answer === null || answer === undefined) return false;
  return answer.replace(/\r?\n$/, '') === expected;
}

/*
 * Staging contract, shared with `toolbelt approve imessage <code>`:
 *   directory   $IMSG_HOME/pending/  (default ~/.local/share/imessage/pending/), mode 700
 *   file        <code>.json, mode 600, created O_EXCL — never overwritten
 *   code        6 chars of [a-z0-9], randomInt
 *   record      { code, tool, verb, args{}, summary, created, expires, expires_epoch }
 *   expiry      15 minutes; pruned on every touch; an expired record is never executed
 *   single use  the record is deleted after approve runs, whether the send succeeded or not
 *   never       a credential (this tool has none)
 * The record holds the recipient and the message text: the payload a human must see before it
 * goes out. It lives only on the operator's machine, 600, for at most 15 minutes.
 */

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function newCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function pruneExpired(pendingDir, now) {
  if (!existsSync(pendingDir)) return 0;
  let n = 0;
  for (const f of readdirSync(pendingDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(pendingDir, f);
    let expired;
    try { expired = now >= Number(JSON.parse(readFileSync(p, 'utf8')).expires_epoch) * 1000; } catch { expired = true; }
    if (expired) { unlinkSync(p); n++; }
  }
  return n;
}

export function stageWrite(pendingDir, now, { tool, verb, args, summary }) {
  mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  chmodSync(pendingDir, 0o700);
  pruneExpired(pendingDir, now);
  const record = { code: newCode(), tool, verb, args: { ...args }, summary, created: iso(now), expires: iso(now + PENDING_TTL_S * 1000), expires_epoch: Math.floor((now + PENDING_TTL_S * 1000) / 1000) };
  for (;;) {
    try {
      const fd = openSync(path.join(pendingDir, `${record.code}.json`), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
      writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
      closeSync(fd);
      return record;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      record.code = newCode();
    }
  }
}

export function loadPending(pendingDir, now, code) {
  pruneExpired(pendingDir, now);
  if (!/^[a-z0-9]{6}$/.test(code ?? '')) return null;
  const p = path.join(pendingDir, `${code}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function listPending(pendingDir, now) {
  pruneExpired(pendingDir, now);
  if (!existsSync(pendingDir)) return [];
  return readdirSync(pendingDir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { return JSON.parse(readFileSync(path.join(pendingDir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

export function discardPending(pendingDir, code) {
  if (!/^[a-z0-9]{6}$/.test(code ?? '')) return false;
  const p = path.join(pendingDir, `${code}.json`);
  if (existsSync(p)) { unlinkSync(p); return true; }
  return false;
}
