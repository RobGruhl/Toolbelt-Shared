/**
 * Edit one of your own already-posted Slack messages (chat.update).
 *
 * Where this sits in the write tiering (SENSIBILITIES #2): `send` adds a
 * message and is undoable by deleting it; `create-channel` is permanent and
 * takes a gate no agent can pass. `edit` is in between, and the reason is
 * specific: an edit *replaces* text. A send can only be too much; a bad edit
 * destroys what was there. Slack's own edit history is member-visible but
 * awkward to retrieve, so the prior wording is effectively gone from the
 * conversation the moment the call succeeds.
 *
 * So this verb takes the send-tier gate — preview, /dev/tty confirm by
 * default, `--yes` honored once the user has approved — plus three guards the
 * other write paths don't need, all aimed at the replace hazard:
 *
 *   1. It never edits blind. The current text is fetched and diffed first, so
 *      the preview shows what is being destroyed, not just what is arriving.
 *   2. It writes the original message to a local backup file BEFORE the update
 *      (SENSIBILITIES #7), so "what did that message say on Tuesday" stays
 *      answerable without Slack's edit history.
 *   3. It refuses by default when the message carries files, attachments, or
 *      non-text blocks, because chat.update with a `text` param regenerates
 *      the message body and would silently drop them. `--allow-lossy` proceeds,
 *      loudly — a naive-mistake guard, not a refusal.
 *
 * The safest mode is `--append` (and `--sub`, which must match exactly): they
 * derive the new text from the current text, so they cannot destroy a sentence
 * the caller never read. `--text` / `--file` replace wholesale, which is why
 * the diff preview exists. CLI-only; never exposed on the MCP surface.
 */

import { openSync, createReadStream, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { callSlackApi } from '../auth.js';

const CONFIRM_WORD = 'edit';
const CONFIRM_TIMEOUT_MS = 60_000;

/** Backup lands under the tool's gitignored data/ dir unless overridden. */
export const DEFAULT_BACKUP_DIR = new URL('../data/edit-backups/', import.meta.url).pathname;

/**
 * Fetch a single message by ts, so the caller can diff before replacing.
 *
 * conversations.history with oldest == latest == ts and inclusive finds
 * top-level messages. Thread replies are not in the channel history, so on a
 * miss we retry through conversations.replies — Slack accepts a reply's own ts
 * there and returns the whole thread, which we then filter by exact ts.
 *
 * Returns the raw API message object, or null when nothing matches.
 */
export async function fetchMessage(channelId, ts, cookies, token) {
  const history = await callSlackApi(
    'conversations.history',
    { channel: channelId, oldest: ts, latest: ts, inclusive: true, limit: 1 },
    cookies, token
  );
  if (history.ok) {
    const hit = (history.messages || []).find((m) => m.ts === ts);
    if (hit) return hit;
  } else if (history.error !== 'not_in_channel' && history.error !== 'channel_not_found') {
    throw new Error(`conversations.history failed: ${history.error}`);
  }

  const replies = await callSlackApi('conversations.replies', { channel: channelId, ts, limit: 200 }, cookies, token);
  if (!replies.ok) {
    if (replies.error === 'thread_not_found') return null;
    throw new Error(`conversations.replies failed: ${replies.error}`);
  }
  return (replies.messages || []).find((m) => m.ts === ts) || null;
}

/**
 * Would chat.update drop content we can't reconstruct from `text` alone?
 *
 * Slack regenerates the message body from the `text` param, so anything the
 * body carried beyond plain text is at risk. Auto-generated blocks (type
 * `rich_text`, what a text-only postMessage produces) round-trip fine; custom
 * blocks, attachments, and shared files do not.
 *
 * Returns an array of human-readable reasons — empty means safe.
 */
export function lossyReasons(message) {
  const reasons = [];
  if (message.files?.length) {
    reasons.push(`${message.files.length} attached file(s) — chat.update would unshare them`);
  }
  if (message.attachments?.length) {
    reasons.push(`${message.attachments.length} attachment(s) (link unfurls or app attachments) would be dropped`);
  }
  const exotic = (message.blocks || []).map((b) => b.type).filter((t) => t !== 'rich_text');
  if (exotic.length) {
    reasons.push(`non-text block(s) (${[...new Set(exotic)].join(', ')}) would be replaced by plain text`);
  }
  return reasons;
}

/**
 * Derive the new message text from the current text and exactly one mode.
 *
 * `append` and `sub` are text-derived, so they cannot clobber wording the
 * caller never saw; `text`/`file` replace outright. `sub` insists on a unique
 * match unless `all` is set — a substitution that silently hit the wrong one
 * of three occurrences is the failure this prevents.
 *
 * @returns {{ text: string, mode: string, describe: string }}
 */
export function computeNewText(current, mode) {
  const { replace, append, sub, with: withText, all } = mode;

  if (replace !== undefined) {
    return { text: replace, mode: 'replace', describe: 'replace the whole message' };
  }

  if (append !== undefined) {
    if (!append.trim()) throw new Error('nothing to append');
    return {
      text: `${current}\n${append}`,
      mode: 'append',
      describe: `append ${append.split('\n').length} line(s)`,
    };
  }

  if (sub !== undefined) {
    if (!sub) throw new Error('--sub needs a non-empty string to find');
    if (withText === undefined) throw new Error('--sub requires --with (use --with "" to delete the match)');
    const count = current.split(sub).length - 1;
    if (count === 0) {
      throw new Error(`--sub string not found in the message: ${JSON.stringify(sub)}`);
    }
    if (count > 1 && !all) {
      throw new Error(`--sub string appears ${count} times — narrow it, or pass --all to replace every occurrence`);
    }
    return {
      text: all ? current.split(sub).join(withText) : current.replace(sub, withText),
      mode: 'substitute',
      describe: `substitute ${count} occurrence(s) of ${JSON.stringify(sub.slice(0, 60))}`,
    };
  }

  throw new Error('no edit mode given');
}

/**
 * Compact line-level diff for the preview.
 *
 * Long runs of untouched lines collapse to a "… N unchanged lines …" marker so
 * a 40-line message doesn't bury the two lines that actually changed. This is
 * a display aid, not a merge algorithm: it walks a common prefix and suffix and
 * treats the middle as removed-then-added, which is exactly right for the
 * append and substitute cases and honest enough for a wholesale replace.
 */
export function renderDiff(before, after, context = 2) {
  const a = before.split('\n');
  const b = after.split('\n');

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const out = [];
  const emitContext = (lines, from, to) => {
    const slice = lines.slice(from, to);
    if (slice.length <= context * 2 + 1) {
      slice.forEach((l) => out.push(`  ${l}`));
      return;
    }
    slice.slice(0, context).forEach((l) => out.push(`  ${l}`));
    out.push(`  … ${slice.length - context * 2} unchanged lines …`);
    slice.slice(-context).forEach((l) => out.push(`  ${l}`));
  };

  emitContext(a, 0, head);
  a.slice(head, a.length - tail).forEach((l) => out.push(`- ${l}`));
  b.slice(head, b.length - tail).forEach((l) => out.push(`+ ${l}`));
  emitContext(a, a.length - tail, a.length);

  return out.join('\n');
}

/**
 * Ask a HUMAN to confirm, reading from /dev/tty. Same contract as send's
 * confirmOnTty: true confirmed, false declined/timeout, null when no TTY
 * exists (an agent is driving — it must get user approval and re-run --yes).
 */
export async function confirmEditOnTty(summary) {
  let fd;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return null;
  }
  const input = createReadStream(null, { fd });
  const rl = createInterface({ input, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        process.stderr.write('\n[edit] Timed out waiting for confirmation.\n');
        resolve('');
      }, CONFIRM_TIMEOUT_MS);
      rl.question(
        `${summary}?\n` +
        '  chat.update replaces the text shown in the diff immediately; Slack marks the message "edited" permanently and the old wording leaves the conversation (a local backup is written first unless --no-backup).\n' +
        `  Type "${CONFIRM_WORD}" to apply. Anything else (or Enter) aborts and the message stays as it is: `,
        (a) => { clearTimeout(timer); resolve(a); }
      );
    });
    return answer.trim().toLowerCase() === CONFIRM_WORD;
  } finally {
    rl.close();
    input.destroy();
  }
}

