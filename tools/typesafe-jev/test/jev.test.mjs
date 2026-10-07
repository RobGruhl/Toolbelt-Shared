// Unit tests for the pure parts of jev. No network: the fetch path is never exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCli, validateQuestions, buildAsk, stateFrom, resolveKey, assertStatePath, renderExplain,
  renderAnswers, auditLine, summarizeAudit, retryDelayMs, costUsd, VERBS,
  MODEL, MAX_STATE_BYTES, MAX_REQUEST_BYTES, MAX_QUESTIONS, MAX_OPTIONS, MIN_LEVELS, MAX_LEVELS,
} from '../jev.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'jev-test-'));

// ---- argument parsing --------------------------------------------------------

test('inline questions become one typed question under --id', () => {
  const n = parseCli(['ask', '--text', 'hi', '--noul', 'Is this a greeting?']);
  assert.deepEqual(n.question, { type: 'noul', instructions: 'Is this a greeting?' });
  assert.equal(n.id, 'q');
  assert.equal(n.model, MODEL);
  const c = parseCli(['ask', '--text', 'x', '--choice', 'Which?', '--options', 'a, b,none', '--id', 'team']);
  assert.deepEqual(c.question.criteria, { a: null, b: null, none: null });
  assert.equal(c.id, 'team');
  const s = parseCli(['ask', '--text', 'x', '--score', 'How?', '--levels', 'Calm|Frustrated|Very angry']);
  assert.deepEqual(s.question.criteria, ['Calm', 'Frustrated', 'Very angry']);
});

test('ask needs exactly one state source and exactly one question source', () => {
  assert.throws(() => parseCli(['ask', '--noul', 'q']), /exactly one of --state/);
  assert.throws(() => parseCli(['ask', '--text', 'x', '--state', 'f', '--noul', 'q']), /exactly one of --state/);
  assert.throws(() => parseCli(['ask', '--text', 'x']), /exactly one of --questions/);
  assert.throws(() => parseCli(['ask', '--text', 'x', '--noul', 'a', '--score', 'b', '--levels', 'x|y']), /exactly one of --questions/);
  assert.throws(() => parseCli(['ask', '--text', 'x', '--choice', 'a']), /needs --options/);
  assert.throws(() => parseCli(['ask', '--text', 'x', '--score', 'a']), /needs --levels/);
  assert.throws(() => parseCli(['ask', '--text', 'x', '--noul', 'a', '--options', 'p,q']), /goes with --choice/);
});

test('unknown verbs, stray arguments and odd model ids are usage errors', () => {
  assert.throws(() => parseCli([]), /no verb/);
  assert.throws(() => parseCli(['train']), /unknown verb "train"/);
  assert.throws(() => parseCli(['models', 'extra']), /unexpected argument/);
  assert.throws(() => parseCli(['ask', '--text', 'x', '--noul', 'q', '--model', 'https://evil/']), /not a model id/);
  assert.throws(() => parseCli(['usage', '--days', '0']), /positive integer/);
  assert.equal(parseCli(['usage', '--days', '7']).days, 7);
});

// ---- question validation and ceilings (SENSIBILITIES #3) ----------------------

test('the ceilings are what the contract says', () => {
  assert.equal(MODEL, 'jev-1.13.0');
  assert.equal(MAX_STATE_BYTES, 96_000);
  assert.equal(MAX_REQUEST_BYTES, 200_000);
  assert.equal(MAX_QUESTIONS, 32);
  assert.equal(MAX_OPTIONS, 255);
  assert.equal(MIN_LEVELS, 2);
  assert.equal(MAX_LEVELS, 10);
});

test('validateQuestions enforces the documented schema', () => {
  assert.doesNotThrow(() => validateQuestions({ a: { type: 'noul', instructions: 'Yes?', criteria: { true: 'y', false: 'n' } } }));
  assert.doesNotThrow(() => validateQuestions({ a: { type: 'choice', instructions: { question: 'Which `x`?', x: 1 }, criteria: { p: null, q: 'desc' } } }));
  assert.throws(() => validateQuestions([]), /JSON object/);
  assert.throws(() => validateQuestions({}), /no questions/);
  assert.throws(() => validateQuestions({ 'bad id!': { type: 'noul', instructions: 'x' } }), /ids are/);
  assert.throws(() => validateQuestions({ a: { type: 'noul' } }), /instructions are required/);
  assert.throws(() => validateQuestions({ a: { type: 'noul', instructions: 'x', criteria: { maybe: 'm' } } }), /only "true" and "false"/);
  assert.throws(() => validateQuestions({ a: { type: 'choice', instructions: 'x', criteria: { only: null } } }), /at least 2 options/);
  assert.throws(() => validateQuestions({ a: { type: 'rank', instructions: 'x' } }), /type must be/);
});

