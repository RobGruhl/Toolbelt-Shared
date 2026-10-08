#!/usr/bin/env node
/**
 * oimg — paid OpenAI image generation, gated to its blast radius (SENSIBILITIES #2, #3, #5, #7).
 *
 * Every paid verb previews by default — model, size, quality, n, estimated cost, the exact
 * output paths — and exits 0 without calling the API. `--yes` runs it. The spend is the
 * operator's own, private and bounded, so the gate is a loud flag, always honored, never a
 * refusal (flag tier). Two things a flag cannot raise live as constants below: the per-call
 * image count and the per-call estimated cost ceiling.
 *
 * One thing --yes cannot pass: the HARD ASK. When the real spend of the last 24 hours (token
 * counts from the audit log) plus this call would pass HARD_ASK_USD, the call stops with exit 3.
 * The caller must then ask the operator. Only after the operator acknowledges a dollar amount
 * does `oimg allow --usd N --yes --note "<their words>"` raise the line, for 24 hours, and the
 * note is logged next to the allowance. Many cheap calls are how the money actually goes, so
 * the gate counts the total, not each call.
 *
 * Output is contained: every file lands inside the directory named by --out, never elsewhere,
 * and an existing file is never overwritten. Each image written gets an audit line on stderr
 * and in the audit log.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  KEY_FILE,
  TIMEOUT_MS,
  buildEditRequest,
  buildGenerateRequest,
  buildResponsesRequest,
  edit,
  estimateCost,
  generate,
  generateViaResponses,
  parseSize,
  resolveKey,
  usageOf,
} from './lib/gpt-image.js';
import { checkSpend, recordAllowance, spentSince, allowedSince } from './lib/spend.js';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RESPONSES_MODEL,
  PRICING,
  RATE_LIMITS,
  TOKEN_RATES,
} from './lib/constants.js';

export const VERSION = '1.0.0';

// -- Ceilings: code constants, not flags (SENSIBILITIES #3). Raising one is a diff. -------
export const MAX_N = 4;                 // images per call (the API allows 10)
export const MAX_EST_USD = 2.0;         // estimated spend per call; above it the call is refused
export const HARD_ASK_USD = 50;         // rolling 24h real spend above which the operator must acknowledge more (oimg allow)
export const ALLOW_STEP_USD = 50;       // default size of one allowance
export const MAX_ALLOW_USD = 500;       // largest single allowance; more is several deliberate asks
export const DEFAULT_QUALITY = 'low';   // drafts by default; --quality high for final assets
export const DEFAULT_SIZE = '1024x1024';
export const DEFAULT_FORMAT = 'png';

export const AUDIT_HOME = process.env.OPENAI_IMAGE_HOME || path.join(os.homedir(), '.local', 'share', 'openai-image');
export const AUDIT_FILE = path.join(AUDIT_HOME, 'audit.log');
export const ALLOW_FILE = path.join(AUDIT_HOME, 'allowances.log');

// The agent-reachable surface. The manifest's verbs[] mirrors this table; the tests assert it.
export const VERBS = {
  models:    { tier: 'read' },
  spend:     { tier: 'read' },
  allow:     { tier: 'write-gated', gate: 'flag' },
  generate:  { tier: 'write-gated', gate: 'flag' },
  edit:      { tier: 'write-gated', gate: 'flag' },
  responses: { tier: 'write-gated', gate: 'flag' },
};

const USAGE = `oimg ${VERSION} — OpenAI image generation (gpt-image-2), preview-first

  node oimg.mjs models                                        models, prices, rate limits; no network
  node oimg.mjs spend                                         real spend, last 24h, from audit-log tokens; no network
  node oimg.mjs allow --usd N --note "<words>" [--yes]        ONLY after the operator acknowledged $N: raise the 24h
                                                              hard-ask line by N (max ${MAX_ALLOW_USD}); previews without --yes
  node oimg.mjs generate <prompt> --out <dir> [options]       Images API, one-shot
  node oimg.mjs edit <prompt> --image <png> [--image ...] [--mask <png>] --out <dir> [options]
  node oimg.mjs responses <prompt> --out <dir> [--previous <response-id>] [--action auto|generate|edit]

  A paid verb PREVIEWS by default (model, size, quality, n, estimated cost, output paths) and
  makes no call. Add --yes to run it. The flag is for the human who read the preview.

options
  --out <dir>            required on paid verbs; every file lands inside it, nothing is overwritten
  --name <stem>          output file stem [a-zA-Z0-9._-]; default: a slug of the prompt + timestamp
  --model <id>           default ${DEFAULT_IMAGE_MODEL} (responses: ${DEFAULT_RESPONSES_MODEL})
  --size <WxH|auto>      default ${DEFAULT_SIZE}; gpt-image-2 takes any WxH (edges x16, <=3840, ratio <=3:1)
  --quality <q>          low|medium|high|auto, default ${DEFAULT_QUALITY}
  --format <f>           png|jpeg|webp, default ${DEFAULT_FORMAT}
  --compression <0-100>  jpeg/webp only
  --background <b>       auto|opaque|transparent (transparent: gpt-image-1.x, png/webp only)
  --moderation <m>       auto|low (generate only)
  --input-fidelity <f>   high|low; gpt-image-1.x edits only, dropped for gpt-image-2
  -n, --n <1-${MAX_N}>          images per call; ceiling is a code constant
  --yes                  run the paid call (does not pass the 24h hard ask)
  --usd <N>              allow only: dollars the operator acknowledged
  --note <text>          allow only: the operator's acknowledgment, in their words (logged)
  --json                 machine summary on stdout after the run
  -h, --help  --version

ceilings (constants in oimg.mjs): n <= ${MAX_N}, estimated cost <= $${MAX_EST_USD.toFixed(2)} per call, ${TIMEOUT_MS / 1000}s timeout
hard ask: real spend over the last 24h + this call > $${HARD_ASK_USD} (+ allowances) stops with exit 3; ask the operator, then oimg allow
credential: $OPENAI_API_KEY, else ${KEY_FILE} (mode 600)
audit log:  ${AUDIT_FILE}
exit codes: 0 ok or previewed · 1 API, credential or filesystem failure · 2 usage or ceiling
            3 the 24h hard ask: ask the operator, then run oimg allow with their acknowledgment`;

// -- Argument parsing ---------------------------------------------------------------------

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      name: { type: 'string' },
      model: { type: 'string' },
      size: { type: 'string' },
      quality: { type: 'string' },
      format: { type: 'string' },
      compression: { type: 'string' },
      background: { type: 'string' },
      moderation: { type: 'string' },
      'input-fidelity': { type: 'string' },
      image: { type: 'string', multiple: true },
      mask: { type: 'string' },
      previous: { type: 'string' },
      action: { type: 'string' },
      n: { type: 'string', short: 'n' },
      yes: { type: 'boolean' },
      usd: { type: 'string' },
      note: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  const [verb, ...rest] = positionals;
  return { verb, prompt: rest.join(' ').trim(), flags: values };
}

class UsageError extends Error {}

function num(v, name, min, max) {
  if (v === undefined) return undefined;
  const x = Number(v);
  if (!Number.isInteger(x) || x < min || x > max) throw new UsageError(`--${name} must be an integer in [${min}, ${max}]`);
  return x;
}

function oneOf(v, name, allowed) {
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) throw new UsageError(`--${name} must be one of ${allowed.join('|')}`);
  return v;
}

// -- Output containment (SENSIBILITIES #2, containment tier on the filesystem) -------------

export function slug(prompt) {
  const s = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'image';
}

export function planOutputs({ out, name, prompt, n, format, now = new Date() }) {
  if (!out) throw new UsageError('--out <dir> is required: every image is written inside it and nowhere else');
  if (name !== undefined && !/^[A-Za-z0-9._-]+$/.test(name)) throw new UsageError('--name may contain only [A-Za-z0-9._-]');
  const dir = path.resolve(out);
  if (dir === path.parse(dir).root || dir === os.homedir()) throw new UsageError(`--out must be a project directory, not ${dir}`);
  const stem = name ?? `${slug(prompt)}-${now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`;
  const ext = format === 'jpeg' ? 'jpg' : format;
  const files = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, n === 1 ? `${stem}.${ext}` : `${stem}-${i + 1}.${ext}`);
    if (path.dirname(f) !== dir) throw new UsageError('output path escaped --out'); // belt and braces
    files.push(f);
  }
  return { dir, files };
}

function refuseExisting(files) {
  const clash = files.filter(f => fs.existsSync(f));
  if (clash.length) throw new Error(`refusing to overwrite: ${clash.join(', ')} — pass a different --name`);
}

// -- Audit (SENSIBILITIES #7) -------------------------------------------------------------

export function auditLine({ verb, model, size, quality, est, file, bytes, usage, shared, responseId }) {
  const parts = [
    `[oimg audit] ${new Date().toISOString()}`,
    `verb=${verb}`, `model=${model}`, `size=${size}`, `quality=${quality}`,
    `est_usd=${est == null ? 'unknown' : est.toFixed(4)}`,
    `file=${JSON.stringify(file)}`, `bytes=${bytes}`,
  ];
  if (usage) parts.push(`tokens_in=${usage.input ?? '?'}`, `tokens_out=${usage.output ?? '?'}`);
  if (usage && shared > 1) parts.push(`tokens_shared=${shared}`);
  if (responseId) parts.push(`response_id=${responseId}`);
  return parts.join(' ');
}

function audit(line) {
  process.stderr.write(line + '\n');
  try {
    fs.mkdirSync(AUDIT_HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_FILE, line + '\n', { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[oimg] audit log not written (${e.message}); the stderr line above is the record\n`);
  }
}

// -- Verbs --------------------------------------------------------------------------------

function models() {
  const lines = [`models (Images API; default ${DEFAULT_IMAGE_MODEL}) — USD per image, low / medium / high at 1024x1024 (1536x1024)`];
  for (const [m, t] of Object.entries(PRICING)) {
    const f = (q) => `$${t[q]['1024x1024'].toFixed(3)} ($${t[q]['1536x1024'].toFixed(3)})`;
    lines.push(`  ${m.padEnd(18)} ${f('low')}  ${f('medium')}  ${f('high')}   per 1M tokens: img in $${TOKEN_RATES[m].imageIn}, img out $${TOKEN_RATES[m].imageOut}`);
  }
  lines.push(`  dall-e-3, dall-e-2     legacy; no price table here`);
  lines.push(`responses (Responses API image_generation tool; default ${DEFAULT_RESPONSES_MODEL}): image cost as above plus the mainline model's tokens`);
  lines.push('rate limits (images/min, tokens/min by usage tier): ' + Object.entries(RATE_LIMITS).map(([t, r]) => `T${t} ${r.ipm}/${r.tpm}`).join(' · '));
  lines.push('batch API is 50% off; quality auto is priced here as high (upper bound)');
  return lines.join('\n');
}

function commonOpts(flags) {
  const size = flags.size ?? DEFAULT_SIZE;
  parseSize(size);
  return {
    model: flags.model ?? DEFAULT_IMAGE_MODEL,
    size,
    quality: oneOf(flags.quality, 'quality', ['low', 'medium', 'high', 'auto']) ?? DEFAULT_QUALITY,
    format: oneOf(flags.format, 'format', ['png', 'jpeg', 'webp']) ?? DEFAULT_FORMAT,
    compression: num(flags.compression, 'compression', 0, 100),
    background: oneOf(flags.background, 'background', ['auto', 'opaque', 'transparent']),
    n: num(flags.n, 'n', 1, MAX_N) ?? 1,
  };
}

/** Plan a paid call: the request, the estimate, the output files. Pure apart from fs.existsSync. */
export function plan(verb, prompt, flags) {
  if (!prompt) throw new UsageError(`${verb} needs a prompt`);
  const o = commonOpts(flags);
  let request, est, inputs = [];
  if (verb === 'generate') {
    o.moderation = oneOf(flags.moderation, 'moderation', ['auto', 'low']);
    request = buildGenerateRequest(prompt, o);
    est = estimateCost(o);
  } else if (verb === 'edit') {
    if (!flags.image?.length) throw new UsageError('edit needs at least one --image <path>');
    inputs = flags.image.map(p => path.resolve(p));
    for (const p of [...inputs, ...(flags.mask ? [path.resolve(flags.mask)] : [])]) {
      if (!fs.existsSync(p)) throw new UsageError(`input not found: ${p}`);
    }
    o.inputFidelity = oneOf(flags['input-fidelity'], 'input-fidelity', ['high', 'low']);
    o.image = inputs;
    if (flags.mask) o.mask = path.resolve(flags.mask);
    request = buildEditRequest(prompt, o);
    est = estimateCost(o);
    est.basis += '; input-image tokens not included';
  } else if (verb === 'responses') {
    o.model = flags.model ?? DEFAULT_RESPONSES_MODEL;
    o.action = oneOf(flags.action, 'action', ['auto', 'generate', 'edit']);
    o.previousResponseId = flags.previous;
    delete o.n; // the tool renders one image per call
    request = buildResponsesRequest(prompt, o);
    est = estimateCost({ model: DEFAULT_IMAGE_MODEL, size: o.size, quality: o.quality, n: 1 });
    est.basis += `; plus ${o.model} text tokens, not estimated`;
    o.n = 1;
  } else {
    throw new UsageError(`unknown verb ${verb}`);
  }
  if (est.total != null && est.total > MAX_EST_USD) {
    throw new UsageError(`estimated $${est.total.toFixed(3)} exceeds MAX_EST_USD ($${MAX_EST_USD.toFixed(2)}) — a code constant in oimg.mjs, not a flag; lower n, size or quality`);
  }
  const { dir, files } = planOutputs({ out: flags.out, name: flags.name, prompt, n: o.n, format: o.format });
  return { verb, opts: o, request, est, dir, files, inputs, experimental: parseSize(o.size).experimental };
}

