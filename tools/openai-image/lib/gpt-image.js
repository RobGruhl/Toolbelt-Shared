/**
 * Canonical OpenAI Image generation client.
 *
 * Wraps both surfaces from https://developers.openai.com/api/docs/guides/image-generation:
 *   - Image API (client.images.*)        — one-shot generate/edit/stream
 *   - Responses API (client.responses.*) — conversational, multi-turn editing
 *
 * Design rules:
 *   - No console.log (callers decide logging)
 *   - Throws on error (callers decide error handling)
 *   - Returns decoded Buffers (not base64 strings)
 *   - Accepts explicit apiKey, else resolveKey() (env var, then a 600-mode key file)
 *   - Every paid call goes through the same request builders the CLI previews, so the
 *     preview and the call cannot drift apart (SENSIBILITIES #5)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI, { toFile } from 'openai';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RESPONSES_MODEL,
  INPUT_FIDELITY_MODELS,
  TRANSPARENT_MODELS,
  PRICING,
  SIZE_CONSTRAINTS,
} from './constants.js';

// Complex prompts at quality high take up to ~2 minutes; the SDK default (10 min) is
// generous, this is the belt's ceiling.
export const TIMEOUT_MS = 180_000;
export const KEY_FILE = path.join(os.homedir(), '.config', 'toolbelt', 'openai-image.key');

// -- Credential --------------------------------------------------------------------------

/**
 * $OPENAI_API_KEY wins; else the 600-mode key file. A group/world-readable key file is
 * refused, not read (SENSIBILITIES #11). Returns null when neither exists — callers decide
 * whether that is fatal (a preview is not).
 */
export function resolveKey({ env = process.env, keyFile = KEY_FILE } = {}) {
  const fromEnv = (env.OPENAI_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  let st;
  try { st = fs.statSync(keyFile); } catch { return { key: null, source: 'none' }; }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`${keyFile} is group/world readable — chmod 600 it first`);
  }
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  return key ? { key, source: 'file' } : { key: null, source: 'none' };
}

export function createClient(apiKey) {
  const key = apiKey || resolveKey().key;
  if (!key) throw new Error(`OPENAI_API_KEY not set and ${KEY_FILE} absent`);
  return new OpenAI({ apiKey: key, timeout: TIMEOUT_MS });
}

let _defaultClient;
function clientFor(opts) {
  if (opts.client) return opts.client;
  if (opts.apiKey) return createClient(opts.apiKey);
  if (!_defaultClient) _defaultClient = createClient();
  return _defaultClient;
}

// -- Pure helpers (testable without a network) --------------------------------------------

/** Validate a size string against the gpt-image-2 constraints. Returns {w, h, experimental}. */
export function parseSize(size) {
  if (size === 'auto') return { w: 1024, h: 1024, auto: true, experimental: false };
  const m = /^(\d+)x(\d+)$/.exec(size || '');
  if (!m) throw new Error(`size must be auto or WxH, got ${JSON.stringify(size)}`);
  const w = Number(m[1]), h = Number(m[2]);
  const C = SIZE_CONSTRAINTS;
  const px = w * h;
  const problems = [];
  if (w > C.MAX_EDGE || h > C.MAX_EDGE) problems.push(`max edge ${C.MAX_EDGE}px`);
  if (w % C.EDGE_MULTIPLE || h % C.EDGE_MULTIPLE) problems.push(`edges must be multiples of ${C.EDGE_MULTIPLE}`);
  if (Math.max(w, h) / Math.min(w, h) > C.MAX_RATIO) problems.push(`aspect ratio must be <= ${C.MAX_RATIO}:1`);
  if (px < C.MIN_PIXELS || px > C.MAX_PIXELS) problems.push(`total pixels must be in [${C.MIN_PIXELS}, ${C.MAX_PIXELS}]`);
  if (problems.length) throw new Error(`size ${size} is not valid for gpt-image-2: ${problems.join('; ')}`);
  return { w, h, auto: false, experimental: px > C.RELIABLE_MAX_PIXELS };
}

