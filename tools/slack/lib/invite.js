/**
 * Add people to an EXISTING channel, as the authenticated user.
 *
 * `create-channel` could already invite, but only as post-create decoration
 * behind its own un-bypassable gate — no verb reached an existing channel.
 * This is that verb.
 *
 * Gate tier: send, not create-channel. An invite is not irreversible the way
 * a channel name is (Slack has `conversations.kick`, even though this tool
 * deliberately exposes no verb for it), and the operation an agent needs to
 * finish — "add this new collaborator to the users channel" — is exactly the
 * approved-preview-then-deliver shape `--yes` exists for. Per SENSIBILITIES
 * #2 the gate matches the blast radius: preview, TTY confirm by default,
 * `--yes` honored once the user has approved. Never on the MCP surface.
 *
 * The blast radius an invite has and a `send` does not is **disclosure**:
 * joining a private channel hands the invitee its entire history, and no
 * later removal un-reads it. So two guards specific to that:
 *
 *   1. The preview states the channel's privacy and, when private, says
 *      plainly that the full history is exposed. When the metadata read
 *      fails, privacy renders as UNKNOWN and is treated as private —
 *      silence must not read as "public".
 *   2. Every invitee is resolved through users.info FIRST and previewed with
 *      their **email**, because `resolveUsername()` returns a single match
 *      for an ambiguous name with no ambiguity error. A clean resolve is not
 *      proof you got the right person; the email is what the human checks.
 *
 * The preview does not say who is already in the room: on Enterprise Grid
 * workspaces `conversations.members` may be admin-restricted
 * (`enterprise_is_restricted`, the same control that can block
 * `conversations.list`), so no membership pre-check is attempted anywhere.
 * The idempotence below is therefore not a nicety — treating
 * `already_in_channel` as success is what makes a re-run safe.
 */

import { openSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { callSlackApi } from '../auth.js';
import { resolveUser } from './send.js';

const CONFIRM_WORD = 'invite';
const CONFIRM_TIMEOUT_MS = 60_000;

/**
 * Reject targets that cannot take an invite, before any network call.
 *
 * A DM/group-DM (`D…`) has a fixed roster — Slack has no "add someone to
 * this DM"; the equivalent is opening a new mpim, which is `send`'s job with
 * 2+ recipients. A user form (`U…`/`@name`) is a person, not a room. Both
 * fail here rather than as an opaque `channel_not_found` later.
 */
export function validateInviteTarget(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('No channel given');
  if (/^D[A-Z0-9]{6,}$/.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is a DM — its roster is fixed. Slack cannot add someone to an existing DM; ` +
      'open a new group DM instead (`send <person> <person> …`).'
    );
  }
  if (/^[UW][A-Z0-9]{6,}$/.test(trimmed) || trimmed.startsWith('@')) {
    throw new Error(`"${trimmed}" is a person, not a channel — give the channel first, then the people`);
  }
  return trimmed;
}

/**
 * Read the channel's privacy/archive/member-count for the preview.
 *
 * Best-effort, but privacy is NOT allowed to fail open: a failed read
 * returns isPrivate:true with checked:false so the caller renders UNKNOWN
 * and still shows the history-disclosure warning. The conservative default
 * is the whole point — an unreadable channel is the case where you least
 * want a confident "public".
 *
 * `api` is injectable so the fail-closed guarantee can be tested without a
 * network call; production always uses the real callSlackApi.
 */
export async function describeChannel(channelId, cookies, token, api = callSlackApi) {
  try {
    const info = await api('conversations.info', { channel: channelId }, cookies, token);
    if (!info.ok) throw new Error(info.error);
    const c = info.channel || {};
    return {
      checked: true,
      name: c.name || null,
      isPrivate: !!c.is_private,
      isArchived: !!c.is_archived,
      numMembers: c.num_members ?? null,
      isChannel: !!(c.is_channel || c.is_group),
    };
  } catch {
    return { checked: false, name: null, isPrivate: true, isArchived: false, numMembers: null, isChannel: true };
  }
}

/**
 * Resolve the people to add, verifying each through users.info first.
 *
 * Deduped by Slack id, so naming someone twice (or by both `@handle` and
 * `U…` id) is one invite. Carries `email` because that is the only field
 * that distinguishes same-named coworkers; `title` is a second cheap signal.
 * A typo'd name throws here, before anyone is added to anything.
 */
export async function resolveInviteTargets(inputs, cookies, token) {
  const members = [];
  const seen = new Set();
  for (const input of inputs) {
    const { slackId, user } = await resolveUser(input, cookies, token);
    if (seen.has(slackId)) continue;
    seen.add(slackId);
    members.push({
      slackId,
      input,
      label: `@${user.profile?.display_name || user.real_name || slackId}`,
      realName: user.real_name || null,
      email: user.profile?.email || null,
      title: user.profile?.title || null,
      isBot: !!user.is_bot,
      deleted: !!user.deleted,
    });
  }
  if (!members.length) throw new Error('No people to invite');
  return members;
}

/**
 * Ask a HUMAN to confirm, reading /dev/tty. Same contract as send's
 * confirmOnTty: true confirmed, false declined/timeout, null when there is
 * no TTY (an agent is driving — it must get user approval and re-run with
 * --yes). /dev/tty rather than stdin because stdin can be piped by whoever
 * spawned us; the controlling terminal cannot.
 */
export async function confirmInviteOnTty(summary) {
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
        process.stderr.write('\n[invite] Timed out waiting for confirmation.\n');
        resolve('');
      }, CONFIRM_TIMEOUT_MS);
      rl.question(
        `${summary}\n` +
        '  Each person is added immediately and can read the channel; in a private channel that includes its entire history, and removing them later does not un-read it.\n' +
        `  Type "${CONFIRM_WORD}" to add them. Anything else (or Enter) aborts and nobody is added: `,
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
 * Recover Slack's error code from a thrown callSlackApi error.
 *
 * `callSlackApi` NEVER returns `{ok:false}` — auth.js raises
 * `new Error("<api> error: <code>")` on any `ok:false` payload. So the code
 * has to come back out of the message, or every per-user outcome collapses
 * into one opaque failure string and `already_in_channel` reads as an error
 * rather than as the desired end state.
 */
export function slackErrorCode(err) {
  const m = /error:\s*([a-z0-9_]+)\s*$/i.exec(err?.message || '');
  return m ? m[1] : (err?.message || 'unknown_error');
}

/**
 * conversations.invite, ONE PERSON PER CALL.
 *
 * Batching the whole roster into a single comma-joined `users` call makes
 * one bad member (already in, deactivated, wrong workspace) ambiguous for
 * the whole set. Per-user calls buy per-user truth: each result carries its
 * own ok/error, and the caller reports partial success instead of a rollback
 * it cannot perform — nobody is un-invited because member 4 failed.
 *
 * `already_in_channel` is success with alreadyThere set: the desired end
 * state holds, which is what a re-run needs to treat as fine — and where
 * `conversations.members` is restricted, a re-run is the only way to
 * discover that state at all.
 *
 * Cost note: auth.js retries every non-auth error 3× with 1s/2s backoff, so
 * a deterministic outcome like `already_in_channel` or `cant_invite` costs
 * three calls and a few seconds before it lands here. That is upstream
 * behavior shared by every caller, not something to special-case per verb.
 */
export async function inviteToChannel(channelId, members, cookies, token) {
  const results = [];
  for (const member of members) {
    try {
      const r = await callSlackApi(
        'conversations.invite',
        { channel: channelId, users: member.slackId },
        cookies,
        token
      );
      // Defensive: auth.js throws rather than returning ok:false today, but a
      // caller-visible shape change shouldn't silently become "added".
      if (r?.ok === false) {
        const code = r.error || 'unknown_error';
        results.push(code === 'already_in_channel'
          ? { ...member, ok: true, alreadyThere: true }
          : { ...member, ok: false, error: code });
      } else {
        results.push({ ...member, ok: true, alreadyThere: false });
      }
    } catch (e) {
      const code = slackErrorCode(e);
      results.push(code === 'already_in_channel'
        ? { ...member, ok: true, alreadyThere: true }
        : { ...member, ok: false, error: code });
    }
  }
  return results;
}

/**
 * Human-readable hints for the invite errors Slack returns in practice, so a
 * failed member says what to do rather than echoing a Slack error code.
 */
export function explainInviteError(code) {
  const hints = {
    not_in_channel: 'you are not in that channel — you can only invite to channels you belong to',
    channel_not_found: 'channel not visible to you (private channels usually need the C… id, not the #name)',
    is_archived: 'the channel is archived — unarchive it in Slack first',
    cant_invite_self: 'that is you; you are already in the channel',
    cant_invite: 'Slack refused this invite (often a guest/single-channel account, or a workspace mismatch)',
    user_is_ultra_restricted: 'single-channel guest — an admin has to move them',
    user_not_in_team: 'not a member of this channel\'s workspace',
    ura_max_channels: 'that account is at its channel limit',
    not_authorized: 'your account lacks permission to invite to this channel',
    invite_limit_reached: 'the channel hit its invite limit',
  };
  return hints[code] || null;
}