test('a one-level score is refused locally — the API would bill it', () => {
  assert.throws(() => validateQuestions({ a: { type: 'score', instructions: 'x', criteria: ['One'] } }), /2–10 levels, got 1/);
  assert.throws(() => validateQuestions({ a: { type: 'score', instructions: 'x', criteria: Array(11).fill('l') } }), /got 11/);
});

test('question count, option count, state size and request size are refused above the ceilings', () => {
  const many = Object.fromEntries(Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }]));
  assert.throws(() => validateQuestions(many), /MAX_QUESTIONS/);
  const opts = Object.fromEntries(Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => [`o${i}`, null]));
  assert.throws(() => validateQuestions({ a: { type: 'choice', instructions: 'x', criteria: opts } }), /255/);
  const q = { a: { type: 'noul', instructions: 'x' } };
  assert.throws(() => buildAsk({ state: 'x'.repeat(MAX_STATE_BYTES + 1), questions: q, model: MODEL }), /MAX_STATE_BYTES/);
  assert.throws(() => buildAsk({ state: '', questions: q, model: MODEL }), /empty/);
  const long = { a: { type: 'noul', instructions: 'y'.repeat(MAX_REQUEST_BYTES) } };
  assert.throws(() => buildAsk({ state: 'x', questions: long, model: MODEL }), /MAX_REQUEST_BYTES/);
});

test('buildAsk sends exactly {state, model, questions} to /v1/systemone', () => {
  const q = { a: { type: 'noul', instructions: 'x' } };
  const r = buildAsk({ state: { ticket: { body: 'hi' } }, questions: q, model: MODEL });
  assert.equal(r.url, 'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(JSON.parse(r.body), { state: { ticket: { body: 'hi' } }, model: MODEL, questions: q });
  assert.equal(r.stateBytes, Buffer.byteLength('{"ticket":{"body":"hi"}}'));
});

test('state: .json files and JSON on stdin go structured, anything else as a string', () => {
  assert.deepEqual(stateFrom('{"a":1}', 'x.json'), { a: 1 });
  assert.deepEqual(stateFrom(' [1,2]', '-'), [1, 2]);
  assert.equal(stateFrom('{"a":1}', 'notes.txt'), '{"a":1}');
  assert.equal(stateFrom('plain text', '-'), 'plain text');
  assert.throws(() => stateFrom('{nope', 'x.json'), /not valid JSON/);
});

// ---- egress guard -------------------------------------------------------------

test('credential-shaped state files are refused, by name and by location', () => {
  const dir = tmp();
  const home = path.join(dir, 'home');
  for (const name of ['.env', '.env.local', 'api.key', 'cert.pem', 'id_ed25519', '.npmrc', 'credentials.json']) {
    const f = path.join(dir, name);
    writeFileSync(f, 'x');
    assert.throws(() => assertStatePath(f, { home }), /named like a credential file/, name);
  }
  mkdirSync(path.join(home, '.config', 'toolbelt'), { recursive: true });
  const inStore = path.join(home, '.config', 'toolbelt', 'notes.txt');
  writeFileSync(inStore, 'x');
  assert.throws(() => assertStatePath(inStore, { home }), /under ~\/\.config\/toolbelt/);
  const link = path.join(dir, 'innocent.txt');
  fs.symlinkSync(inStore, link);
  assert.throws(() => assertStatePath(link, { home }), /under ~\/\.config\/toolbelt/, 'symlinks are resolved first');
  const ok = path.join(dir, 'ticket.json');
  writeFileSync(ok, '{}');
  assert.equal(assertStatePath(ok, { home }), fs.realpathSync(ok));
});

// ---- credential (SENSIBILITIES #11) -------------------------------------------

test('key precedence: env, then key file, then .env; placeholder counts as absent', () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'k');
  const envFile = path.join(dir, '.env');
  assert.deepEqual(resolveKey({ env: {}, keyFile, envFile }), { key: null, source: 'none' });
  writeFileSync(envFile, 'TYPESAFE_API_KEY=your_typesafe_api_key_here\n');
  chmodSync(envFile, 0o600);
  assert.equal(resolveKey({ env: {}, keyFile, envFile }).key, null);
  writeFileSync(envFile, 'export TYPESAFE_API_KEY="from-dotenv"\n'); // pragma: allowlist secret
  assert.deepEqual(resolveKey({ env: {}, keyFile, envFile }), { key: 'from-dotenv', source: '.env' });
  writeFileSync(keyFile, 'from-file\n');
  chmodSync(keyFile, 0o600);
  assert.deepEqual(resolveKey({ env: {}, keyFile, envFile }), { key: 'from-file', source: 'key file' });
  assert.deepEqual(resolveKey({ env: { TYPESAFE_API_KEY: ' from-env ' }, keyFile, envFile }), { key: 'from-env', source: '$TYPESAFE_API_KEY' });
});

