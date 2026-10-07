#!/usr/bin/env node
/**
 * rwy — Runway Dev image and video generation, gated to its blast radius (SENSIBILITIES #2, #3, #5, #7).
 *
 * `balance`, `usage`, `task` and `models` only read. `image` and `video` spend credits: they
 * preview by default — model, endpoint, ratio, duration, credit cost, output paths — and exit 0
 * without calling the API. `--yes` runs them. The spend is the operator's own, private and
 * bounded, so the gate is a loud flag, always honored (flag tier). What a flag cannot raise
 * lives as constants below: images per call and credits per call.
 *
 * Generation is asynchronous: a create call returns a task id and the SDK polls it to a
 * terminal state. Output URLs expire in 24–48 h, so a successful run downloads every output
 * into --out at once. A run that times out prints its task id; `rwy task <id> --out <dir>`
 * collects it later without spending again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_MODELS,
  DEFAULT_AUDIO_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  PRICES_AS_OF,
  USD_PER_CREDIT,
  VIDEO_MODELS,
  audioCredits,
  buildAudioRequest,
  buildImageRequest,
  buildVideoRequest,
  videoCredits,
} from './lib/models.mjs';

export const VERSION = '0.1.0';
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

// -- Ceilings: code constants, not flags (SENSIBILITIES #3). Raising one is a diff. -------
export const MAX_N = 4;                    // images per call (muse_image allows 10)
export const MAX_CREDITS_PER_CALL = 120;   // $1.20 — one 10 s gen4.5 clip; above it the call is refused
export const MAX_IMAGE_BYTES = 3_300_000;  // local images travel as data URIs, capped at 5 MB encoded
export const WAIT_MS = { image: 5 * 60_000, video: 15 * 60_000, audio: 5 * 60_000 };

export const KEY_FILE = path.join(os.homedir(), '.config', 'toolbelt', 'runway-ai.key');
export const ENV_FILE = path.join(TOOL_DIR, '.env');
export const AUDIT_HOME = process.env.RUNWAY_AI_HOME || path.join(os.homedir(), '.local', 'share', 'runway-ai');
export const AUDIT_FILE = path.join(AUDIT_HOME, 'audit.log');

// The agent-reachable surface. The manifest's verbs[] mirrors this table; the tests assert it.
export const VERBS = {
  models:  { tier: 'read' },
  balance: { tier: 'read' },
  usage:   { tier: 'read' },
  task:    { tier: 'read' },
  image:   { tier: 'write-gated', gate: 'flag' },
  video:   { tier: 'write-gated', gate: 'flag' },
  audio:   { tier: 'write-gated', gate: 'flag' },
};

const USAGE = `rwy ${VERSION} — Runway Dev generation, preview-first

  node rwy.mjs models                                   priced models and their ratios; no network
  node rwy.mjs balance                                  credit balance and tier limits
  node rwy.mjs usage [--days N]                         credits spent per model per day (default 30, max 90)
  node rwy.mjs task <id> [--out <dir>]                  task status; with --out, download its outputs
  node rwy.mjs image <prompt> --out <dir> [options]     text → image
  node rwy.mjs video <prompt> --out <dir> [options]     text → video, or image → video with --image
  node rwy.mjs audio <prompt> --out <dir> [options]     text → sound effect or ambience

  image, video and audio PREVIEW by default (model, ratio, duration, credits, output paths) and make
  no call. Add --yes to spend. The flag is for the human who read the preview.

options
  --out <dir>          required to spend; every file lands inside it, nothing is overwritten
  --name <stem>        output file stem [A-Za-z0-9._-]; default: a slug of the prompt + timestamp
  --model <id>         image: ${Object.keys(IMAGE_MODELS).join('|')} (default ${DEFAULT_IMAGE_MODEL})
                       video: ${Object.keys(VIDEO_MODELS).join('|')} (default ${DEFAULT_VIDEO_MODEL})
                       audio: ${Object.keys(AUDIO_MODELS).join('|')} (default ${DEFAULT_AUDIO_MODEL})
  --ratio <W:H>        per model; see \`models\`
  --duration <s>       video seconds (default 5); audio seconds (default 10, max 30)
  --image <path|url>   video first frame: a local jpg/png/webp (≤3.3 MB) or an https URL
  --ref [tag=]<path|url>  image reference, repeatable (gen4_image ≤3, cite as @tag; muse_image ≤10, untagged)
  --loop               audio designed to loop seamlessly
  -n, --n <1-${MAX_N}>        images per call (muse_image only)
  --seed <int>         reproducible sampling
  --yes                spend
  --json               machine summary on stdout
  -h, --help  --version

ceiling (a constant in rwy.mjs): ${MAX_CREDITS_PER_CALL} credits ($${(MAX_CREDITS_PER_CALL * USD_PER_CREDIT).toFixed(2)}) per call, n <= ${MAX_N}
credential: $RUNWAYML_API_SECRET, else ${KEY_FILE}, else tools/runway-ai/.env — files mode 600
audit log:  ${AUDIT_FILE}
exit codes: 0 ok or previewed · 1 API, credential or filesystem failure · 2 usage or ceiling`;

class UsageError extends Error {}

// -- Credential (SENSIBILITIES #11) -------------------------------------------------------

function assertPrivate(file, st) {
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} is group/world readable — chmod 600 it first`);
}

/**
 * $RUNWAYML_API_SECRET wins, then the 600-mode key file outside the tree, then the gitignored
 * in-tree .env. A group/world-readable file is refused, not read. Returns source 'none' when
 * nothing is found — a preview does not need a key.
 */