export function renderPreview(p, keySource) {
  const out = [
    `oimg ${p.verb} — PREVIEW, nothing sent`,
    `  model:     ${p.request.model}`,
    `  size:      ${p.opts.size}${p.experimental ? '  (above 2560x1440: experimental)' : ''}`,
    `  quality:   ${p.opts.quality}   format: ${p.opts.format}${p.opts.background ? `   background: ${p.opts.background}` : ''}`,
    `  n:         ${p.opts.n} (ceiling ${MAX_N})`,
    `  est cost:  ${p.est.total == null ? 'unknown' : '$' + p.est.total.toFixed(3)}  — ${p.est.basis} (ceiling $${MAX_EST_USD.toFixed(2)})`,
  ];
  if (p.inputs.length) out.push(`  inputs:    ${p.inputs.join(', ')}${p.opts.mask ? `   mask: ${p.opts.mask}` : ''}`);
  if (p.opts.previousResponseId) out.push(`  previous:  ${p.opts.previousResponseId}`);
  out.push(`  prompt:    ${JSON.stringify(p.request.prompt ?? p.request.input)}`);
  out.push(`  output:    ${p.files.join('\n             ')}`);
  out.push(`  credential: ${keySource === 'none' ? 'NONE FOUND — set OPENAI_API_KEY or write ' + KEY_FILE : `present (${keySource})`}`);
  if (p.spend) out.push(`  24h spend: $${p.spend.usd.toFixed(2)} real (${p.spend.images} images) of the $${p.spend.limit.toFixed(2)} hard-ask line${p.spend.over ? '  — THIS CALL WOULD PASS IT: --yes will stop; ask the operator first' : ''}`);
  out.push('', 'Re-run with --yes to spend this. The flag is for a human who has read this preview.');
  return out.join('\n');
}

