/**
 * Add or remove an emoji reaction on a message, as the authenticated user.
 *
 * The lightest write path in this tool: a reaction is reversible in one
 * call (reactions.remove), touches a single message, and notifies nobody
 * but the message author. Per SENSIBILITIES #2 that puts it at the send
 * tier, not the create-channel tier — preview first, TTY confirm by
 * default, --yes honored once the user has approved. Never exposed on
 * the MCP surface.
 */

import { openSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { callSlackApi } from '../auth.js';

const CONFIRM_WORD = 'react';
const CONFIRM_TIMEOUT_MS = 60_000;

/**
 * Ask a HUMAN to confirm, reading from /dev/tty. Same contract as
 * send's confirmOnTty: true confirmed, false declined/timeout, null
 * when no TTY exists (an agent is driving — it must get user approval
 * and re-run with --yes).
 */
export async function confirmReactOnTty(summary) {
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
        process.stderr.write('\n[react] Timed out waiting for confirmation.\n');
        resolve('');
      }, CONFIRM_TIMEOUT_MS);
      rl.question(
        `${summary}, as you?\n` +
        '  The reaction appears immediately and the message author can see it; it is reversible with --remove.\n' +
        `  Type "${CONFIRM_WORD}" to proceed. Anything else (or Enter) aborts and nothing changes: `,
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
 * reactions.add / reactions.remove as the authenticated user.
 * already_reacted and no_reaction come back as ok with alreadyThere set
 * — the desired end state holds, which is what an idempotent caller
 * (a re-run harvest pass) needs to treat as success.
 */
export async function setReaction(channelId, ts, name, remove, cookies, token) {
  const method = remove ? 'reactions.remove' : 'reactions.add';
  const response = await callSlackApi(method, { channel: channelId, timestamp: ts, name }, cookies, token);
  if (!response.ok) {
    if (response.error === 'already_reacted' || response.error === 'no_reaction') {
      return { ok: true, alreadyThere: true };
    }
    throw new Error(`${method} failed: ${response.error}`);
  }
  return { ok: true, alreadyThere: false };
}
