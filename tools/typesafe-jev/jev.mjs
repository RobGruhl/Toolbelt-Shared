#!/usr/bin/env node
// jev — typed judgments from TypeSafe's Jev model (api.typesafe.ai), on the operator's own key.
//
// Every verb is a read: an evaluation changes nothing anywhere. What an `ask` does cost is money
// (per input token) and egress (the state leaves this machine), so the patterns that bind are
// the spend ones:
//   #3  ceilings are code constants (MAX_STATE_BYTES, MAX_QUESTIONS, MAX_REQUEST_BYTES, the
//       option and level bounds) — a request over one is refused before anything is sent
//   #5  --explain renders the exact request (state summarized, key redacted) and its cost
//       estimate, and makes no call
//   #7  one audit line per call on stderr, and per ask in audit.log: model, question ids,
//       state bytes, input tokens, cost — never the state, the questions or the answers
//   #8  401/403/400/422 each get a plain sentence; 408/429/5xx retry with backoff, honoring
//       retry-after, at most MAX_ATTEMPTS times
//   #11 the key comes from $TYPESAFE_API_KEY, a 600-mode key file or the gitignored .env;
//       it travels only as the Bearer header — never printed, logged or placed on argv
//
// Usage:
//   jev models                                       names the key may send in `model`
//   jev ask (--state <file|-> | --text <s>) (--questions <file> | --noul <q> |
//           --choice <q> --options a,b,c | --score <q> --levels "L0|L1|L2")
//           [--id <name>] [--model <id>] [--json] [--explain]
//   jev usage [--days N]                             calls, input tokens and cost from audit.log
//
// Exit codes: 0 ok · 1 auth, network or API failure · 2 bad usage or a ceiling

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---- ceilings (code constants — SENSIBILITIES #3) -----------------------------------------
// Raising one is a reviewed diff, not an argument an agent can pass on a bad day.
export const API = 'https://api.typesafe.ai/v1';
export const MODEL = 'jev-1.13.0';            // pinned: an alias move must not shift tuned thresholds
export const MAX_STATE_BYTES = 96_000;        // ≈24k tokens, inside the 32k state+longest-question budget
export const MAX_REQUEST_BYTES = 200_000;     // ≈50k tokens, inside the 64k per-request budget
export const MAX_QUESTIONS = 32;
export const MAX_OPTIONS = 255;               // the API's own Choice limit
export const MIN_LEVELS = 2;                  // the API accepts one level and bills a meaningless answer
export const MAX_LEVELS = 10;                 // the API's own Score limit
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const MAX_RETRY_WAIT_MS = 30_000;
export const USD_PER_MTOK = 0.042;            // jev-1.13.0, input tokens only; output is free
export const BYTES_PER_TOKEN = 4;             // estimate for --explain; the response reports the real count

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KEY_FILE = path.join(homedir(), '.config', 'toolbelt', 'typesafe-jev.key');
export const ENV_FILE = path.join(HERE, '.env');
const AUDIT_HOME = process.env.TYPESAFE_JEV_HOME || path.join(homedir(), '.local', 'share', 'typesafe-jev');
export const AUDIT_FILE = path.join(AUDIT_HOME, 'audit.log');
const VERSION = '0.1.0';

/** The tier of every verb. The test suite asserts toolbelt.json's verbs[] matches this table. */
export const VERBS = {
  models: { tier: 'read' },
  ask: { tier: 'read' },
  usage: { tier: 'read' },
};

function fail(msg, code = 1) {
  console.error(`jev: ${msg}`);
  process.exit(code);
}

// ---- credential (SENSIBILITIES #11) -------------------------------------------------------

function assertPrivate(file, st) {
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${file} is group/world readable — chmod 600 it first (jev refuses to read a loose-permission key file)`);
  }
}

/**
 * $TYPESAFE_API_KEY (the name the official SDKs read), else the 600-mode key file, else the
 * gitignored tools/typesafe-jev/.env. The .env.example placeholder counts as absent.
 */
export function resolveKey({ env = process.env, keyFile = KEY_FILE, envFile = ENV_FILE } = {}) {
  const fromEnv = (env.TYPESAFE_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: '$TYPESAFE_API_KEY' };
  for (const [file, source] of [[keyFile, 'key file'], [envFile, '.env']]) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    assertPrivate(file, st);
    const text = fs.readFileSync(file, 'utf8');
    const key = source === '.env'
      ? (/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*['"]?([^'"\s#]+)/m.exec(text)?.[1] ?? '')
      : text.trim();
    if (key && !key.startsWith('your_')) return { key, source };
  }
  return { key: null, source: 'none' };
}

// ---- egress guard -------------------------------------------------------------------------

const SECRET_NAMES = [/^\.env(\..*)?$/, /\.(key|pem|p12|pfx|keychain)$/i, /^id_[a-z0-9]+/, /^\.netrc$/, /^\.npmrc$/, /^credentials(\.json)?$/i];
const SECRET_DIRS = ['.ssh', '.gnupg', '.aws', path.join('.config', 'toolbelt')];

/**
 * State leaves the machine, so a state file must be one the operator named and not a
 * credential store. Refused by name (.env, *.key, *.pem, id_*, .netrc, .npmrc, credentials)
 * and by location (~/.ssh, ~/.gnupg, ~/.aws, ~/.config/toolbelt), after resolving symlinks.
 */
export function assertStatePath(file, { home = homedir() } = {}) {
  let real;
  try { real = fs.realpathSync(file); } catch { throw new Error(`cannot read state file ${file}`); }
  const base = path.basename(real);
  if (SECRET_NAMES.some((re) => re.test(base))) {
    throw new Error(`refusing to send ${file} as state — it is named like a credential file`);
  }
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch { /* a home that does not exist protects nothing extra */ }
  for (const d of SECRET_DIRS) {
    const dir = path.join(realHome, d) + path.sep;
    if (real.startsWith(dir)) throw new Error(`refusing to send ${file} as state — it is under ~/${d}`);
  }
  return real;
}

// ---- questions ----------------------------------------------------------------------------

function nonEmpty(v) {
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && typeof v === 'object' && Object.keys(v).length > 0;
}

/**
 * Validate a questions map against the documented schema and this tool's ceilings. Throws a
 * usage error naming the question and the rule; the caller maps that to exit 2.
 */
export function validateQuestions(questions) {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new Error('questions must be a JSON object mapping an id to a question');
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error('no questions');
  if (ids.length > MAX_QUESTIONS) {
    throw new Error(`${ids.length} questions exceeds the ${MAX_QUESTIONS} ceiling (MAX_QUESTIONS in jev.mjs)`);
  }
  for (const id of ids) {
    const q = questions[id];
    const where = `question "${id}"`;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw new Error(`${where}: ids are [A-Za-z0-9_.-], at most 64 characters`);
    if (q === null || typeof q !== 'object') throw new Error(`${where}: must be an object`);
    if (!nonEmpty(q.instructions)) throw new Error(`${where}: instructions are required`);
    if (q.type === 'noul') {
      if (q.criteria !== undefined) {
        if (q.criteria === null || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) throw new Error(`${where}: noul criteria is an object with "true" and/or "false"`);
        const extra = Object.keys(q.criteria).filter((k) => k !== 'true' && k !== 'false');
        if (extra.length) throw new Error(`${where}: noul criteria takes only "true" and "false", not ${extra.join(', ')}`);
      }
    } else if (q.type === 'choice') {
      if (q.criteria === null || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) throw new Error(`${where}: choice criteria is an object mapping each option to a description or null`);
      const n = Object.keys(q.criteria).length;
      if (n < 2) throw new Error(`${where}: a choice needs at least 2 options — add a no-match option when nothing may fit`);
      if (n > MAX_OPTIONS) throw new Error(`${where}: ${n} options exceeds the API's ${MAX_OPTIONS}`);
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria)) throw new Error(`${where}: score criteria is an ordered array of level descriptions`);
      const n = q.criteria.length;
      if (n < MIN_LEVELS || n > MAX_LEVELS) throw new Error(`${where}: a score takes ${MIN_LEVELS}–${MAX_LEVELS} levels, got ${n}`);
    } else {
      throw new Error(`${where}: type must be noul, choice or score, got ${JSON.stringify(q.type)}`);
    }
  }
  return questions;
}