async function run(p) {
  refuseExisting(p.files);
  fs.mkdirSync(p.dir, { recursive: true });
  let images, raw, responseId = null, revisedPrompt = null;
  if (p.verb === 'generate') ({ images, raw } = await generate(p.request.prompt, p.opts));
  else if (p.verb === 'edit') ({ images, raw } = await edit(p.request.prompt, p.opts));
  else ({ images, raw, responseId, revisedPrompt } = await generateViaResponses(p.request.input, p.opts));
  if (!images.length) throw new Error('the API returned no image (the model may have answered in text only)');
  const usage = usageOf(raw);
  const kept = images.slice(0, p.files.length);
  const shares = splitUsage(usage, kept.length);
  const written = [];
  kept.forEach((buf, i) => {
    fs.writeFileSync(p.files[i], buf, { flag: 'wx' });
    const bytes = fs.statSync(p.files[i]).size; // re-read: the write is the claim, the stat is the evidence
    written.push({ file: p.files[i], bytes });
    audit(auditLine({ verb: p.verb, model: p.request.model, size: p.opts.size, quality: p.opts.quality, est: p.est.perImage, file: p.files[i], bytes, usage: shares[i], shared: kept.length, responseId }));
  });
  return { written, usage, responseId, revisedPrompt };
}

