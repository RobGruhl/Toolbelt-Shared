/**
 * Send a Slack message as the authenticated user.
 *
 * This is the tool's primary message write path (see lib/create-channel.js
 * for the stricter, un-bypassable channel-create gate), and the contract is
 * check before sending: by default the confirmation prompt reads from
 * /dev/tty — not stdin — so a person at a real terminal types the word
 * "send" before anything is posted. Agents and scripts can skip the prompt
 * with --yes, but only after showing the user the --dry-run preview and
 * getting their explicit approval. The MCP server does not expose this
 * capability.
 *
 * conversations.open + chat.postMessage run over the same xoxc/cookie auth
 * the read paths use, and post as the authenticated user.
 */

import { openSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { callSlackApi, resolveUsername, resolveChannel } from '../auth.js';

const CONFIRM_WORD = 'send';
const CONFIRM_TIMEOUT_MS = 60_000;

/**
 * Resolve a recipient string to a conversation we can post to.
 *
 * Accepts, in order of precedence:
 *   - conversation IDs: C…/G… (channel), D… (existing DM)
 *   - "#channel-name"
 *   - user forms: U…/W… ID, "@display-name", or a bare name
 *
 * For users, the resolved ID is verified via users.info BEFORE
 * conversations.open, so the preview can show who this really is
 * (real name, bot or not, deactivated or not) straight from the API.
 */
export async function resolveRecipient(input, cookies, token) {
  const trimmed = input.trim();

  if (/^[CG][A-Z0-9]{6,}$/.test(trimmed) || trimmed.startsWith('#')) {
    const { channelId, channelName } = await resolveChannel(trimmed, cookies, token);
    return {
      kind: 'channel',
      channelId,
      label: channelName ? `#${channelName}` : channelId,
    };
  }

  if (/^D[A-Z0-9]{6,}$/.test(trimmed)) {
    // An existing DM conversation — we can't cheaply say who's in it,
    // so the preview labels it as an opaque DM id. Prefer a user form
    // when you want the bot/identity verification.
    return { kind: 'dm-id', channelId: trimmed, label: `DM ${trimmed}` };
  }

  const { slackId, user } = await resolveUser(trimmed, cookies, token);

  const open = await callSlackApi('conversations.open', { users: slackId }, cookies, token);
  if (!open.ok) {
    throw new Error(`conversations.open failed: ${open.error}`);
  }

  return {
    kind: 'dm',
    channelId: open.channel.id,
    slackId,
    label: `@${user.profile?.display_name || user.real_name || slackId}`,
    realName: user.real_name,
    isBot: !!user.is_bot,
    deleted: !!user.deleted,
  };
}

/**
 * Resolve a single user-form input to { slackId, user } via users.info.
 *
 * Accepts a U…/W… id, "@display-name", or a bare name. Rejects channel
 * and DM-id forms — those aren't people, and a group DM is people only.
 * Used by both the 1:1 DM path and the group-DM path so identity
 * verification (real name, bot, deactivated) is identical either way.
 */
export async function resolveUser(input, cookies, token) {
  const trimmed = input.trim();

  if (/^[CG][A-Z0-9]{6,}$/.test(trimmed) || trimmed.startsWith('#') || /^D[A-Z0-9]{6,}$/.test(trimmed)) {
    throw new Error(`"${trimmed}" is a channel/DM, not a person — a group DM takes people only`);
  }

  let slackId;
  if (/^[UW][A-Z0-9]{6,}$/.test(trimmed)) {
    slackId = trimmed;
  } else {
    const resolved = await resolveUsername(trimmed.replace(/^@/, ''), cookies, token);
    if (resolved.error) {
      const err = new Error(resolved.error);
      err.suggestions = resolved.suggestions;
      throw err;
    }
    slackId = resolved.slackId;
  }

  const info = await callSlackApi('users.info', { user: slackId }, cookies, token);
  if (!info.ok) {
    throw new Error(`users.info failed for ${slackId}: ${info.error}`);
  }
  return { slackId, user: info.user };
}

/**
 * Resolve 2+ user-form inputs into a multi-person group DM (mpim).
 *
 * conversations.open with a comma-joined `users` list returns a G… group
 * conversation; posting to it is identical to a 1:1 DM (same chat.postMessage
 * path). Every member is verified via users.info FIRST so the preview can
 * show exactly who lands in the room — and so a typo'd name fails loudly
 * before the conversation is opened. Slack opening the same set of people
 * returns the same G… id, so re-running reuses the existing group rather
 * than spawning duplicates.
 */
export async function resolveGroupRecipients(inputs, cookies, token) {
  const members = [];
  for (const input of inputs) {
    const { slackId, user } = await resolveUser(input, cookies, token);
    members.push({
      slackId,
      label: `@${user.profile?.display_name || user.real_name || slackId}`,
      realName: user.real_name,
      isBot: !!user.is_bot,
      deleted: !!user.deleted,
    });
  }

  const ids = members.map((m) => m.slackId);
  const open = await callSlackApi('conversations.open', { users: ids.join(',') }, cookies, token);
  if (!open.ok) {
    throw new Error(`conversations.open (group) failed: ${open.error}`);
  }

  return {
    kind: 'group',
    channelId: open.channel.id,
    members,
    label: members.map((m) => m.label).join(', '),
  };
}

/**
 * Ask a HUMAN to confirm, reading from /dev/tty.
 *
 * Returns true (confirmed), false (declined/timeout), or null when no
 * TTY exists — i.e. an agent or pipeline is driving. A caller with no
 * TTY must not send; it should check with the user and re-run with
 * --yes, or hand them the command. Reading /dev/tty rather than stdin
 * is the point: stdin can be piped by whoever spawned us; the
 * controlling terminal cannot.
 */
export async function confirmOnTty(targetLabel) {
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
        process.stderr.write('\n[send] Timed out waiting for confirmation.\n');
        resolve('');
      }, CONFIRM_TIMEOUT_MS);
      rl.question(
        `Post this message to ${targetLabel}, as you?\n` +
        '  It is delivered immediately and the recipient is notified; you can delete it in Slack afterwards, but not un-notify.\n' +
        `  Type "${CONFIRM_WORD}" to deliver. Anything else (or Enter) aborts and nothing is posted: `,
        (a) => { clearTimeout(timer); resolve(a); }
      );
    });
    return answer.trim().toLowerCase() === CONFIRM_WORD;
  } finally {
    rl.close();
    input.destroy();
  }
}

/** chat.postMessage as the authenticated user. */
export async function postMessage(channelId, text, threadTs, cookies, token) {
  const params = { channel: channelId, text };
  if (threadTs) params.thread_ts = threadTs;
  const response = await callSlackApi('chat.postMessage', params, cookies, token);
  if (!response.ok) {
    throw new Error(`chat.postMessage failed: ${response.error}`);
  }
  return response;
}