/**
 * Estimated USD per image. Preset sizes use the per-image table (gpt-image-2's is calibrated from
 * observed token usage; the others are official figures); any other size
 * scales the 1024x1024 figure by pixel count (token-billed, so a proportional estimate).
 * quality auto is priced as high — the honest upper bound. Returns {perImage, basis}.
 */
export function estimateCost({ model = DEFAULT_IMAGE_MODEL, size = '1024x1024', quality = 'auto', n = 1 }) {
  const table = PRICING[model];
  if (!table) return { perImage: null, total: null, basis: `no price table for ${model}` };
  const q = quality === 'auto' ? 'high' : quality;
  const row = table[q];
  if (!row) return { perImage: null, total: null, basis: `unknown quality ${quality}` };
  const { w, h, auto } = parseSize(size);
  const key = `${w}x${h}`;
  if (auto || row[key] != null) {
    const perImage = row[auto ? '1024x1024' : key];
    const src = model === 'gpt-image-2' ? 'per-image price calibrated from observed token usage' : 'official per-image price';
    return { perImage, total: perImage * n, basis: `${src}${quality === 'auto' ? ' (auto priced as high)' : ''}${auto ? ' (auto priced as 1024x1024)' : ''}` };
  }
  const perImage = row['1024x1024'] * (w * h) / (1024 * 1024);
  return { perImage, total: perImage * n, basis: 'scaled from 1024x1024 by pixel count (estimate)' };
}

/** The exact Image API request body for generate(). Pure; the preview prints this. */
export function buildGenerateRequest(prompt, opts = {}) {
  const req = { model: opts.model || DEFAULT_IMAGE_MODEL, prompt };
  if (opts.size)         req.size = opts.size;
  if (opts.quality)      req.quality = opts.quality;
  if (opts.format)       req.output_format = opts.format;
  if (opts.compression != null) req.output_compression = opts.compression;
  if (opts.background)   req.background = opts.background;
  if (opts.moderation)   req.moderation = opts.moderation;
  if (opts.n)            req.n = opts.n;
  checkTransparent(req);
  return req;
}

/**
 * Refuse a transparent request the API would 400, before it is sent.
 * gpt-image-2 has no alpha output: render it on a plain solid background and
 * key that out locally, or pass a TRANSPARENT_MODELS model.
 */
function checkTransparent(req) {
  if (req.background !== 'transparent') return;
  if (!TRANSPARENT_MODELS.has(req.model)) {
    throw new Error(`background transparent is not supported by ${req.model}; use --model ${[...TRANSPARENT_MODELS][0]}, `
      + 'or render on a plain solid background and key it out (docs/07-compositing-print-tricks.md)');
  }
  if (req.output_format && !['png', 'webp'].includes(req.output_format)) {
    throw new Error('background transparent requires output_format png or webp');
  }
}

/** The edit request minus the file streams (those are attached at call time). Pure. */
export function buildEditRequest(prompt, opts = {}) {
  const req = { model: opts.model || DEFAULT_IMAGE_MODEL, prompt };
  if (opts.size)         req.size = opts.size;
  if (opts.quality)      req.quality = opts.quality;
  if (opts.format)       req.output_format = opts.format;
  if (opts.compression != null) req.output_compression = opts.compression;
  if (opts.background)   req.background = opts.background;
  if (opts.n)            req.n = opts.n;
  // gpt-image-2 is always high fidelity and rejects the parameter.
  if (opts.inputFidelity && INPUT_FIDELITY_MODELS.has(req.model)) req.input_fidelity = opts.inputFidelity;
  checkTransparent(req);
  return req;
}

/** Decode the API's usage block into a flat object for the audit line; tolerant of absence. */
export function usageOf(raw) {
  const u = raw?.usage;
  if (!u) return null;
  return {
    input: u.input_tokens ?? null,
    output: u.output_tokens ?? null,
    imageIn: u.input_tokens_details?.image_tokens ?? null,
    textIn: u.input_tokens_details?.text_tokens ?? null,
  };
}

// -- Image API: generate ------------------------------------------------------------------

/**
 * @param {string} prompt
 * @param {object} [opts] model, size, quality, format, compression, background, moderation, n, client, apiKey
 * @returns {Promise<{images: Buffer[], raw: object}>}
 */