// ---- argument parsing (pure, exported for tests) ------------------------------------------

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      state: { type: 'string' },
      text: { type: 'string' },
      questions: { type: 'string' },
      noul: { type: 'string' },
      choice: { type: 'string' },
      options: { type: 'string' },
      score: { type: 'string' },
      levels: { type: 'string' },
      id: { type: 'string', default: 'q' },
      model: { type: 'string' },
      days: { type: 'string' },
      json: { type: 'boolean', default: false },
      explain: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  if (values.version) return { version: true };
  const [verb, ...rest] = positionals;
  if (!verb) throw new Error('no verb — one of: ' + Object.keys(VERBS).join(', '));
  if (!VERBS[verb]) throw new Error(`unknown verb "${verb}" — one of: ${Object.keys(VERBS).join(', ')}`);
  if (rest.length) throw new Error(`unexpected argument "${rest[0]}"`);

  if (verb === 'models') return { verb, json: values.json, explain: values.explain };
  if (verb === 'usage') {
    let days = null;
    if (values.days !== undefined) {
      if (!/^\d+$/.test(values.days) || +values.days < 1) throw new Error('--days must be a positive integer');
      days = +values.days;
    }
    return { verb, days, json: values.json };
  }

  // ask
  if ((values.state === undefined) === (values.text === undefined)) throw new Error('ask needs exactly one of --state <file|-> or --text <string>');
  const inline = ['noul', 'choice', 'score'].filter((k) => values[k] !== undefined);
  if ((values.questions === undefined ? 0 : 1) + inline.length !== 1) {
    throw new Error('ask needs exactly one of --questions <file>, --noul, --choice or --score');
  }
  if (values.options !== undefined && !values.choice) throw new Error('--options goes with --choice');
  if (values.levels !== undefined && !values.score) throw new Error('--levels goes with --score');
  let question = null;
  if (values.noul) question = { type: 'noul', instructions: values.noul };
  if (values.choice) {
    if (!values.options) throw new Error('--choice needs --options a,b,c');
    const opts = values.options.split(',').map((s) => s.trim()).filter(Boolean);
    question = { type: 'choice', instructions: values.choice, criteria: Object.fromEntries(opts.map((o) => [o, null])) };
  }
  if (values.score) {
    if (!values.levels) throw new Error('--score needs --levels "L0|L1|L2"');
    question = { type: 'score', instructions: values.score, criteria: values.levels.split('|').map((s) => s.trim()).filter(Boolean) };
  }
  const model = values.model ?? MODEL;
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(model)) throw new Error(`--model "${model}" is not a model id`);
  return {
    verb, model, json: values.json, explain: values.explain,
    statePath: values.state ?? null, text: values.text ?? null,
    questionsPath: values.questions ?? null, question, id: values.id,
  };
}