/**
 * The API reports one usage block per call, not per image. Give each image an integer share so
 * every audit line prices its own image and the shares sum to exactly what was billed.
 */
export function splitUsage(usage, n) {
  if (!usage || n <= 1) return [usage];
  const share = (total, i) => total == null ? null : Math.floor(total / n) + (i < total % n ? 1 : 0);
  return Array.from({ length: n }, (_, i) => ({ ...usage, input: share(usage.input, i), output: share(usage.output, i) }));
}

function spendReport(now = Date.now()) {
  const s = spentSince(AUDIT_FILE, now), allowed = allowedSince(ALLOW_FILE, now);
  const limit = Math.max(HARD_ASK_USD, allowed);
  return [
    `last 24h: $${s.usd.toFixed(2)} real spend over ${s.images} image(s)${s.estimated ? ` (${s.estimated} priced from estimates: no token counts)` : ''}`,
    `hard-ask line: $${limit.toFixed(2)} (${allowed > HARD_ASK_USD ? 'set by the operator\'s latest acknowledgment' : `the $${HARD_ASK_USD} default`}); headroom $${Math.max(0, limit - s.usd).toFixed(2)}`,
    `source: token counts in ${AUDIT_FILE} at TOKEN_RATES (the per-image est_usd is used only where tokens are missing)`,
  ].join('\n');
}

