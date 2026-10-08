#!/usr/bin/env node
// One-off image/file uploader that reuses the slack tool's existing xoxc+cookie auth
// (same trust boundary as `cli.js send`). Honors the dry-run-before-send contract:
// resolves the recipient and previews; only delivers with --yes.
//
//   node upload-file.mjs <@person|#channel|C…/U… id> --file <path> [--comment "..."] [--thread-ts <ts>] [--dry-run|--yes]
//
// --thread-ts <ts>  attach the file as a reply UNDER an existing message instead of a new
//                   top-level post. Pass the parent message's ts (the value cli.js `send`
//                   prints after posting). Without it, a file uploaded to a DM lands as its
//                   own message, NOT threaded under a guide you just posted.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { getAuthCookies, callSlackApi, formatCookiesForHeader } from './auth.js';
import { resolveRecipient } from './lib/send.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const recipient = process.argv[2];
const filePath = arg('--file');
const comment = arg('--comment') || '';
const threadTs = arg('--thread-ts');
const dryRun = process.argv.includes('--dry-run');
const yes = process.argv.includes('--yes');

if (!recipient || !filePath) {
  console.error('Usage: node upload-file.mjs <recipient> --file <path> [--comment "..."] [--thread-ts <ts>] [--dry-run|--yes]');
  process.exit(2);
}

const bytes = readFileSync(filePath);
const length = statSync(filePath).size;
const filename = basename(filePath);

const { cookies, token } = await getAuthCookies();
const resolved = await resolveRecipient(recipient, cookies, token);
if (resolved.error) {
  console.error(`[upload] could not resolve recipient: ${resolved.error}`);
  process.exit(1);
}
const channelId = resolved.channelId;
const label = resolved.label || resolved.channelName || channelId;

console.error('\n── upload preview ─────────────────────────────────');
console.error(`To:       ${recipient} (${label})`);
console.error(`Conv:     ${channelId}`);
console.error(`File:     ${filePath}`);
console.error(`Filename: ${filename}`);
console.error(`Size:     ${(length / 1024).toFixed(0)} KB`);
console.error(`Comment:  ${comment || '(none)'}`);
console.error(`Thread:   ${threadTs ? `reply under ${threadTs}` : '(top-level post)'}`);
console.error('───────────────────────────────────────────────────');

if (dryRun || !yes) {
  console.error('[upload] Dry run — nothing sent. Re-run with --yes once approved.');
  process.exit(0);
}

// Slack external-upload flow: getUploadURLExternal → PUT bytes → completeUploadExternal
const urlResp = await callSlackApi('files.getUploadURLExternal', { filename, length }, cookies, token);
if (!urlResp.ok) {
  console.error(`[upload] getUploadURLExternal failed: ${urlResp.error}`);
  process.exit(1);
}
const { upload_url, file_id } = urlResp;

// A stalled upload connection otherwise waits forever. Nothing is posted until
// completeUploadExternal, so aborting here leaves no partial message.
const UPLOAD_TIMEOUT_MS = 120_000;
let put;
try {
  put = await fetch(upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Cookie: formatCookiesForHeader(cookies) },
    body: bytes,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
} catch (err) {
  const why = err.name === 'TimeoutError' ? `no response in ${UPLOAD_TIMEOUT_MS / 1000}s` : err.message;
  console.error(`[upload] file POST failed: ${why} — nothing was posted; retry, or shrink the file`);
  process.exit(1);
}
if (!put.ok) {
  console.error(`[upload] file POST failed: HTTP ${put.status}`);
  process.exit(1);
}

const complete = await callSlackApi(
  'files.completeUploadExternal',
  {
    files: JSON.stringify([{ id: file_id, title: filename }]),
    channel_id: channelId,
    ...(comment ? { initial_comment: comment } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  },
  cookies,
  token,
);
if (!complete.ok) {
  console.error(`[upload] completeUploadExternal failed: ${complete.error}`);
  process.exit(1);
}

const f = complete.files?.[0] || {};
console.error(JSON.stringify({ ok: true, file_id: f.id, name: f.name, permalink: f.permalink }, null, 2));