// ---- request construction (pure) ----------------------------------------------------------

/** Parse state text: a .json file (or JSON on stdin) is sent structured, anything else as a string. */
export function stateFrom(raw, name) {
  const looksJson = name.endsWith('.json') || (name === '-' && /^\s*[[{]/.test(raw));
  if (!looksJson) return raw;
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${name}: not valid JSON (${e.message})`); }
}

/** The exact body an ask sends, after every ceiling has been checked. */
export function buildAsk({ state, questions, model }) {
  validateQuestions(questions);
  const stateBytes = Buffer.byteLength(typeof state === 'string' ? state : JSON.stringify(state));
  if (stateBytes === 0) throw new Error('state is empty');
  if (stateBytes > MAX_STATE_BYTES) {
    throw new Error(`state is ${stateBytes} bytes, over the ${MAX_STATE_BYTES} ceiling (MAX_STATE_BYTES in jev.mjs) — split it, or send the relevant part`);
  }
  const body = JSON.stringify({ state, model, questions });
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > MAX_REQUEST_BYTES) {
    throw new Error(`request is ${bodyBytes} bytes, over the ${MAX_REQUEST_BYTES} ceiling (MAX_REQUEST_BYTES in jev.mjs) — fewer or shorter questions`);
  }
  return { url: `${API}/systemone`, body, stateBytes, bodyBytes };
}

export function costUsd(inputTokens) {
  return (inputTokens / 1e6) * USD_PER_MTOK;
}

/** The --explain text (SENSIBILITIES #5): what would be sent, what it would cost, and no call. */
export function renderExplain(req, { model, questions }, keySource) {
  const estTokens = Math.ceil(req.bodyBytes / BYTES_PER_TOKEN);
  const qs = Object.entries(questions).map(([id, q]) => `${id}:${q.type}`).join(', ');
  return [
    `would POST ${req.url}`,
    '  Authorization: Bearer ***',
    '  Content-Type: application/json',
    `model=${model} questions=[${qs}]`,
    `state ${req.stateBytes} bytes (ceiling ${MAX_STATE_BYTES}) · request ${req.bodyBytes} bytes (ceiling ${MAX_REQUEST_BYTES})`,
    `≈${estTokens} input tokens ≈ $${costUsd(estTokens).toFixed(6)} at $${USD_PER_MTOK}/Mtok (estimate; the response reports the real count)`,
    `key: ${keySource === 'none' ? 'none found — the call would fail' : `found (${keySource})`}`,
    'no call made',
  ].join('\n');
}

// ---- audit (SENSIBILITIES #7) -------------------------------------------------------------

export function auditLine(f) {
  const parts = [`[jev audit] ${new Date().toISOString()}`, `verb=${f.verb}`, `status=${f.status}`];
  if (f.model) parts.push(`model=${f.model}`);
  if (f.questions) parts.push(`questions=${f.questions.join(',')}`);
  if (f.stateBytes != null) parts.push(`state_bytes=${f.stateBytes}`);
  if (f.inputTokens != null) parts.push(`input_tokens=${f.inputTokens}`, `cost_usd=${costUsd(f.inputTokens).toFixed(6)}`);
  if (f.error) parts.push(`error=${JSON.stringify(f.error)}`);
  return parts.join(' ');
}

function audit(line, { file = true } = {}) {
  process.stderr.write(line + '\n');
  if (!file) return;
  try {
    fs.mkdirSync(AUDIT_HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_FILE, line + '\n', { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[jev] audit log not written (${e.message}); the stderr line above is the record\n`);
  }
}