/**
 * Write the pre-edit message to disk so the old wording survives the update.
 *
 * One file per message, holding an append-only `revisions[]` chain — editing the
 * same message three times must leave all three prior texts recoverable, which
 * an overwriting backup would not. A malformed or unreadable existing file is
 * preserved under `priorFileUnparsed` rather than discarded, since the whole
 * point is not losing text.
 *
 * Best-effort by design: a backup that cannot be written is worth a loud
 * warning, but making it fatal would push the operator toward editing in the
 * Slack UI with no trace at all. Returns the path, or null on failure.
 */
export function backupMessage(dir, channelId, message, newText) {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${channelId}-${message.ts}.json`);

    let existing = null;
    let unparsed = null;
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      try {
        existing = JSON.parse(raw);
      } catch {
        unparsed = raw;
      }
    }

    const revisions = Array.isArray(existing?.revisions) ? existing.revisions : [];
    revisions.push({
      backedUpAt: new Date().toISOString(),
      textBefore: message.text,
      textAfter: newText,
      slackEditedBefore: message.edited || null,
    });

    writeFileSync(path, `${JSON.stringify({
      channel: channelId,
      ts: message.ts,
      user: message.user,
      revisions,
      ...(unparsed ? { priorFileUnparsed: unparsed } : {}),
    }, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/** chat.update as the authenticated user. */
export async function updateMessage(channelId, ts, text, cookies, token) {
  const response = await callSlackApi('chat.update', { channel: channelId, ts, text }, cookies, token);
  if (!response.ok) {
    if (response.error === 'cant_update_message') {
      throw new Error('cant_update_message — Slack will only let you edit your own messages, '
        + 'and workspace policy can also close the edit window on older ones');
    }
    throw new Error(`chat.update failed: ${response.error}`);
  }
  return response;
}