/**
 * The hard ask's door. It's a flag-tier write: it previews without --yes, and it needs the
 * operator's acknowledgment in --note, which is logged with the allowance. The code can't tell
 * who typed the note; the contract (CLAUDE.md) is that only the operator's own "yes, $N" counts.
 */
export function allowSpend({ usdFlag, note, yes = false, now = new Date() } = {}) {
  const usd = Number(usdFlag);
  if (usdFlag === undefined || !Number.isFinite(usd) || usd <= 0 || usd > MAX_ALLOW_USD) {
    return { code: 2, msg: `oimg: allow needs --usd N with N in (0, ${MAX_ALLOW_USD}]: the amount the operator acknowledged` };
  }
  if (!note?.trim()) return { code: 2, msg: 'oimg: allow needs --note "<the operator\'s acknowledgment, in their words>"' };
  const report = spendReport(now.getTime());
  if (!yes) return { code: 0, msg: `${report}\n\nwould allow $${usd.toFixed(2)} more on top of today's spend, for 24h, acknowledged as: ${JSON.stringify(note.trim())}\nRe-run with --yes once the operator has said yes to this amount.` };
  const base = spentSince(AUDIT_FILE, now.getTime()).usd;
  recordAllowance(ALLOW_FILE, usd, now, note.trim(), base);
  return { code: 0, msg: `allowed: $${usd.toFixed(2)} more on top of $${base.toFixed(2)} already spent (line now $${(base + usd).toFixed(2)} for 24h), acknowledged as ${JSON.stringify(note.trim())}` };
}