export async function generate(prompt, opts = {}) {
  const client = clientFor(opts);
  const result = await client.images.generate(buildGenerateRequest(prompt, opts));
  return { images: result.data.map(d => Buffer.from(d.b64_json, 'base64')), raw: result };
}

// -- Image API: edit ----------------------------------------------------------------------

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}

/**
 * @param {string} prompt
 * @param {object} opts image (path | path[], up to 16), mask (PNG with alpha, same size as image[0]),
 *                      model, size, quality, format, compression, background, n, inputFidelity, client, apiKey
 * @returns {Promise<{images: Buffer[], raw: object}>}
 */
export async function edit(prompt, opts) {
  if (!opts || !opts.image) throw new Error('edit() requires opts.image (path or array of paths)');
  const client = clientFor(opts);
  const paths = Array.isArray(opts.image) ? opts.image : [opts.image];
  if (paths.length > 16) throw new Error('edit() accepts at most 16 input images');
  const images = await Promise.all(paths.map(p =>
    toFile(fs.createReadStream(p), path.basename(p), { type: mimeOf(p) })
  ));
  const req = buildEditRequest(prompt, opts);
  req.image = images.length === 1 ? images[0] : images;
  if (opts.mask) req.mask = await toFile(fs.createReadStream(opts.mask), path.basename(opts.mask), { type: 'image/png' });
  const result = await client.images.edit(req);
  return { images: result.data.map(d => Buffer.from(d.b64_json, 'base64')), raw: result };
}

// -- Image API: streaming -----------------------------------------------------------------

/**
 * @yields {{index: number, buffer: Buffer, isFinal: boolean}}
 * partialImages 0-3 (each partial costs +100 output tokens).
 */
export async function* stream(prompt, opts = {}) {
  const client = clientFor(opts);
  const req = { ...buildGenerateRequest(prompt, opts), stream: true, partial_images: opts.partialImages ?? 2 };
  const events = await client.images.generate(req);
  for await (const event of events) {
    if (event.type === 'image_generation.partial_image') {
      yield { index: event.partial_image_index, buffer: Buffer.from(event.b64_json, 'base64'), isFinal: false };
    } else if (event.type === 'image_generation.completed') {
      yield { index: -1, buffer: Buffer.from(event.b64_json, 'base64'), isFinal: true };
    }
  }
}

// -- Responses API ------------------------------------------------------------------------

/** The exact Responses API request for generateViaResponses(). Pure. */
export function buildResponsesRequest(input, opts = {}) {
  const tool = { type: 'image_generation' };
  if (opts.action)       tool.action = opts.action;
  if (opts.quality)      tool.quality = opts.quality;
  if (opts.size)         tool.size = opts.size;
  if (opts.format)       tool.output_format = opts.format;
  if (opts.compression != null) tool.output_compression = opts.compression;
  if (opts.background)   tool.background = opts.background;
  if (opts.partialImages != null) tool.partial_images = opts.partialImages;
  if (opts.inputImageMaskFileId) tool.input_image_mask = { file_id: opts.inputImageMaskFileId };
  const req = { model: opts.model || DEFAULT_RESPONSES_MODEL, input: opts.inputContent ?? input, tools: [tool] };
  if (opts.previousResponseId) req.previous_response_id = opts.previousResponseId;
  return req;
}

/**
 * Multi-turn image generation: the mainline model rewrites the prompt and calls a GPT
 * Image model. Thread turns with previousResponseId.
 * @returns {Promise<{images: Buffer[], revisedPrompt: string|null, responseId: string, raw: object}>}
 */
export async function generateViaResponses(input, opts = {}) {
  const client = clientFor(opts);
  const response = await client.responses.create(buildResponsesRequest(input, opts));
  const calls = response.output.filter(o => o.type === 'image_generation_call');
  return {
    images: calls.map(c => Buffer.from(c.result, 'base64')),
    revisedPrompt: calls[0]?.revised_prompt ?? null,
    responseId: response.id,
    raw: response,
  };
}

// -- Utility ------------------------------------------------------------------------------

export function saveImage(buffer, file) {
  fs.writeFileSync(file, buffer);
  return file;
}
