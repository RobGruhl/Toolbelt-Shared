// Pure-part tests: no network, no credential. `node --test test/*.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.OPENAI_IMAGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oimg-test-'));

const { MAX_N, MAX_EST_USD, HARD_ASK_USD, MAX_ALLOW_USD, VERBS, AUDIT_FILE, ALLOW_FILE, parse, plan, planOutputs, slug, auditLine, renderPreview, allowSpend, main } = await import('../oimg.mjs');
const { auditCost, spentSince, allowedSince, checkSpend } = await import('../lib/spend.js');
const { parseSize, estimateCost, buildGenerateRequest, buildEditRequest, buildResponsesRequest, resolveKey } = await import('../lib/gpt-image.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'toolbelt.json'), 'utf8'));

test('ceilings are the documented constants', () => {
  assert.equal(MAX_N, 4);
  assert.equal(MAX_EST_USD, 2.0);
  assert.equal(HARD_ASK_USD, 50);
  assert.equal(MAX_ALLOW_USD, 500);
});

test('manifest verbs[] mirrors the VERBS table in code', () => {
  const declared = Object.fromEntries(manifest.verbs.filter(v => v.tier !== 'never').map(v => [v.name, { tier: v.tier, ...(v.gate ? { gate: v.gate } : {}) }]));
  assert.deepEqual(declared, VERBS);
});

test('parseSize enforces the gpt-image-2 constraints', () => {
  assert.deepEqual(parseSize('1024x1024'), { w: 1024, h: 1024, auto: false, experimental: false });
  assert.equal(parseSize('3840x2160').experimental, true);
  assert.throws(() => parseSize('1000x1000'), /multiples of 16/);
  assert.throws(() => parseSize('4096x1024'), /max edge/);
  assert.throws(() => parseSize('3264x1024'), /aspect ratio/);
  assert.throws(() => parseSize('512x512'), /total pixels/);
  assert.throws(() => parseSize('big'), /WxH/);
});

test('estimateCost: gpt-image-2 is calibrated to observed tokens (7,024 / 5,488 out at $30/1M)', () => {
  assert.equal(estimateCost({ model: 'gpt-image-2', size: '1024x1024', quality: 'low', n: 2 }).total, 0.064);
  assert.equal(estimateCost({ model: 'gpt-image-2', size: '1536x1024', quality: 'high' }).perImage, 0.165);
  assert.equal(estimateCost({ model: 'gpt-image-2', size: 'auto', quality: 'auto' }).perImage, 0.211); // auto priced as high
  // the calibration itself: the table must not drift below what the API actually bills
  assert.ok(0.211 >= 7024 * 30 / 1e6 - 0.001 && 0.165 >= 5488 * 30 / 1e6 - 0.001);
  const custom = estimateCost({ model: 'gpt-image-2', size: '2048x2048', quality: 'low' });
  assert.equal(custom.perImage, 0.128);
  assert.match(custom.basis, /scaled/);
  assert.equal(estimateCost({ model: 'dall-e-2' }).total, null);
});

test('request builders: gpt-image-2 drops input_fidelity; transparent needs png/webp', () => {
  assert.equal(buildEditRequest('p', { model: 'gpt-image-2', inputFidelity: 'high' }).input_fidelity, undefined);
  assert.equal(buildEditRequest('p', { model: 'gpt-image-1.5', inputFidelity: 'high' }).input_fidelity, 'high');
  assert.throws(() => buildGenerateRequest('p', { background: 'transparent', format: 'jpeg' }), /png or webp/);
  const r = buildResponsesRequest('p', { previousResponseId: 'resp_1', action: 'edit' });
  assert.equal(r.previous_response_id, 'resp_1');
  assert.equal(r.tools[0].action, 'edit');
  assert.equal(r.model, 'gpt-5.6');
});

test('paid verbs refuse n above the ceiling and an estimate above MAX_EST_USD', () => {
  assert.throws(() => plan('generate', 'x', { out: 'output', n: String(MAX_N + 1) }), /--n must be/);
  assert.throws(() => plan('generate', 'x', { out: 'output', size: '3840x2160', quality: 'high', n: '4', model: 'gpt-image-1' }), /MAX_EST_USD/);
  assert.throws(() => plan('generate', '', { out: 'output' }), /needs a prompt/);
});

test('output is contained in --out and names are safe', () => {
  assert.throws(() => planOutputs({ prompt: 'x', n: 1, format: 'png' }), /--out <dir> is required/);
  assert.throws(() => planOutputs({ out: '/', prompt: 'x', n: 1, format: 'png' }), /project directory/);
  assert.throws(() => planOutputs({ out: 'o', name: '../evil', prompt: 'x', n: 1, format: 'png' }), /--name/);
  const { dir, files } = planOutputs({ out: 'o', name: 'a', prompt: 'x', n: 2, format: 'jpeg' });
  assert.deepEqual(files.map(f => path.relative(dir, f)), ['a-1.jpg', 'a-2.jpg']);
  assert.equal(slug('A Red Square!! on white'), 'a-red-square-on-white');
});

test('preview renders the plan and the audit line carries the fields', () => {
  const p = plan('generate', 'a cat', { out: 'output', quality: 'high' });
  const text = renderPreview(p, 'none');
  assert.match(text, /PREVIEW, nothing sent/);
  assert.match(text, /est cost:\s+\$0\.211/);
  assert.match(text, /NONE FOUND/);
  const line = auditLine({ verb: 'generate', model: 'gpt-image-2', size: '1024x1024', quality: 'high', est: 0.04, file: '/tmp/a.png', bytes: 10, usage: { input: 5, output: 400 } });
  assert.match(line, /^\[oimg audit\] \d{4}-.* verb=generate model=gpt-image-2 size=1024x1024 quality=high est_usd=0\.0400 file="\/tmp\/a\.png" bytes=10 tokens_in=5 tokens_out=400$/);
});

test('parse: prompt is the rest of the line; --yes is a plain flag', () => {
  const { verb, prompt, flags } = parse(['generate', 'two', 'words', '--out', 'o', '--yes']);
  assert.equal(verb, 'generate');
  assert.equal(prompt, 'two words');
  assert.equal(flags.yes, true);
});

test('resolveKey: env wins, a loose key file is refused, a 600 file is read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oimg-key-'));
  const kf = path.join(dir, 'key');
  assert.deepEqual(resolveKey({ env: { OPENAI_API_KEY: 'abc' }, keyFile: kf }), { key: 'abc', source: 'env' });
  assert.deepEqual(resolveKey({ env: {}, keyFile: kf }), { key: null, source: 'none' });
  fs.writeFileSync(kf, 'filekey\n', { mode: 0o644 });
  if (process.platform !== 'win32') assert.throws(() => resolveKey({ env: {}, keyFile: kf }), /chmod 600/);
  fs.chmodSync(kf, 0o600);
  assert.deepEqual(resolveKey({ env: {}, keyFile: kf }), { key: 'filekey', source: 'file' });
});

