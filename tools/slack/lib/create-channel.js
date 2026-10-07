/**
 * Create a Slack channel as the authenticated user.
 *
 * This is the tool's most strictly gated write path, and deliberately so: a
 * channel is an **irreversible, workspace-visible** mutation on a production
 * system shared with your whole company. Slack has no delete — the most you
 * can do is archive, and the name stays taken. A wrong channel is a permanent
 * artifact everyone in the workspace can see, so this verb follows
 * SENSIBILITIES #2's rule for irreversible shared-system mutations: gate on a
 * real TTY, with **no bypass flag at all**.
 *
 * That is stricter than `send`, which accepts `--yes` after the user has
 * approved a preview. There is no `--yes` here. An agent's path forward is
 * `--dry-run` to stage the exact command, then hand it to the user to run
 * themselves. That is an ergonomic escape hatch, not a bypass — the human
 * who owns the workspace is the one who types the channel name.
 *
 * The confirmation is name-echo, not a fixed word: the operator has to type
 * the channel name back. A muscle-memory "yes" can't create the wrong
 * channel, and the thing they type is the thing that becomes permanent.
 */

import { openSync, readSync, closeSync } from 'fs';
import { callSlackApi, callEdgeApi, getCurrentUser } from '../auth.js';
import { resolveUser } from './send.js';

/** Slack's hard ceiling on channel names. */
export const MAX_NAME_LENGTH = 80;

/**
 * Validate and normalize a requested channel name.
 *
 * Slack's rules: lowercase, no spaces or periods, max 80 characters,
 * and from the Latin set only letters/digits/hyphen/underscore. We
 * normalize case (Slack would anyway) but **refuse** anything else
 * rather than silently rewriting it — a channel whose name isn't the
 * name you asked for is exactly the permanent artifact this gate exists
 * to prevent. The caller sees the rejection and picks again.
 *
 * @returns {{ name: string, normalized: boolean, original: string }}
 */
export function validateChannelName(input) {
  const original = String(input ?? '').trim();
  if (!original) {
    throw new Error('Channel name is empty');
  }

  const name = original.toLowerCase();

  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Channel name is ${name.length} chars; Slack's limit is ${MAX_NAME_LENGTH}`
    );
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `"${original}" is not a valid Slack channel name — use lowercase letters, ` +
      'digits, hyphens and underscores only, starting with a letter or digit ' +
      '(no spaces, periods, or #)'
    );
  }

  return { name, normalized: name !== original, original };
}

/**
 * Look for an existing channel with this name, so the preview can warn
 * before the create is attempted.
 *
 * Uses the Edge `channels/search` service rather than `conversations.list`,
 * which may be admin-restricted on Enterprise Grid workspaces
 * (`enterprise_is_restricted`). That makes this check **advisory, not
 * authoritative**: Edge search is keyword-based and does not see every
 * private channel. A miss here does not prove the name is free; Slack's
 * own `name_taken` error on create is the real arbiter. Reported as such
 * in the preview so nobody reads a silent check as a guarantee.
 *
 * @returns {{ exact: object|null, similar: object[], checked: boolean }}
 */
export async function checkNameAvailability(name, cookies, token) {
  try {
    const r = await callEdgeApi('channels/search', { query: name, count: 20 }, cookies, token);
    const results = r.results || r.channels || [];
    const exact = results.find((c) => c.name === name) || null;
    const similar = results
      .filter((c) => c.name !== name)
      .slice(0, 5)
      .map((c) => ({
        name: c.name,
        id: c.id,
        is_private: !!c.is_private,
        is_archived: !!c.is_archived,
        num_members: c.member_count ?? c.num_members,
      }));
    return {
      exact: exact
        ? {
            name: exact.name,
            id: exact.id,
            is_private: !!exact.is_private,
            is_archived: !!exact.is_archived,
            num_members: exact.member_count ?? exact.num_members,
          }
        : null,
      similar,
      checked: true,
    };
  } catch {
    // Discovery is a nicety; never let it block the preview. The caller
    // renders checked:false so the human knows the check didn't run.
    return { exact: null, similar: [], checked: false };
  }
}

/**
 * Resolve the people to invite, BEFORE the channel exists.
 *
 * Ordering is the safety property: every invitee is verified through
 * `users.info` first, so the preview lists exactly who lands in the room
 * and a typo'd name fails while nothing has been created yet. Reuses
 * `resolveUser()` from the send path, so identity verification (real
 * name, bot, deactivated) is identical to a DM.
 */
export async function resolveInvitees(inputs, cookies, token) {
  const members = [];
  const seen = new Set();
  for (const input of inputs) {
    const { slackId, user } = await resolveUser(input, cookies, token);
    if (seen.has(slackId)) continue;
    seen.add(slackId);
    members.push({
      slackId,
      label: `@${user.profile?.display_name || user.real_name || slackId}`,
      realName: user.real_name,
      isBot: !!user.is_bot,
      deleted: !!user.deleted,
    });
  }
  return members;
}

