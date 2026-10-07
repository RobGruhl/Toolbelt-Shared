// Unit tests for the pure parts of yt. No network: neither backend is exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCli, extractVideoId, formatTime, render, stats, searchSegments, clampContext, renderExplain,
  MAX_BATCH, MAX_CONTEXT, DEFAULT_CONTEXT, BATCH_DELAY_MS, TIMEOUT_MS, CLEAN_VTT, VERBS, FORMATS,
} from '../yt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEGS = [
  { text: 'hello and welcome', offset: 0, duration: 2.5, lang: 'en' },
  { text: 'to the show', offset: 2.5, duration: 2.5, lang: 'en' },
  { text: 'thanks for having me', offset: 50, duration: 2, lang: 'en' },
];

test('video ids: bare, watch, short, embed, shorts, live; anything else is refused', () => {
  for (const s of ['dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'https://youtu.be/dQw4w9WgXcQ?si=x',
    'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ']) {
    assert.equal(extractVideoId(s), 'dQw4w9WgXcQ');
  }
  assert.throws(() => extractVideoId('--exec=rm'), /not a YouTube video id/);
  assert.throws(() => extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), /not a YouTube video id/);
});

test('parseCli: verbs, flags, strictness', () => {
  assert.deepEqual(VERBS, ['fetch', 'search', 'stats', 'batch', 'ytdlp']);
  const c = parseCli(['fetch', 'dQw4w9WgXcQ', '--format', 'srt', '--lang', 'pt-BR', '--out', 'x.srt']);
  assert.equal(c.verb, 'fetch'); assert.equal(c.videoId, 'dQw4w9WgXcQ'); assert.equal(c.format, 'srt'); assert.equal(c.lang, 'pt-BR'); assert.equal(c.out, 'x.srt');
  assert.equal(parseCli(['search', 'dQw4w9WgXcQ', 'give', 'you', 'up']).query, 'give you up');
  assert.deepEqual(parseCli(['--help']), { help: true });
  assert.throws(() => parseCli([]), /no verb/);
  assert.throws(() => parseCli(['delete', 'dQw4w9WgXcQ']), /unknown verb/);
  assert.throws(() => parseCli(['fetch']), /needs a <url\|id>/);
  assert.throws(() => parseCli(['fetch', 'dQw4w9WgXcQ', '--bogus']), /unknown flag/);
  assert.throws(() => parseCli(['fetch', 'dQw4w9WgXcQ', '--format', 'docx']), /unknown --format/);
  assert.throws(() => parseCli(['fetch', 'dQw4w9WgXcQ', '--lang', '$(id)']), /--lang must be/);
  assert.throws(() => parseCli(['search', 'dQw4w9WgXcQ']), /needs a <query>/);
});

test('ceilings are code constants and refuse rather than lower', () => {
  assert.equal(MAX_BATCH, 20); assert.equal(MAX_CONTEXT, 5); assert.equal(DEFAULT_CONTEXT, 1);
  assert.equal(BATCH_DELAY_MS, 1500); assert.equal(TIMEOUT_MS, 30_000);
  assert.equal(clampContext(undefined), DEFAULT_CONTEXT);
  assert.equal(clampContext('5'), 5);
  assert.throws(() => clampContext('6'), /exceeds the 5 ceiling/);
  const ids = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `dQw4w9WgXc${String.fromCharCode(65 + (i % 26))}`);
  assert.throws(() => parseCli(['batch', ...ids]), /exceeds the 20 ceiling/);
  assert.equal(parseCli(['batch', ...ids.slice(0, MAX_BATCH)]).ids.length, MAX_BATCH);
});

test('formatTime and renderers', () => {
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(render(SEGS, 'text'), 'hello and welcome to the show thanks for having me');
  assert.equal(render(SEGS, 'timestamped').split('\n')[2], '[0:50] thanks for having me');
  assert.match(render(SEGS, 'srt'), /^1\n00:00:00,000 --> 00:00:02,500\nhello and welcome\n/);
  assert.equal(JSON.parse(render(SEGS, 'json')).length, 3);
  const md = render(SEGS, 'md', { videoId: 'dQw4w9WgXcQ' });
  assert.match(md, /^# dQw4w9WgXcQ\n/);
  assert.match(md, /\*\*\[00:00\]\*\* hello and welcome to the show\n\n\*\*\[00:50\]\*\* thanks/);
  assert.equal(FORMATS.length, 6);
  assert.throws(() => render(SEGS, 'nope'), /unknown format/);
});

test('stats and search are pure over segments', () => {
  assert.deepEqual(stats(SEGS), { segments: 3, words: 10, duration: '0:52', durationSeconds: 52, lang: 'en' });
  const hits = searchSegments(SEGS, 'SHOW', 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match.time, '0:02');
  assert.equal(hits[0].context.length, 3);
  assert.equal(searchSegments(SEGS, 'absent').length, 0);
});

test('--explain renders the plan and names the backend without a call', () => {
  const out = renderExplain(parseCli(['fetch', 'dQw4w9WgXcQ', '--explain']));
  assert.match(out, /backend: innertube/);
  assert.match(out, /no call made/);
  assert.match(renderExplain(parseCli(['ytdlp', 'dQw4w9WgXcQ'])), /backend: yt-dlp/);
});

test('clean_vtt.py: rolling auto-captions dedupe, speaker break, plain cues join', (t) => {
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0) return t.skip('python3 not on PATH');
  const rolling = spawnSync('python3', [CLEAN_VTT, path.join(HERE, 'fixtures', 'rolling.en.vtt')], { encoding: 'utf8' });
  assert.equal(rolling.status, 0, rolling.stderr);
  assert.equal(rolling.stdout.trim(), '**[00:00]** hello and welcome to the show\n\n**[00:50]** thanks for having me');
  const plain = spawnSync('python3', [CLEAN_VTT, path.join(HERE, 'fixtures', 'plain.en.vtt')], { encoding: 'utf8' });
  assert.equal(plain.stdout.trim(), '**[00:00]** First line second half Second cue');
});

test('--out refuses to overwrite without --force (the one file write)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yt-test-'));
  const file = path.join(dir, 'x.txt');
  writeFileSync(file, 'keep');
  const { emit } = await import('../yt.mjs');
  assert.throws(() => emit('new', file, false), /exists — pass --force/);
  assert.equal(readFileSync(file, 'utf8'), 'keep');
  emit('new', file, true);
  assert.equal(readFileSync(file, 'utf8'), 'new\n');
  rmSync(dir, { recursive: true, force: true });
});