// -- Main ---------------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parse(argv); } catch (e) { process.stderr.write(`${e.message}\n\n${USAGE}\n`); return 2; }
  const { verb, prompt, flags } = parsed;
  if (flags.version) { process.stdout.write(`oimg ${VERSION}\n`); return 0; }
  if (flags.help || !verb) { process.stdout.write(USAGE + '\n'); return verb ? 0 : 2; }
  if (verb === 'models') { process.stdout.write(models() + '\n'); return 0; }
  if (verb === 'spend') { process.stdout.write(spendReport() + '\n'); return 0; }
  if (verb === 'allow') {
    const r = allowSpend({ usdFlag: flags.usd, note: flags.note, yes: !!flags.yes });
    (r.code === 0 ? process.stdout : process.stderr).write(r.msg + '\n');
    return r.code;
  }

  let p;
  try { p = plan(verb, prompt, flags); } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`oimg: ${e.message}\n`); return 2; }
    process.stderr.write(`oimg: ${e.message}\n`); return 2;
  }

  p.spend = checkSpend({ auditFile: AUDIT_FILE, allowFile: ALLOW_FILE, est: p.est.total, line: HARD_ASK_USD });

  let keySource;
  try { keySource = resolveKey().source; } catch (e) { process.stderr.write(`oimg: ${e.message}\n`); return 1; }

  if (!flags.yes) {
    process.stdout.write(renderPreview(p, keySource) + '\n');
    return 0;
  }
  if (p.spend.over) {
    process.stderr.write(`oimg: HARD ASK — $${p.spend.usd.toFixed(2)} spent in the last 24h + ~$${(p.est.total ?? 0).toFixed(2)} for this call passes the $${p.spend.limit.toFixed(2)} line. Nothing sent.\n` +
      `  Stop and ask the operator, e.g. "Image spend is $${p.spend.usd.toFixed(2)} in the last 24h. OK to allow another $${ALLOW_STEP_USD}?"\n` +
      `  Only after they say yes: node ${path.join(path.dirname(new URL(import.meta.url).pathname), 'oimg.mjs')} allow --usd ${ALLOW_STEP_USD} --note "<their words>" --yes\n`);
    return 3;
  }
  if (keySource === 'none') { process.stderr.write(`oimg: no credential — set OPENAI_API_KEY or write ${KEY_FILE} (chmod 600)\n`); return 1; }

  try {
    const r = await run(p);
    if (flags.json) process.stdout.write(JSON.stringify({ verb, model: p.request.model, ...r }, null, 2) + '\n');
    else {
      for (const w of r.written) process.stdout.write(`wrote ${w.file} (${w.bytes} bytes)\n`);
      if (r.responseId) process.stdout.write(`response_id ${r.responseId}  (pass as --previous to iterate)\n`);
      if (r.revisedPrompt) process.stdout.write(`revised prompt: ${r.revisedPrompt}\n`);
    }
    return 0;
  } catch (e) {
    const code = e?.code ?? e?.error?.code;
    if (code === 'moderation_blocked') {
      const d = e?.error?.moderation_details ?? e?.moderation_details;
      process.stderr.write(`oimg: blocked by moderation${d ? ` (${d.moderation_stage}: ${(d.categories || []).join(', ')})` : ''} — rephrase the prompt\n`);
    } else if (e?.status === 429) {
      process.stderr.write(`oimg: rate limited (429) — wait a minute; not retried\n`);
    } else if (e?.status === 403) {
      process.stderr.write(`oimg: 403 — gpt-image-* models need API organization verification (https://help.openai.com/en/articles/10910291-api-organization-verification)\n`);
    } else {
      process.stderr.write(`oimg: ${e.message}\n`);
    }
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exitCode = await main();
}
