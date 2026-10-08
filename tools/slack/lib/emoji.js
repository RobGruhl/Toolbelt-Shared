/**
 * Add a custom emoji to the workspace, as the authenticated user.
 *
 * An emoji is visible to everyone in the workspace and claims its name, but
 * the uploader (or an admin) can remove it in Customize Workspace → Emoji, so
 * per SENSIBILITIES #2 it takes the send tier: preview, TTY confirm, --yes
 * honored once the user has approved. There is no remove verb: messages that
 * already use the emoji would render as bare :name: text, so that undo stays
 * a human click. Never exposed on the MCP surface.
 *
 * emoji.add is the method the Slack web client's "Add emoji" dialog calls; it
 * takes the image inline as multipart (mode=data). A workspace that limits
 * custom emoji to admins refuses it, and no flag here changes that.
 */

import { openSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { callSlackApi, callSlackApiMultipart } from '../auth.js';

const CONFIRM_WORD = 'emoji';
const CONFIRM_TIMEOUT_MS = 60_000;

/** Slack refuses larger uploads (error_too_big). */
export const MAX_EMOJI_BYTES = 128 * 1024;
/** Slack displays custom emoji at up to 128 px; larger images are scaled down. */
export const RECOMMENDED_EDGE = 128;

const NAME_RE = /^[a-z0-9_-]{1,100}$/;

/**
 * Normalize and validate an emoji name: colons stripped, lowercased.
 * Returns { name } or { error }.
 */
export function validateEmojiName(input) {
  const name = String(input || '').replace(/^:+|:+$/g, '').trim().toLowerCase();
  if (!name) return { error: 'empty emoji name' };
  if (!NAME_RE.test(name)) {
    return { error: `"${name}" is not a valid emoji name: lowercase letters, digits, "_" and "-" only, at most 100 characters` };
  }
  return { name };
}

function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const len = bytes.readUInt16BE(i + 2);
    // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Inspect image bytes without decoding them: format from the magic number,
 * dimensions from the header. Returns { format, type, width, height,
 * bytes, errors[], warnings[] }; any error means Slack would refuse it.
 */
export function inspectEmojiImage(bytes) {
  const info = { format: null, type: null, width: null, height: null, bytes: bytes.length, errors: [], warnings: [] };
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    Object.assign(info, { format: 'png', type: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  } else if (bytes.length >= 10 && bytes.toString('ascii', 0, 4) === 'GIF8') {
    Object.assign(info, { format: 'gif', type: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) });
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    Object.assign(info, { format: 'jpeg', type: 'image/jpeg', ...(jpegSize(bytes) || {}) });
  } else {
    info.errors.push('not a PNG, GIF or JPEG');
    return info;
  }
  if (bytes.length > MAX_EMOJI_BYTES) {
    info.errors.push(`${(bytes.length / 1024).toFixed(1)} KB is over Slack's 128 KB emoji limit`);
  }
  if (info.width && info.height) {
    if (info.width !== info.height) info.warnings.push(`not square (${info.width}x${info.height}); Slack letterboxes it`);
    if (Math.max(info.width, info.height) > RECOMMENDED_EDGE) {
      info.warnings.push(`larger than ${RECOMMENDED_EDGE} px; Slack scales it down, so fine detail is lost`);
    }
  }
  if (info.format === 'jpeg') info.warnings.push('JPEG has no transparency; the background shows as a square');
  return info;
}

/**
 * emoji.list as a read: is the name already taken (custom or alias)?
 * Returns { taken: bool, value } or { taken: null, error } when the list
 * is unreadable — the check is advisory, Slack's error_name_taken decides.
 */
export async function lookupEmojiName(name, cookies, token) {
  try {
    const res = await callSlackApi('emoji.list', {}, cookies, token);
    const value = res.emoji?.[name];
    return { taken: value !== undefined, value: value ?? null };
  } catch (err) {
    return { taken: null, error: err.message };
  }
}

/**
 * Ask a HUMAN to confirm, reading from /dev/tty. Same contract as send's
 * confirmOnTty: true confirmed, false declined/timeout, null when no TTY
 * exists (an agent is driving — it must get user approval and re-run with
 * --yes).
 */
export async function confirmEmojiOnTty(summary) {
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
        process.stderr.write('\n[add-emoji] Timed out waiting for confirmation.\n');
        resolve('');
      }, CONFIRM_TIMEOUT_MS);
      rl.question(
        `${summary}, as you?\n` +
        '  Everyone in the workspace can use it immediately; you or an admin can remove it in Customize Workspace → Emoji.\n' +
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

/** emoji.add (mode=data) as the authenticated user. Throws on any Slack error. */
export async function addEmoji(name, bytes, info, cookies, token) {
  return callSlackApiMultipart(
    'emoji.add',
    { name, mode: 'data' },
    { field: 'image', bytes, filename: `${name}.${info.format === 'jpeg' ? 'jpg' : info.format}`, type: info.type },
    cookies,
    token
  );
}
