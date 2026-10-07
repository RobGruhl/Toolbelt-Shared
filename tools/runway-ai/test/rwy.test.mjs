import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_CREDITS_PER_CALL, MAX_N, VERBS, imageInput, plan, refInput, renderPreview, resolveKey } from '../rwy.mjs';
import { IMAGE_MODELS, VIDEO_MODELS } from '../lib/models.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwy-test-'));
const out = path.join(tmp, 'out');
const write = (name, text, mode = 0o600) => { const f = path.join(tmp, name); fs.writeFileSync(f, text, { mode }); fs.chmodSync(f, mode); return f; };

test('resolveKey: env wins, then key file, then .env; the template placeholder is not a key', () => {
  const keyFile = write('k', 'key_fromfile\n');
  const envFile = write('.env', '# comment RUNWAYML_API_SECRET=nope\nRUNWAYML_API_SECRET=key_fromdotenv\n');
  assert.deepEqual(resolveKey({ env: { RUNWAYML_API_SECRET: 'key_env' }, keyFile, envFile }), { key: 'key_env', source: 'env' });  // pragma: allowlist secret
  assert.deepEqual(resolveKey({ env: {}, keyFile, envFile }), { key: 'key_fromfile', source: 'key file' });
  assert.deepEqual(resolveKey({ env: {}, keyFile: '/nonexistent', envFile }), { key: 'key_fromdotenv', source: '.env' });
  const placeholder = write('.env.ph', 'RUNWAYML_API_SECRET=key_your_runway_api_key_here\n');
  assert.equal(resolveKey({ env: {}, keyFile: '/nonexistent', envFile: placeholder }).source, 'none');
});

test('resolveKey refuses a group/world-readable credential file', () => {
  const loose = write('loose', 'RUNWAYML_API_SECRET=key_x\n', 0o644);
  assert.throws(() => resolveKey({ env: {}, keyFile: '/nonexistent', envFile: loose }), /chmod 600/);
});

test('plan prices a call and never exceeds the ceiling', () => {
  const p = plan('video', 'clouds', { out, duration: '5' });
  assert.equal(p.request.endpoint, 'text_to_video');
  assert.equal(p.cost.credits, 60);
  assert.equal(plan('video', 'clouds', { out, duration: '10' }).cost.credits, MAX_CREDITS_PER_CALL);
  assert.equal(plan('image', 'a cat', { out, n: String(MAX_N) }).cost.credits, MAX_N);
  assert.throws(() => plan('image', 'a cat', { out, n: String(MAX_N + 1) }), /--n must be/);
});

test('plan validates per-model fields before any call', () => {
  assert.throws(() => plan('video', 'x', { out, ratio: '960:960' }), /--ratio/);            // image-only ratio on text-to-video
  assert.throws(() => plan('video', 'x', { out, duration: '11' }), /--duration/);
  assert.throws(() => plan('video', 'x', { out, model: 'gen4_turbo' }), /image-to-video only/);
  assert.throws(() => plan('image', 'x', { out, model: 'gen4_image', n: '2' }), /one image per call/);
  assert.throws(() => plan('video', 'x', { out, model: 'gen3a_turbo' }), /--model/);
  assert.throws(() => plan('image', 'x', {}), /--out/);
  assert.throws(() => plan('image', 'x', { out: os.homedir() }), /project directory/);
  assert.throws(() => plan('image', 'x', { out, name: '../escape' }), /--name/);
});

test('plan refuses to overwrite an existing output stem', () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'taken.png'), '');
  assert.throws(() => plan('image', 'x', { out, name: 'taken' }), /refusing to overwrite/);
});

test('local images become data URIs within the size limit; the preview hides the payload', () => {
  const png = write('frame.png', 'not really a png');
  assert.match(imageInput(png).uri, /^data:image\/png;base64,/);
  assert.throws(() => imageInput(write('frame.gif', 'x')), /jpg, .png or .webp/);
  const p = plan('video', 'push in', { out, image: png });
  assert.equal(p.request.endpoint, 'image_to_video');
  const preview = renderPreview(p, 'none');
  assert.match(preview, /PREVIEW, nothing sent/);
  assert.match(preview, /<data URI>/);
  assert.doesNotMatch(preview, /base64/);
});

test('--ref: tagged for gen4_image (≤3), untagged for muse_image; data URIs elided in the preview', () => {
  const png = write('ref.png', 'png bytes');
  assert.equal(refInput(`pair=${png}`, { tags: true }).tag, 'pair');
  assert.throws(() => refInput(`pair=${png}`, { tags: false }), /untagged/);
  assert.throws(() => refInput(`1x=${png}`, { tags: true }), /tag/);
  const p = plan('image', '@pair on a ferry', { out, model: 'gen4_image', ratio: '1280:720', ref: [`pair=${png}`] });
  assert.deepEqual(p.request.body.referenceImages.map(r => r.tag), ['pair']);
  assert.doesNotMatch(renderPreview(p, 'env'), /base64/);
  assert.throws(() => plan('image', 'x', { out, model: 'gen4_image', ref: [png, png, png, png] }), /at most 3/);
  assert.throws(() => plan('video', 'x', { out, ref: [png] }), /--ref apply to image/);
});

test('audio prices by the second and refuses picture flags', () => {
  const p = plan('audio', 'gulls over a harbor', { out, duration: '5' });
  assert.equal(p.request.endpoint, 'sound_effect');
  assert.deepEqual(p.request.body, { model: 'eleven_text_to_sound_v2', promptText: 'gulls over a harbor', duration: 5 });
  assert.equal(p.cost.credits, 5);
  assert.throws(() => plan('audio', 'x', { out, duration: '31' }), /--duration/);
  assert.throws(() => plan('audio', 'x', { out, ratio: '1280:720' }), /does not apply/);
});

test('every priced model has a request shape the table fully describes', () => {
  for (const m of Object.values(IMAGE_MODELS)) assert.ok(m.ratios.includes(m.defaultRatio));
  for (const m of Object.values(VIDEO_MODELS)) {
    assert.ok(m.imageRatios.includes(m.defaultRatio));
    assert.ok(m.perSecond * m.durations[1] <= MAX_CREDITS_PER_CALL, 'the longest clip of each model fits under the ceiling');
  }
});

test("manifest verbs[] matches the code's VERBS table", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../toolbelt.json', import.meta.url), 'utf8'));
  const claimed = Object.fromEntries(manifest.verbs.filter(v => v.tier !== 'never').map(v => [v.name.split(' ')[0], { tier: v.tier, ...(v.gate ? { gate: v.gate } : {}) }]));
  assert.deepEqual(claimed, VERBS);
});
