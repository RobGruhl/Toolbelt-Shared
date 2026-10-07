/**
 * Download file attachments from Slack messages.
 *
 * This is a READ-ONLY capability: it only issues GET/lookup requests
 * against Slack (files.info / conversations.history to resolve a file's
 * private download URL, then a GET of that URL for the bytes). Nothing is
 * posted or mutated, so it lives on the read-first side of the tool
 * alongside export — it is NOT gated like `send`.
 *
 * Auth is the same xoxc token + cookie jar the read paths use
 * (getAuthCookies). The Slack API metadata calls authenticate via
 * token-in-body + cookies (callSlackApi); the file-bytes URL is a
 * Slack-hosted URL fetched with the same token as `Authorization: Bearer`
 * plus the cookie header, following redirects.
 *
 * NEVER log or persist the token or cookie values.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { callSlackApi, resolveChannel, formatCookiesForHeader } from '../auth.js';
import { incrementCounter } from './telemetry.js';

/**
 * Parse a Slack permalink into the input it stands in for.
 *
 * Message permalink: .../archives/<C…>/p<tsDigits>  → { channel, ts }
 *   (the "p" form drops the dot from the ts; we reinsert it: the last 6
 *    digits are the microsecond fraction.)
 * File permalink:    .../files/<team>/<F…>/<name>    → { fileId }
 *
 * Returns null if the URL matches neither shape.
 */
export function parsePermalink(url) {
  if (!url) return null;

  const fileMatch = url.match(/\/files\/[^/]+\/(F[A-Z0-9]+)/i);
  if (fileMatch) {
    return { fileId: fileMatch[1].toUpperCase() };
  }

  const msgMatch = url.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d+)/i);
  if (msgMatch) {
    const channel = msgMatch[1].toUpperCase();
    const digits = msgMatch[2];
    // Reinsert the dot: last 6 digits are the fractional part.
    const ts = `${digits.slice(0, -6)}.${digits.slice(-6)}`;
    return { channel, ts };
  }

  return null;
}

/**
 * Normalize a raw Slack `files[]` entry to the fields we need.
 * Returns null for entries with no downloadable URL (e.g. deleted files,
 * or link/bookmark "files" that carry no bytes).
 */
function normalizeFile(file) {
  if (!file) return null;
  const downloadUrl = file.url_private_download || file.url_private;
  if (!downloadUrl) return null;
  return {
    id: file.id,
    name: file.name || file.title || file.id || 'download',
    mimetype: file.mimetype || null,
    size: typeof file.size === 'number' ? file.size : null,
    downloadUrl,
  };
}

/**
 * Resolve the downloadable file(s) for the given inputs.
 *
 * Exactly one resolution path is used, in this precedence:
 *   1. fileId          → files.info (single file)
 *   2. channel + ts    → conversations.history pinpoint (all files on the message)
 *   3. url (permalink) → sugar for one of the above
 *
 * `fileId` (when combined with channel+ts) also acts as a filter to pick a
 * single attachment off a multi-file message.
 *
 * @param {{cookies: Array, token: string}} auth
 * @param {{fileId?: string, channel?: string, ts?: string, url?: string}} opts
 * @returns {Promise<Array<{id, name, mimetype, size, downloadUrl}>>}
 */
export async function resolveFileDownloads(auth, opts = {}) {
  let { fileId, channel, ts, url } = opts;

  // A permalink is sugar — expand it into fileId or channel+ts.
  if (url && !fileId && !(channel && ts)) {
    const parsed = parsePermalink(url);
    if (!parsed) {
      throw new Error(`Could not parse permalink: ${url}`);
    }
    ({ fileId, channel, ts } = { fileId: parsed.fileId, channel: parsed.channel, ts: parsed.ts });
  }

  // Path 1: direct file id → files.info
  if (fileId && !(channel && ts)) {
    const resp = await callSlackApi('files.info', { file: fileId }, auth.cookies, auth.token);
    const norm = normalizeFile(resp.file);
    if (!norm) {
      throw new Error(`File ${fileId} has no downloadable content`);
    }
    return [norm];
  }

  // Path 2: channel + ts → conversations.history pinpoint
  if (channel && ts) {
    const { channelId } = await resolveChannel(channel, auth.cookies, auth.token);
    const resp = await callSlackApi(
      'conversations.history',
      { channel: channelId, latest: ts, oldest: ts, inclusive: true, limit: 1 },
      auth.cookies,
      auth.token,
    );
    const message = (resp.messages || [])[0];
    if (!message) {
      throw new Error(`No message found at ts ${ts} in ${channel}`);
    }
    let files = (message.files || []).map(normalizeFile).filter(Boolean);
    // If a file id was also given, use it to pick a single attachment.
    if (fileId) {
      files = files.filter((f) => f.id === fileId.toUpperCase());
    }
    if (files.length === 0) {
      throw new Error(
        fileId
          ? `File ${fileId} not found on message ${ts} in ${channel}`
          : `Message ${ts} in ${channel} has no downloadable files`,
      );
    }
    return files;
  }

  throw new Error('Provide --file-id, or --channel and --ts, or --url');
}

/**
 * Download one resolved file to `outputDir`, returning metadata about the
 * written file. The bytes GET uses the SAME auth as the read paths:
 * Authorization: Bearer <token> + Cookie header, following redirects.
 *
 * @param {{cookies: Array, token: string}} auth
 * @param {{name: string, mimetype?: string, downloadUrl: string}} file
 * @param {string} outputDir
 * @returns {Promise<{path, name, size, mimetype}>}
 */
export async function downloadFile(auth, file, outputDir = '.') {
  if (outputDir && !existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const res = await fetch(file.downloadUrl, {
    redirect: 'follow',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Cookie: formatCookiesForHeader(auth.cookies),
    },
  });

  if (!res.ok) {
    // Do not surface the URL (it can carry auth-bearing query params).
    incrementCounter('failedCalls');
    throw new Error(`File download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // Sanitize the Slack-supplied filename: strip any directory components so a
  // name like "report/final.pdf" (crash — subdir never created) or "../x.pdf"
  // (path traversal outside outputDir) can't escape the target directory.
  const safeName = basename(file.name || '').trim() || `slack-file-${Date.now()}`;
  const destPath = join(outputDir, safeName);
  writeFileSync(destPath, buffer);
  incrementCounter('okCalls');

  return {
    path: destPath,
    name: safeName,
    size: buffer.length,
    mimetype: file.mimetype || res.headers.get('content-type') || null,
  };
}

/**
 * Resolve and download all files matching the inputs. Thin convenience
 * wrapper used by the CLI.
 *
 * @returns {Promise<Array<{path, name, size, mimetype}>>}
 */
export async function downloadFiles(auth, opts = {}) {
  const files = await resolveFileDownloads(auth, {
    fileId: opts.fileId,
    channel: opts.channel,
    ts: opts.ts,
    url: opts.url,
  });
  const results = [];
  for (const file of files) {
    results.push(await downloadFile(auth, file, opts.output || '.'));
  }
  return results;
}