/** Sum ask lines from the audit log, optionally over the last N days. */
export function summarizeAudit(text, { days = null, now = Date.now() } = {}) {
  const since = days ? now - days * 86_400_000 : -Infinity;
  const out = { calls: 0, failed: 0, inputTokens: 0, costUsd: 0, models: {} };
  for (const line of text.split('\n')) {
    const m = /^\[jev audit\] (\S+) verb=ask status=(\S+)(.*)$/.exec(line);
    if (!m || Date.parse(m[1]) < since) continue;
    const tokens = /input_tokens=(\d+)/.exec(m[3]);
    if (m[2] !== '200') { out.failed += 1; continue; }
    out.calls += 1;
    const model = /model=(\S+)/.exec(m[3])?.[1] ?? 'unknown';
    out.models[model] = (out.models[model] ?? 0) + 1;
    if (tokens) out.inputTokens += +tokens[1];
  }
  out.costUsd = costUsd(out.inputTokens);
  return out;
}

// ---- the one network path -----------------------------------------------------------------

export function retryDelayMs(headers, attempt) {
  const ms = Number(headers?.get?.('retry-after-ms'));
  if (headers?.has?.('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_RETRY_WAIT_MS);
  const s = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(s) && s >= 0 && headers?.has?.('retry-after')) return Math.min(s * 1000, MAX_RETRY_WAIT_MS);
  return Math.min(500 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

function explainStatus(status, body) {
  const msg = body?.detail?.message ?? (typeof body?.detail === 'string' ? body.detail : null);
  if (status === 401) return 'key rejected (HTTP 401) — revoked or mistyped; create a new one in the TypeSafe account';
  if (status === 403) return 'no key reached the API (HTTP 403) — set TYPESAFE_API_KEY or write the key file (see CLAUDE.md)';
  if (status === 400) return `request refused (HTTP 400)${msg ? `: ${msg}` : ''}`;
  if (status === 422) return `request failed validation (HTTP 422)${body?.detail ? `: ${JSON.stringify(body.detail).slice(0, 400)}` : ''}`;
  if (status === 429) return `rate limited (HTTP 429) after ${MAX_ATTEMPTS} attempts — the vendor's limits move without notice; wait and retry`;
  if (status === 529) return `TypeSafe is overloaded (HTTP 529) after ${MAX_ATTEMPTS} attempts — retry later`;
  return `TypeSafe HTTP ${status}${msg ? `: ${msg}` : ''}`;
}

async function call(method, url, key, body = null) {
  let lastStatus = 0;
  let lastBody = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': `jev/${VERSION}` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS / 1000}s` : (e.cause?.code ?? e.message);
      return { ok: false, status: 0, error: `cannot reach api.typesafe.ai (${why}) — online? proxy or network policy allowing the host?` };
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { /* non-JSON: a proxy page or an empty body */ }
    if (res.ok) return { ok: true, status: res.status, body: parsed };
    lastStatus = res.status;
    lastBody = parsed;
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS - 1) break;
    await new Promise((r) => setTimeout(r, retryDelayMs(res.headers, attempt)));
  }
  return { ok: false, status: lastStatus, error: explainStatus(lastStatus, lastBody) };
}

// ---- rendering ----------------------------------------------------------------------------

const pct = (p) => `${(p * 100).toFixed(0)}%`;

export function renderAnswers(res) {
  const lines = [];
  for (const [id, a] of Object.entries(res.answers ?? {})) {
    if (a.type === 'noul') {
      lines.push(`${id}  noul ${a.noul.toFixed(2)}  (${a.noul >= 0.5 ? 'yes' : 'no'}-leaning; 0.5 means undecided, not "medium")`);
    } else if (a.type === 'choice') {
      const dist = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([k, p]) => `${k} ${pct(p)}`).join(' · ');
      lines.push(`${id}  choice ${a.choice}  confidence ${a.confidence.toFixed(2)}  [${dist}]`);
    } else if (a.type === 'score') {
      const nearest = a.legend[String(Math.round(a.score))];
      lines.push(`${id}  score ${a.score.toFixed(2)} ≈ "${nearest}"  confidence ${a.confidence.toFixed(2)}  [${Object.entries(a.probabilities).map(([k, p]) => `${k} ${pct(p)}`).join(' · ')}]`);
    } else {
      lines.push(`${id}  ${JSON.stringify(a)}`);
    }
  }
  const tokens = res.usage?.input_tokens;
  lines.push('', `model ${res.model} · ${tokens ?? '?'} input tokens${tokens != null ? ` · $${costUsd(tokens).toFixed(6)}` : ''}`);
  return lines.join('\n');
}