export function resolveKey({ env = process.env, keyFile = KEY_FILE, envFile = ENV_FILE } = {}) {
  const fromEnv = (env.RUNWAYML_API_SECRET || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  for (const [file, source] of [[keyFile, 'key file'], [envFile, '.env']]) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    assertPrivate(file, st);
    const text = fs.readFileSync(file, 'utf8');
    const key = source === '.env'
      ? (/^\s*(?:export\s+)?RUNWAYML_API_SECRET\s*=\s*['"]?([^'"\s#]+)/m.exec(text)?.[1] ?? '')
      : text.trim();
    if (key && !key.startsWith('key_your_')) return { key, source };
  }
  return { key: null, source: 'none' };
}

async function client({ retries = 2 } = {}) {
  const { key } = resolveKey();
  if (!key) throw new Error(`no credential — set RUNWAYML_API_SECRET, or put it in ${KEY_FILE} or tools/runway-ai/.env (chmod 600)`);
  const { default: RunwayML } = await import('@runwayml/sdk');
  return new RunwayML({ apiKey: key, maxRetries: retries, timeout: 60_000 });
}

// -- Arguments ----------------------------------------------------------------------------

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      name: { type: 'string' },
      model: { type: 'string' },
      ratio: { type: 'string' },
      duration: { type: 'string' },
      image: { type: 'string' },
      ref: { type: 'string', multiple: true },
      loop: { type: 'boolean' },
      n: { type: 'string', short: 'n' },
      seed: { type: 'string' },
      days: { type: 'string' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  const [verb, ...rest] = positionals;
  return { verb, rest, prompt: rest.join(' ').trim(), flags: values };
}

function int(v, name, min, max) {
  if (v === undefined) return undefined;
  const x = Number(v);
  if (!Number.isInteger(x) || x < min || x > max) throw new UsageError(`--${name} must be an integer in [${min}, ${max}]`);
  return x;
}

function oneOf(v, name, allowed) {
  if (!allowed.includes(v)) throw new UsageError(`--${name} must be one of ${allowed.join(' ')}`);
  return v;
}

// -- Inputs and output containment --------------------------------------------------------

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** A first-frame image: an https URL passes through; a local file becomes a data URI. */
export function imageInput(ref) {
  if (/^https:\/\//.test(ref)) return { uri: ref, label: ref };
  const file = path.resolve(ref);
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new UsageError(`--image must be .jpg, .png or .webp (or an https URL), got ${ref}`);
  let st;
  try { st = fs.statSync(file); } catch { throw new UsageError(`input not found: ${file}`); }
  if (st.size > MAX_IMAGE_BYTES) throw new UsageError(`${file} is ${st.size} bytes; local images must be ≤ ${MAX_IMAGE_BYTES} (Runway's 5 MB data-URI limit) — shrink it or pass an https URL`);
  return { uri: `data:${type};base64,${fs.readFileSync(file).toString('base64')}`, label: `${file} (${st.size} bytes, sent inline)` };
}

const TAG = /^[A-Za-z][A-Za-z0-9_]{2,15}$/;

/** --ref [tag=]<path|url>: a reference image for text_to_image, tagged where the model takes tags. */
export function refInput(arg, { tags }) {
  const m = /^([^=/]+)=(.+)$/.exec(arg);
  const [tag, ref] = m ? [m[1], m[2]] : [undefined, arg];
  if (tag !== undefined && !tags) throw new UsageError(`this model takes untagged references; drop "${tag}="`);
  if (tag !== undefined && !TAG.test(tag)) throw new UsageError(`reference tag "${tag}" must be 3–16 characters, start with a letter, letters/digits/underscore only`);
  const { uri, label } = imageInput(ref);
  return { uri, tag, label: tag ? `@${tag} ← ${label}` : label };
}

export function slug(prompt) {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'runway';
}

export function outDir(out) {
  if (!out) throw new UsageError('--out <dir> is required: every output is written inside it and nowhere else');
  const dir = path.resolve(out);
  if (dir === path.parse(dir).root || dir === os.homedir()) throw new UsageError(`--out must be a project directory, not ${dir}`);
  return dir;
}

export function stemFor({ name, prompt, now = new Date() }) {
  if (name !== undefined && !/^[A-Za-z0-9._-]+$/.test(name)) throw new UsageError('--name may contain only [A-Za-z0-9._-]');
  return name ?? `${slug(prompt)}-${now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`;
}

// -- Planning: the request, its price, where it lands. No network. -------------------------

export function plan(verb, prompt, flags) {
  const seed = int(flags.seed, 'seed', 0, 4294967295);
  let request, cost, n = 1, kind, inputLabel = null;
  if (verb === 'image') {
    if (!prompt) throw new UsageError('image needs a prompt');
    const model = oneOf(flags.model ?? DEFAULT_IMAGE_MODEL, 'model', Object.keys(IMAGE_MODELS));
    const m = IMAGE_MODELS[model];
    if (prompt.length > m.maxPrompt) throw new UsageError(`${model} prompts are at most ${m.maxPrompt} characters`);
    const ratio = oneOf(flags.ratio ?? m.defaultRatio, 'ratio', m.ratios);
    n = int(flags.n, 'n', 1, MAX_N) ?? 1;
    if (n > 1 && !m.multiOutput) throw new UsageError(`${model} returns one image per call; drop -n or use muse_image`);
    if (flags.duration !== undefined || flags.image !== undefined) throw new UsageError('--duration and --image apply to video');
    const refs = (flags.ref ?? []).map(a => refInput(a, m.refs));
    if (refs.length > m.refs.max) throw new UsageError(`${model} takes at most ${m.refs.max} --ref images`);
    request = buildImageRequest({ model, prompt, ratio, n, seed, refs });
    inputLabel = refs.length ? refs.map(r => r.label).join('\n             ') : null;
    cost = m.credits({ n });
    kind = 'image';
  } else if (verb === 'video') {
    const model = oneOf(flags.model ?? DEFAULT_VIDEO_MODEL, 'model', Object.keys(VIDEO_MODELS));
    const m = VIDEO_MODELS[model];
    if (flags.n !== undefined || flags.ref !== undefined) throw new UsageError('-n and --ref apply to image');
    const img = flags.image ? imageInput(flags.image) : null;
    if (!img && !m.text) throw new UsageError(`${model} is image-to-video only; pass --image <path|url>`);
    if (!img && !prompt) throw new UsageError('video needs a prompt, an --image, or both');
    if (prompt.length > m.maxPrompt) throw new UsageError(`${model} prompts are at most ${m.maxPrompt} characters`);
    const ratio = oneOf(flags.ratio ?? m.defaultRatio, 'ratio', img ? m.imageRatios : m.textRatios);
    const duration = int(flags.duration, 'duration', ...m.durations) ?? m.defaultDuration;
    request = buildVideoRequest({ model, prompt, ratio, duration, image: img?.uri, seed });
    cost = videoCredits(model, duration);
    inputLabel = img?.label ?? null;
    kind = 'video';
  } else if (verb === 'audio') {
    if (!prompt) throw new UsageError('audio needs a prompt');
    const model = oneOf(flags.model ?? DEFAULT_AUDIO_MODEL, 'model', Object.keys(AUDIO_MODELS));
    const m = AUDIO_MODELS[model];
    if (prompt.length > m.maxPrompt) throw new UsageError(`${model} prompts are at most ${m.maxPrompt} characters`);
    for (const f of ['n', 'ref', 'image', 'ratio', 'seed']) if (flags[f] !== undefined) throw new UsageError(`--${f} does not apply to audio`);
    const duration = int(flags.duration, 'duration', ...m.durations) ?? m.defaultDuration;
    request = buildAudioRequest({ model, prompt, duration, loop: flags.loop });
    cost = audioCredits(model, duration);
    kind = 'audio';
  } else {
    throw new UsageError(`unknown verb ${verb}`);
  }
  if (cost.credits > MAX_CREDITS_PER_CALL) {
    throw new UsageError(`${cost.credits} credits exceeds MAX_CREDITS_PER_CALL (${MAX_CREDITS_PER_CALL}) — a code constant in rwy.mjs, not a flag; shorten the clip or lower n`);
  }
  const dir = outDir(flags.out);
  const stem = stemFor({ name: flags.name, prompt: prompt || kind });
  const clash = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f === stem || f.startsWith(stem + '.') || f.startsWith(stem + '-')) : [];
  if (clash.length) throw new UsageError(`refusing to overwrite ${clash.join(', ')} in ${dir} — pass a different --name`);
  return { verb, kind, request, cost, n, dir, stem, inputLabel, wait: WAIT_MS[kind] };
}

function usd(credits) { return `$${(credits * USD_PER_CREDIT).toFixed(2)}`; }

export function renderPreview(p, keySource) {
  const { body } = p.request;
  const shown = { ...body };
  if (typeof shown.promptImage === 'string' && shown.promptImage.startsWith('data:')) shown.promptImage = '<data URI>';
  if (shown.referenceImages) shown.referenceImages = shown.referenceImages.map(r => ({ ...r, uri: r.uri.startsWith('data:') ? '<data URI>' : r.uri }));
  const out = [
    `rwy ${p.verb} — PREVIEW, nothing sent`,
    `  endpoint:  POST /v1/${p.request.endpoint}`,
    `  model:     ${body.model}`,
    `  ${body.ratio ? `ratio:     ${body.ratio}   ` : ''}${body.duration ? `duration: ${body.duration}s` : ''}${p.n > 1 ? `   images: ${p.n}` : ''}`,
    `  cost:      ${p.cost.credits} credits (${usd(p.cost.credits)}) — ${p.cost.basis}; prices as of ${PRICES_AS_OF}; ceiling ${MAX_CREDITS_PER_CALL}`,
    '             a generation stopped by content moderation is billed the same as a success',
  ];
  if (p.inputLabel) out.push(`  ${p.kind === 'image' ? 'refs:  ' : 'image: '}    ${p.inputLabel}`);
  if (body.promptText) out.push(`  prompt:    ${JSON.stringify(body.promptText)}`);
  out.push(`  output:    ${path.join(p.dir, p.stem)}${p.n > 1 ? '-{1..' + p.n + '}' : ''}.<ext>`);
  out.push(`  request:   ${JSON.stringify(shown)}`);
  out.push(`  credential: ${keySource === 'none' ? `NONE FOUND — set RUNWAYML_API_SECRET or fill tools/runway-ai/.env` : `present (${keySource})`}`);
  out.push('', 'Re-run with --yes to spend this. The flag is for a human who has read this preview.');
  return out.join('\n');
}

// -- Audit (SENSIBILITIES #7) -------------------------------------------------------------

export function auditLine(f) {
  const parts = [`[rwy audit] ${new Date().toISOString()}`, `verb=${f.verb}`, `model=${f.model}`, `task=${f.task ?? 'none'}`, `status=${f.status}`, `est_credits=${f.est}`];
  if (f.charged != null) parts.push(`charged_credits=${f.charged}`);
  if (f.files) parts.push(`files=${JSON.stringify(f.files)}`);
  if (f.error) parts.push(`error=${JSON.stringify(f.error)}`);
  return parts.join(' ');
}

function audit(line) {
  process.stderr.write(line + '\n');
  try {
    fs.mkdirSync(AUDIT_HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_FILE, line + '\n', { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[rwy] audit log not written (${e.message}); the stderr line above is the record\n`);
  }
}

// -- Downloads ----------------------------------------------------------------------------

const EXT = { 'audio/mpeg': '.mp3', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/zip': '.zip', 'audio/wav': '.wav' };

async function download(urls, dir, stem) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download ${i + 1} failed: HTTP ${res.status} (output URLs expire after 24–48 h)`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = EXT[type] || path.extname(new URL(url).pathname) || '.bin';
    const file = path.join(dir, `${urls.length === 1 ? stem : `${stem}-${i + 1}`}${ext}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()), { flag: 'wx' });
    written.push({ file, bytes: fs.statSync(file).size });
  }
  return written;
}

// -- Verbs --------------------------------------------------------------------------------

function models() {
  const lines = [`image models (POST /v1/text_to_image; default ${DEFAULT_IMAGE_MODEL}) — prices as of ${PRICES_AS_OF}, 1 credit = $0.01`];
  for (const [id, m] of Object.entries(IMAGE_MODELS)) lines.push(`  ${id.padEnd(12)} ${m.note}\n               ratios: ${m.ratios.join(' ')} (default ${m.defaultRatio})`);
  lines.push(`video models (POST /v1/text_to_video, /v1/image_to_video; default ${DEFAULT_VIDEO_MODEL})`);
  for (const [id, m] of Object.entries(VIDEO_MODELS)) {
    lines.push(`  ${id.padEnd(12)} ${m.note}; ${m.durations[0]}–${m.durations[1]}s (default ${m.defaultDuration})`);
    if (m.text) lines.push(`               text ratios:  ${m.textRatios.join(' ')}`);
    lines.push(`               image ratios: ${m.imageRatios.join(' ')}`);
  }
  lines.push(`audio models (POST /v1/sound_effect; default ${DEFAULT_AUDIO_MODEL})`);
  for (const [id, m] of Object.entries(AUDIO_MODELS)) lines.push(`  ${id.padEnd(12)} ${m.note} (default ${m.defaultDuration}s)`);
  lines.push(`ceiling: ${MAX_CREDITS_PER_CALL} credits per call. Other Runway models are not priced here and rwy will not call them;`);
  lines.push('the full catalog is https://docs.dev.runwayml.com/guides/models.md, prices at /guides/pricing.md');
  return lines.join('\n');
}

async function balance(flags) {
  const org = await (await client()).organization.retrieve();
  if (flags.json) return JSON.stringify(org, null, 2);
  const lines = [`credit balance: ${org.creditBalance} (${usd(org.creditBalance)})`, `monthly purchase cap: ${org.tier.maxMonthlyCreditSpend} credits`];
  const limits = Object.entries(org.tier.models || {}).filter(([id]) => id in IMAGE_MODELS || id in VIDEO_MODELS);
  if (limits.length) lines.push('tier limits for priced models: ' + limits.map(([id, l]) => `${id} ${JSON.stringify(l)}`).join(' · '));
  return lines.join('\n');
}

async function usage(flags) {
  const days = int(flags.days, 'days', 1, 90) ?? 30;
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const r = await (await client()).organization.retrieveUsage({ startDate: start });
  if (flags.json) return JSON.stringify(r, null, 2);
  const rows = r.results.flatMap(d => d.usedCredits.map(u => `  ${d.date}  ${String(u.model).padEnd(18)} ${u.amount}`));
  const total = r.results.flatMap(d => d.usedCredits).reduce((s, u) => s + (u.amount || 0), 0);
  return [`credits used since ${start} (UTC): ${total} (${usd(total)})`, ...(rows.length ? rows : ['  none'])].join('\n');
}

async function task(id, flags) {
  if (!id) throw new UsageError('task needs a task id');
  const t = await (await client()).tasks.retrieve(id);
  const lines = [`task ${t.id}: ${t.status}${t.progress != null && t.status === 'RUNNING' ? ` (${Math.round(t.progress * 100)}%)` : ''}`, `  created ${t.createdAt}`];
  if (t.cost?.credits != null) lines.push(`  charged ${t.cost.credits} credits`);
  if (t.failure) lines.push(`  failure: ${t.failure} (${t.failureCode})`);
  if (t.output?.length) lines.push(`  ${t.output.length} output URL(s), valid 24–48 h`);
  if (flags.out && t.status === 'SUCCEEDED') {
    const written = await download(t.output, outDir(flags.out), stemFor({ name: flags.name ?? `task-${t.id.slice(0, 8)}` }));
    for (const w of written) lines.push(`wrote ${w.file} (${w.bytes} bytes)`);
  }
  return flags.json ? JSON.stringify(t, null, 2) : lines.join('\n');
}

async function spend(p) {
  const rw = await client({ retries: 0 }); // a retried create could start (and bill) a second task
  const org = await (await client()).organization.retrieve();
  if (org.creditBalance < p.cost.credits) throw new Error(`balance is ${org.creditBalance} credits; this call needs ${p.cost.credits}`);
  const resource = { text_to_image: rw.textToImage, text_to_video: rw.textToVideo, image_to_video: rw.imageToVideo, sound_effect: rw.soundEffect }[p.request.endpoint];
  const base = { verb: p.verb, model: p.request.body.model, est: p.cost.credits };
  let taskId = null;
  try {
    const pending = resource.create(p.request.body);
    const created = await pending;
    taskId = created.id;
    process.stderr.write(`[rwy] task ${taskId} submitted; waiting (up to ${p.wait / 60_000} min)…\n`);
    const done = await pending.waitForTaskOutput({ timeout: p.wait });
    const written = await download(done.output, p.dir, p.stem);
    audit(auditLine({ ...base, task: taskId, status: 'SUCCEEDED', charged: done.cost?.credits, files: written.map(w => w.file) }));
    return { task: taskId, charged: done.cost?.credits ?? null, written };
  } catch (e) {
    const details = e?.taskDetails;
    const status = details?.status ?? (e?.constructor?.name === 'TaskTimedOutError' ? 'TIMED_OUT' : 'ERROR');
    const msg = details?.failure ? `${details.failure} (${details.failureCode})` : e.message;
    audit(auditLine({ ...base, task: taskId ?? details?.id, status, charged: details?.cost?.credits, error: msg }));
    if (status === 'TIMED_OUT' || (taskId && status === 'ERROR')) {
      throw new Error(`${msg} — the task may still finish; collect it with: node rwy.mjs task ${taskId ?? details?.id} --out ${p.dir}`);
    }
    throw new Error(msg);
  }
}

// -- Main ---------------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parse(argv); } catch (e) { process.stderr.write(`${e.message}\n\n${USAGE}\n`); return 2; }
  const { verb, rest, prompt, flags } = parsed;
  if (flags.version) { process.stdout.write(`rwy ${VERSION}\n`); return 0; }
  if (flags.help || !verb) { process.stdout.write(USAGE + '\n'); return verb ? 0 : 2; }

  try {
    if (verb === 'models') { process.stdout.write(models() + '\n'); return 0; }
    if (verb === 'balance') { process.stdout.write(await balance(flags) + '\n'); return 0; }
    if (verb === 'usage') { process.stdout.write(await usage(flags) + '\n'); return 0; }
    if (verb === 'task') { process.stdout.write(await task(rest[0], flags) + '\n'); return 0; }

    const p = plan(verb, prompt, flags);
    const { source } = resolveKey();
    if (!flags.yes) { process.stdout.write(renderPreview(p, source) + '\n'); return 0; }
    if (source === 'none') throw new Error('no credential — set RUNWAYML_API_SECRET or fill tools/runway-ai/.env (chmod 600)');
    const r = await spend(p);
    if (flags.json) process.stdout.write(JSON.stringify({ verb, model: p.request.body.model, ...r }, null, 2) + '\n');
    else {
      for (const w of r.written) process.stdout.write(`wrote ${w.file} (${w.bytes} bytes)\n`);
      process.stdout.write(`task ${r.task} · charged ${r.charged ?? '?'} credits\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`rwy: ${explain(e)}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

function explain(e) {
  if (e?.status === 401) return '401 — the API key was rejected; check it at https://dev.runwayml.com';
  if (e?.status === 429) return '429 — rate limited for this usage tier; wait and retry (not retried automatically)';
  if (e?.status === 400) return `400 — ${e.message}`;
  return e.message;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