// -- the 24h hard ask ------------------------------------------------------------------

const line = (iso, extra) => `[oimg audit] ${iso} verb=generate model=gpt-image-2 size=1024x1024 quality=high est_usd=0.0400 file="/x.webp" bytes=1 ${extra}`;

test('auditCost prices real tokens, falls back to est_usd, ignores junk', () => {
  const c = auditCost(line('2026-10-05T06:15:40.034Z', 'tokens_in=94 tokens_out=7024'));
  assert.ok(Math.abs(c.usd - (7024 * 30 + 94 * 5) / 1e6) < 1e-9);
  assert.equal(c.tokens, true);
  assert.equal(auditCost(line('2026-10-05T06:15:40.034Z', '')).usd, 0.04);
  assert.equal(auditCost('hello'), null);
});

test('spentSince counts only the rolling 24h window; allowances add to the line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oimg-spend-'));
  const audit = path.join(dir, 'audit.log'), allow = path.join(dir, 'allow.log');
  const now = Date.parse('2026-10-05T12:00:00Z');
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(line('2026-10-05T08:00:00.000Z', 'tokens_in=50 tokens_out=7024')); // ~$63
  lines.push(line('2026-10-03T08:00:00.000Z', 'tokens_in=50 tokens_out=7024'));                          // outside the window
  fs.writeFileSync(audit, lines.join('\n') + '\n');
  const s = spentSince(audit, now);
  assert.equal(s.images, 300);
  assert.ok(s.usd > 63 && s.usd < 64);
  let r = checkSpend({ auditFile: audit, allowFile: allow, est: 0.2, line: 50, now });
  assert.equal(r.over, true);
  // already past the line at ~$63: a yes for "$2 more" must permit $2 on top of that, not raise $50 to $52
  fs.writeFileSync(allow, JSON.stringify({ at: '2026-10-05T09:00:00.000Z', usd: 2, base: 63.3 }) + '\n' + JSON.stringify({ at: '2026-10-01T09:00:00.000Z', usd: 500, base: 0 }) + '\n');
  assert.equal(allowedSince(allow, now), 65.3); // the old allowance has expired
  r = checkSpend({ auditFile: audit, allowFile: allow, est: 0.2, line: 50, now });
  assert.equal(r.over, false);
  assert.equal(r.limit, 65.3);
  r = checkSpend({ auditFile: audit, allowFile: allow, est: 5, line: 50, now });
  assert.equal(r.over, true); // more than the $2 acknowledged
});

test('--yes stops with exit 3 at the hard ask and sends nothing', async () => {
  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(AUDIT_FILE, Array.from({ length: 300 }, () => line(now, 'tokens_in=50 tokens_out=7024')).join('\n') + '\n');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oimg-out-'));
  const code = await main(['generate', 'a cat', '--out', out, '--quality', 'high', '--yes']);
  assert.equal(code, 3);
  assert.deepEqual(fs.readdirSync(out), []);
  fs.writeFileSync(AUDIT_FILE, '');
});

test('allow: needs an amount and the operator\'s words; previews without --yes; logs the note', () => {
  fs.rmSync(ALLOW_FILE, { force: true });
  assert.equal(allowSpend({ note: 'ok' }).code, 2);                                   // no amount
  assert.equal(allowSpend({ usdFlag: '9999', note: 'ok', yes: true }).code, 2);       // over MAX_ALLOW_USD
  assert.equal(allowSpend({ usdFlag: '50', yes: true }).code, 2);                     // no acknowledgment
  const preview = allowSpend({ usdFlag: '50', note: 'yes, another $50' });
  assert.equal(preview.code, 0);
  assert.match(preview.msg, /Re-run with --yes/);
  assert.equal(fs.existsSync(ALLOW_FILE), false);                                    // preview writes nothing
  assert.equal(allowSpend({ usdFlag: '75', note: 'yes, $75 is fine', yes: true }).code, 0);
  assert.equal(allowedSince(ALLOW_FILE), 75); // base is the (empty) test audit log's $0
  assert.equal(JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8').trim()).note, 'yes, $75 is fine');
});