// ---- main ---------------------------------------------------------------------------------

function usage() {
  return [
    'usage: jev models [--json]',
    '       jev ask (--state <file|-> | --text <s>) (--questions <file> | --noul <q> |',
    '               --choice <q> --options a,b,c | --score <q> --levels "L0|L1|L2")',
    '               [--id <name>] [--model <id>] [--json] [--explain]',
    '       jev usage [--days N] [--json]',
    `ceilings: state ${MAX_STATE_BYTES} B · request ${MAX_REQUEST_BYTES} B · ${MAX_QUESTIONS} questions · ${MAX_OPTIONS} options · ${MIN_LEVELS}–${MAX_LEVELS} levels · model pinned ${MODEL}`,
    'key: $TYPESAFE_API_KEY, else ~/.config/toolbelt/typesafe-jev.key, else tools/typesafe-jev/.env (mode 600)',
    'exit: 0 ok · 1 auth/network/API failure · 2 bad usage or a ceiling',
  ].join('\n');
}

function readInput(p) {
  if (p === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(assertStatePath(p), 'utf8');
}

async function run() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`jev: ${e.message}\n${usage()}`);
    process.exit(2);
  }
  if (cli.help) { console.log(usage()); return; }
  if (cli.version) { console.log(`jev ${VERSION}`); return; }

  if (cli.verb === 'usage') {
    let text = '';
    try { text = fs.readFileSync(AUDIT_FILE, 'utf8'); } catch { /* no calls yet */ }
    const s = summarizeAudit(text, { days: cli.days });
    if (cli.json) { console.log(JSON.stringify(s, null, 2)); return; }
    const span = cli.days ? `last ${cli.days} day(s)` : 'all time';
    console.log(`${s.calls} ask call(s), ${s.failed} failed · ${s.inputTokens} input tokens · $${s.costUsd.toFixed(6)} (${span}, from ${AUDIT_FILE})`);
    for (const [m, n] of Object.entries(s.models)) console.log(`  ${m}  ${n}`);
    return;
  }

  let keyInfo;
  try { keyInfo = resolveKey(); } catch (e) { fail(e.message); }

  if (cli.verb === 'models') {
    if (cli.explain) { console.log(`would GET ${API}/models\n  Authorization: Bearer ***\nfree: runs no inference\nno call made`); return; }
    if (!keyInfo.key) fail(`no key — set TYPESAFE_API_KEY, or write ${KEY_FILE} (chmod 600)`);
    const r = await call('GET', `${API}/models`, keyInfo.key);
    audit(auditLine({ verb: 'models', status: r.status, error: r.error }), { file: false });
    if (!r.ok) fail(r.error);
    if (cli.json) { console.log(JSON.stringify(r.body, null, 2)); return; }
    for (const m of r.body.models ?? []) console.log(`${m.name.padEnd(14)} ${String(m.release_date).slice(0, 10)}  ${m.description}`);
    console.log(`\njev asks pin ${MODEL}; pass --model to use another`);
    return;
  }

  // ask
  let req;
  let questions;
  try {
    const stateRaw = cli.statePath ? readInput(cli.statePath) : cli.text;
    const state = cli.statePath ? stateFrom(stateRaw, cli.statePath) : stateRaw;
    questions = cli.questionsPath
      ? JSON.parse(fs.readFileSync(cli.questionsPath, 'utf8'))
      : { [cli.id]: cli.question };
    req = buildAsk({ state, questions, model: cli.model });
  } catch (e) {
    fail(e.message, 2);
  }
  if (cli.explain) { console.log(renderExplain(req, { model: cli.model, questions }, keyInfo.source)); return; }
  if (!keyInfo.key) fail(`no key — set TYPESAFE_API_KEY, or write ${KEY_FILE} (chmod 600)`);

  const r = await call('POST', req.url, keyInfo.key, req.body);
  audit(auditLine({
    verb: 'ask', status: r.status, model: r.body?.model ?? cli.model, questions: Object.keys(questions),
    stateBytes: req.stateBytes, inputTokens: r.body?.usage?.input_tokens, error: r.error,
  }));
  if (!r.ok) fail(r.error);
  if (cli.json) { console.log(JSON.stringify(r.body, null, 2)); return; }
  console.log(renderAnswers(r.body));
}

// Run only when invoked directly, so the pure helpers stay importable by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  run().catch((e) => fail(`internal: ${e.message}`, 1));
}