test('a group/world-readable key file is refused, not read', () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'k');
  writeFileSync(keyFile, 'secret');
  chmodSync(keyFile, 0o644);
  assert.throws(() => resolveKey({ env: {}, keyFile, envFile: path.join(dir, 'none') }), /chmod 600/);
});

// ---- pre-flight, rendering and audit --------------------------------------------

test('--explain never shows the key and says no call was made', () => {
  const q = { a: { type: 'noul', instructions: 'x' } };
  const req = buildAsk({ state: 'hello', questions: q, model: MODEL });
  const text = renderExplain(req, { model: MODEL, questions: q }, 'key file');
  assert.match(text, /Bearer \*\*\*/);
  assert.match(text, /no call made/);
  assert.match(text, /questions=\[a:noul\]/);
  assert.doesNotMatch(text, /hello/, 'the state itself is summarized, not printed');
});

test('the audit line carries counts and ids, never state, instructions or answers', () => {
  const line = auditLine({ verb: 'ask', status: 200, model: MODEL, questions: ['is_urgent', 'team'], stateBytes: 99, inputTokens: 420 });
  assert.match(line, /^\[jev audit\] \S+ verb=ask status=200 model=jev-1\.13\.0 questions=is_urgent,team state_bytes=99 input_tokens=420 cost_usd=0\.000018$/);
});

test('usage sums successful asks, counts failures, and honors --days', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const log = [
    '[jev audit] 2026-09-27T11:00:00.000Z verb=ask status=200 model=jev-1.13.0 questions=a state_bytes=10 input_tokens=300 cost_usd=0.000013',
    '[jev audit] 2026-09-27T11:05:00.000Z verb=ask status=400 model=jev-9 questions=a state_bytes=2 error="x"',
    '[jev audit] 2026-09-01T11:00:00.000Z verb=ask status=200 model=jev-1.13.0 questions=a state_bytes=10 input_tokens=700 cost_usd=0.000029',
    '[jev audit] 2026-09-27T11:06:00.000Z verb=models status=200',
  ].join('\n');
  const all = summarizeAudit(log, { now });
  assert.equal(all.calls, 2);
  assert.equal(all.failed, 1);
  assert.equal(all.inputTokens, 1000);
  assert.equal(all.costUsd, costUsd(1000));
  const week = summarizeAudit(log, { days: 7, now });
  assert.equal(week.calls, 1);
  assert.equal(week.inputTokens, 300);
});

test('retry delay honors retry-after-ms, then retry-after, then backs off — capped', () => {
  const h = (o) => new Headers(o);
  assert.equal(retryDelayMs(h({ 'retry-after-ms': '250' }), 0), 250);
  assert.equal(retryDelayMs(h({ 'retry-after': '2' }), 0), 2000);
  assert.equal(retryDelayMs(h({ 'retry-after': '3600' }), 0), 30_000);
  assert.equal(retryDelayMs(h({}), 0), 500);
  assert.equal(retryDelayMs(h({}), 2), 2000);
});

test('answers render per type with the cost footer', () => {
  const out = renderAnswers({
    model: 'jev-1.13.0',
    answers: {
      u: { type: 'noul', noul: 0.95 },
      d: { type: 'choice', choice: 'billing', confidence: 0.82, probabilities: { technical: 0.13, billing: 0.87 } },
      f: { type: 'score', score: 1.04, confidence: 0.93, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0, 1: 0.96, 2: 0.04 } },
    },
    usage: { input_tokens: 417, output_tokens: 80 },
  });
  assert.match(out, /u  noul 0\.95/);
  assert.match(out, /d  choice billing  confidence 0\.82  \[billing 87% · technical 13%\]/);
  assert.match(out, /f  score 1\.04 ≈ "Frustrated"/);
  assert.match(out, /417 input tokens · \$0\.000018/);
});

// ---- manifest honesty -----------------------------------------------------------

test("manifest verbs[] matches the code's VERBS table", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../toolbelt.json', import.meta.url), 'utf8'));
  const claimed = Object.fromEntries(manifest.verbs.filter((v) => v.tier !== 'never').map((v) => [v.name.split(' ')[0], { tier: v.tier, ...(v.gate ? { gate: v.gate } : {}) }]));
  assert.deepEqual(claimed, VERBS);
});