/**
 * Ask a HUMAN to confirm by typing the channel name, reading /dev/tty.
 *
 * Returns true (confirmed), false (declined, mistyped, or timed out), or
 * null when there is no controlling terminal — i.e. an agent or pipeline
 * is driving, and must not create. Reading `/dev/tty` rather than stdin
 * is the whole point: stdin can be piped by whoever spawned us, the
 * controlling terminal cannot. There is no flag that skips this.
 */
export async function confirmCreateOnTty(name, isPrivate) {
  let fd;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return null;
  }
  // Read the answer with SYNCHRONOUS reads on the main thread — never a
  // stream. A stream (or readline) queues a blocking read(2) on the tty in
  // libuv's threadpool, that read cannot be cancelled by destroy(), and
  // node's exit sequence joins its threadpool workers — so the process
  // would hang after the work is done, waiting for a keypress that never
  // comes. readSync in the terminal's normal cooked mode returns once the
  // operator presses Enter; the terminal itself provides echo and line
  // editing. There is deliberately no timeout: this gate is interactive by
  // definition, and Ctrl-C aborts.
  process.stderr.write(
    `Create ${isPrivate ? 'PRIVATE' : 'public'} channel #${name}?\n` +
    '  This is irreversible: Slack has no channel delete, only archive, and the name stays taken forever.\n' +
    '  Typing the name (not "yes") is the check that you mean this exact channel.\n' +
    `  Type the channel name "${name}" to create it. Anything else (or Enter) aborts and nothing is created: `
  );
  const buf = Buffer.alloc(256);
  let line = '';
  try {
    while (true) {
      let n;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        if (e.code === 'EAGAIN') continue;
        throw e;
      }
      if (n <= 0) break;
      line += buf.toString('utf8', 0, n);
      if (line.includes('\n') || line.includes('\r')) break;
    }
  } finally {
    closeSync(fd);
  }
  const answer = line.split(/[\r\n]/)[0];
  return answer.trim().toLowerCase().replace(/^#/, '') === name;
}

/**
 * The workspace the channel will be created in.
 *
 * On Enterprise Grid the API host is org-level, and conversations.create
 * without a team_id fails as cannot_create_channel — the org can't tell
 * which workspace the channel belongs in (auth.test returns the E… org id,
 * not a workspace). The authenticated user's own membership is the answer:
 * users.info → enterprise_user.teams. One workspace means no ambiguity;
 * more than one needs an explicit --team; a non-Grid workspace has no
 * enterprise_user and needs no team_id at all.
 */
export async function resolveTeamId(cookies, token, explicit) {
  if (explicit) {
    if (!/^[TE][A-Z0-9]{6,}$/.test(explicit)) {
      throw new Error(`--team "${explicit}" is not a Slack team id (T…/E…)`);
    }
    return explicit;
  }
  const me = await getCurrentUser(cookies, token);
  const info = await callSlackApi('users.info', { user: me.slackId }, cookies, token);
  if (!info.ok) {
    throw new Error(`users.info failed while resolving the workspace: ${info.error}`);
  }
  const teams = info.user?.enterprise_user?.teams || [];
  if (teams.length === 1) return teams[0];
  if (teams.length === 0) return null;
  throw new Error(
    `You belong to ${teams.length} workspaces (${teams.join(', ')}) — pass --team <id> to pick one`
  );
}

/**
 * conversations.create as the authenticated user.
 *
 * `is_private: true` creates a private channel; `teamId` targets the Grid
 * workspace (see resolveTeamId). Everything after this call is decoration
 * on a channel that already exists, which is why the caller treats
 * purpose/topic/invite failures as partial success rather than rolling
 * anything back — there is nothing to roll back to.
 */
export async function createChannel(name, isPrivate, cookies, token, teamId) {
  const params = { name, is_private: isPrivate ? 'true' : 'false' };
  if (teamId) {
    params.team_id = teamId;
  }
  const response = await callSlackApi('conversations.create', params, cookies, token);
  if (!response.ok) {
    throw new Error(`conversations.create failed: ${response.error}`);
  }
  return response.channel;
}

/** conversations.setPurpose — best-effort decoration on a created channel. */
export async function setPurpose(channelId, purpose, cookies, token) {
  const r = await callSlackApi('conversations.setPurpose', { channel: channelId, purpose }, cookies, token);
  if (!r.ok) throw new Error(`conversations.setPurpose failed: ${r.error}`);
  return r;
}

/** conversations.setTopic — best-effort decoration on a created channel. */
export async function setTopic(channelId, topic, cookies, token) {
  const r = await callSlackApi('conversations.setTopic', { channel: channelId, topic }, cookies, token);
  if (!r.ok) throw new Error(`conversations.setTopic failed: ${r.error}`);
  return r;
}

/**
 * conversations.invite — add the pre-resolved members to a created channel.
 *
 * Slack takes a comma-joined user list and fails the whole batch on one
 * bad id, so the ids here must already be verified (see resolveInvitees).
 */
export async function inviteMembers(channelId, slackIds, cookies, token) {
  const r = await callSlackApi(
    'conversations.invite',
    { channel: channelId, users: slackIds.join(',') },
    cookies,
    token
  );
  if (!r.ok) throw new Error(`conversations.invite failed: ${r.error}`);
  return r;
}
