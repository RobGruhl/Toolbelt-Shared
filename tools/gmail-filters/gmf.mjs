#!/usr/bin/env node
// gmf — gmail-filters. Turns triage evidence about senders into proposed Gmail filters the
// operator reviews, then exports the approved ones as Gmail's importable mailFilters.xml.
//
// gmf has no Gmail write code and holds no credential. It reads local evidence files, writes
// local files, and (only with `plan --live`) shells out to the read-only `gmh list`. The one
// outbound write is `unsubscribe`: an RFC 8058 one-click POST to each sender the operator
// approved, gated on a --yes the operator supplies after reading the preview. The
// patterns, marked with their SENSIBILITIES.md number:
//   #1  no Gmail write — no Gmail API client, no OAuth, no write scope; network paths are
//       `gmh list` (gmail.readonly) behind --live, and `unsubscribe --yes` (senders' own
//       List-Unsubscribe https endpoints, no cookies, no credential, redirects not followed)
//   #3  ceilings are exported code constants (MAX_FILTERS, MIN_EVIDENCE, MIN_EVIDENCE_FLOOR)
//   #5  `plan` is itself the dry run: nothing reaches Gmail until a human imports the XML;
//       `export --explain` shows what would be written and writes nothing
//   #7  one audit line per verb run, to stderr and a 600-mode log — counts, never content
//   #8  plain sentences and exit codes; a failed --live call degrades to evidence-only counts
//   #11 the operator's sender policy lives outside the tree in a 600-mode file
//
// The safety guarantee: a sender is proposed only when EVERY observed message from it landed
// in a zero-touch bucket (cleanup, auto_handled). One message in any other bucket blocks it.
//
// Exit codes: 0 ok · 1 input, plan or --live failure · 2 bad usage (including a refused path)

import { parseArgs } from 'node:util';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- ceilings (code constants — SENSIBILITIES #3) ---------------------------
// Raising one is a reviewed diff, not an argument an agent can pass on a bad day.
export const MAX_FILTERS = 200;          // proposals per plan; rows past it are counted, not kept
export const MIN_EVIDENCE = 3;           // default --min: messages a sender needs before a proposal
export const MIN_EVIDENCE_FLOOR = 2;     // --min below this is refused
export const SAMPLE_IDS = 3;             // sample_message_ids per row
export const LIVE_WINDOW = '90d';        // --live counts matches with newer_than:<window>
export const LIVE_MAX = 500;             // --max passed to `gmh list`; a count at it is reported as "≥"
export const LIVE_TIMEOUT_MS = 120_000;  // per gmh call
export const ZERO_TOUCH = Object.freeze(['cleanup', 'auto_handled']);
export const PLAN_SCHEMA = 'gmail-filters.plan/1';
export const DEFAULT_LABELS = Object.freeze({ cleanup: 'Promo', auto_handled: 'Receipts' });
export const ACTION_KEYS = Object.freeze(['addLabel', 'archive', 'markRead', 'neverSpam', 'trash']);
export const MATCH_KEYS = Object.freeze(['from', 'hasTheWord']);
export const UNSUB_SCHEMA = 'gmail-filters.unsubscribe/1';
export const MAX_UNSUB = 100;            // one-click POSTs per run; a longer approval list is refused
export const UNSUB_TIMEOUT_MS = 15_000;  // per POST
export const UNSUB_DELAY_MS = 300;       // between POSTs

// ---- fixed paths --------------------------------------------------------------
export const POLICY_PATH = path.join(homedir(), '.config', 'toolbelt', 'gmail-filters', 'policy.json');
export const AUDIT_DIR = path.join(homedir(), '.local', 'share', 'toolbelt', 'gmail-filters');
export const AUDIT_LOG = path.join(AUDIT_DIR, 'audit.log');
export const VERBS = ['plan', 'export', 'show', 'unsub-plan', 'unsubscribe'];
const VERSION = '0.1.0';
const SELF = realpathSync(fileURLToPath(import.meta.url));
const BELT_ROOT = path.resolve(path.dirname(SELF), '..', '..');
export const DEFAULT_GMH = path.join(BELT_ROOT, 'tools', 'gmail-harvest', 'gmh.mjs');

/** A failure with a plain sentence and an exit code. */
export class GmfError extends Error {
  constructor(message, { code = 1 } = {}) {
    super(message);
    this.exitCode = code;
  }
}
const usageError = (msg) => new GmfError(msg, { code: 2 });

// ---- argument parsing (pure, exported for tests) ----------------------------

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        evidence: { type: 'string', short: 'e', multiple: true },
        min: { type: 'string' },
        out: { type: 'string', short: 'o' },
        plan: { type: 'string', short: 'p' },
        approved: { type: 'string' },
        mail: { type: 'string', multiple: true },
        senders: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'follow-redirects': { type: 'boolean', default: false },
        policy: { type: 'string' },
        live: { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    throw usageError(e.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) return { help: true };
  if (v.version) return { version: true };
  const [verb, ...extra] = positionals;
  if (!verb) throw usageError(`no verb — one of: ${VERBS.join(', ')}`);
  if (!VERBS.includes(verb)) throw usageError(`unknown verb "${verb}" — one of: ${VERBS.join(', ')} (gmf has no Gmail write verbs)`);
  const allowed = {
    plan: ['evidence', 'min', 'out', 'policy', 'live'],
    export: ['plan', 'out', 'explain'],
    show: ['plan', 'json'],
    unsubscribe: ['approved', 'yes', 'follow-redirects'],
    'unsub-plan': ['mail', 'senders', 'out'],
  }[verb];
  for (const k of ['evidence', 'min', 'out', 'plan', 'policy', 'live', 'explain', 'json', 'approved', 'yes', 'follow-redirects', 'mail', 'senders']) {
    const set = v[k] !== undefined && v[k] !== false;
    if (set && !allowed.includes(k)) throw usageError(`--${k} does not apply to ${verb}`);
  }
  const cli = { verb, live: v.live, explain: v.explain, json: v.json, out: v.out ?? null, policy: v.policy ?? null };
  if (verb === 'plan') {
    // `--evidence a.jsonl b.jsonl` and repeated `--evidence` both work: trailing positionals are files.
    cli.evidence = [...(v.evidence ?? []), ...extra];
    if (!cli.evidence.length) throw usageError('plan needs --evidence FILE... (JSONL, one record per message)');
    cli.min = clampMin(v.min);
  } else if (verb === 'unsub-plan') {
    cli.mail = [...(v.mail ?? []), ...extra];
    if (!cli.mail.length) throw usageError('unsub-plan needs --mail DIR... (gmh export directories)');
    if (!v.senders) throw usageError('unsub-plan needs --senders FILE (JSON [{sender}] or one address per line)');
    if (!v.out) throw usageError('unsub-plan needs --out candidates.json');
    cli.senders = v.senders;
  } else if (verb === 'unsubscribe') {
    if (extra.length) throw usageError(`unexpected argument "${extra[0]}"`);
    if (!v.approved) throw usageError('unsubscribe needs --approved approved.json (the operator\'s approval list)');
    cli.approved = v.approved;
    cli.yes = v.yes;
    cli.followRedirects = v['follow-redirects'];
  } else {
    if (extra.length) throw usageError(`unexpected argument "${extra[0]}"`);
    if (!v.plan) throw usageError(`${verb} needs --plan plan.json`);
    cli.plan = v.plan;
    if (verb === 'export' && !cli.out && !cli.explain) throw usageError('export needs --out mailFilters.xml (or --explain to preview)');
  }
  return cli;
}

/** --min: absent → MIN_EVIDENCE; below MIN_EVIDENCE_FLOOR → refused, never raised silently. */
export function clampMin(raw) {
  if (raw === undefined) return MIN_EVIDENCE;
  if (!/^\d+$/.test(String(raw))) throw usageError(`--min must be a positive integer, got "${raw}"`);
  const n = parseInt(raw, 10);
  if (n < MIN_EVIDENCE_FLOOR) {
    throw usageError(`--min ${n} is below the floor of ${MIN_EVIDENCE_FLOOR} (MIN_EVIDENCE_FLOOR, a code constant in gmf.mjs) — one message is not evidence about a sender`);
  }
  return n;
}

// ---- evidence -----------------------------------------------------------------

/** The bare lowercase address from `a@b.c` or `Name <a@b.c>`; null when there is none. */
export function normalizeAddress(from) {
  if (typeof from !== 'string') return null;
  const angle = from.match(/<([^<>\s]+@[^<>\s]+)>/);
  const raw = (angle ? angle[1] : from).trim().toLowerCase();
  return /^[^\s@<>()"',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw : null;
}

export const hostOf = (addr) => addr.slice(addr.lastIndexOf('@') + 1);

// Second-level labels that sit under a country code and are not themselves registrable.
const MULTI_SUFFIX = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go']);

/**
 * The registrable domain, without a public-suffix list (zero dependencies): the last two labels,
 * or the last three when the TLD is a two-letter country code under a generic second level
 * (`mail.example.co.uk` → `example.co.uk`). Grouping only — criteria always name exact hosts.
 */
export function registrableDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const take = tld.length === 2 && MULTI_SUFFIX.has(sld) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/** List-Unsubscribe → {mailto?, https?}. Only mailto: and https: survive; null when neither. */
export function parseUnsubscribe(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const items = [...value.matchAll(/<([^<>]+)>/g)].map((m) => m[1].trim());
  if (!items.length) items.push(...value.split(',').map((s) => s.trim()));
  const out = {};
  for (const it of items) {
    if (!out.mailto && /^mailto:[^\s]+$/i.test(it)) out.mailto = it;
    else if (!out.https && /^https:\/\/[^\s]+$/i.test(it)) out.https = it;
  }
  return out.mailto || out.https ? out : null;
}

/**
 * Parse one JSONL evidence file. `_meta` lines are skipped; so are lines without a message id or
 * a parseable sender (counted). A record with a sender but no bucket is kept as bucket
 * "unclassified", which blocks — absence of a verdict is not a zero-touch verdict.
 */
export function parseEvidence(text, file = '<input>') {
  const stats = { lines: 0, meta: 0, malformed: 0, no_message_id: 0, no_sender: 0, records: 0 };
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    stats.lines++;
    let d;
    try { d = JSON.parse(line); } catch { stats.malformed++; continue; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) { stats.malformed++; continue; }
    if ('_meta' in d) { stats.meta++; continue; }
    if (typeof d.message_id !== 'string' || !d.message_id) { stats.no_message_id++; continue; }
    const sender = normalizeAddress(d.from);
    if (!sender) { stats.no_sender++; continue; }
    const bucket = typeof d.bucket === 'string' && d.bucket ? d.bucket : 'unclassified';
    records.push({
      message_id: d.message_id,
      thread_id: typeof d.thread_id === 'string' ? d.thread_id : null,
      sender,
      bucket,
      date: typeof d.date === 'string' ? d.date : null,
      list_unsubscribe: typeof d.list_unsubscribe === 'string' ? d.list_unsubscribe : null,
      file,
    });
    stats.records++;
  }
  return { records, stats };
}

// ---- policy (SENSIBILITIES #11) ---------------------------------------------

const LABEL_RE = /^[^/\s][^/]*(\/[^/\s][^/]*)*$/;
function assertLabel(label, where) {
  if (typeof label !== 'string' || !LABEL_RE.test(label) || label !== label.trim()) {
    throw new GmfError(`${where}: "${label}" is not a label name — use Title Case segments joined by "/", e.g. "Receipts/Uber"`);
  }
  return label;
}

/** Validate a policy object; returns it with defaults filled. Keys starting with "_" are comments. */
export function normalizePolicy(raw, where = 'policy') {
  const p = raw ?? {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new GmfError(`${where}: must be a JSON object`);
  for (const k of Object.keys(p)) {
    if (!k.startsWith('_') && !['labels', 'trash', 'protect'].includes(k)) throw new GmfError(`${where}: unknown key "${k}" (labels, trash, protect)`);
  }
  const labels = p.labels ?? {};
  for (const k of Object.keys(labels)) {
    if (!k.startsWith('_') && !['cleanup', 'auto_handled', 'auto_handled_by_domain'].includes(k)) {
      throw new GmfError(`${where}: unknown key "labels.${k}" (cleanup, auto_handled, auto_handled_by_domain)`);
    }
  }
  const byDomain = {};
  for (const [d, l] of Object.entries(labels.auto_handled_by_domain ?? {})) {
    if (d.startsWith('_')) continue;
    byDomain[d.toLowerCase().replace(/^@/, '')] = assertLabel(l, `${where}: labels.auto_handled_by_domain["${d}"]`);
  }
  const list = (k) => {
    const v = p[k] ?? [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) throw new GmfError(`${where}: "${k}" must be an array of addresses or domains`);
    return v.map((s) => s.trim().toLowerCase());
  };
  return {
    labels: {
      cleanup: assertLabel(labels.cleanup ?? DEFAULT_LABELS.cleanup, `${where}: labels.cleanup`),
      auto_handled: assertLabel(labels.auto_handled ?? DEFAULT_LABELS.auto_handled, `${where}: labels.auto_handled`),
      auto_handled_by_domain: byDomain,
    },
    trash: list('trash'),
    protect: list('protect'),
  };
}

/** Read the policy file. Absent → defaults. Group/world-readable → refused, not read. */
export function loadPolicy(file = POLICY_PATH) {
  if (!existsSync(file)) return { policy: normalizePolicy({}), source: null };
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new GmfError(`${file} is mode ${mode.toString(8)} — chmod 600 it first (the policy names senders; gmf refuses a loose-permission file)`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new GmfError(`${file}: not valid JSON (${e.message})`); }
  return { policy: normalizePolicy(raw, file), source: file };
}

/** A list entry is an exact address (`a@b.c`) or a domain (`b.c` / `@b.c`, subdomains included). */
export function listMatches(addr, list) {
  const host = hostOf(addr);
  return list.some((e) => {
    if (e.includes('@') && !e.startsWith('@')) return e === addr;
    const d = e.replace(/^@/, '');
    return host === d || host.endsWith(`.${d}`);
  });
}

// ---- planning (pure) --------------------------------------------------------

export const queryFor = (match) => `from:(${match.from})` + (match.hasTheWord ? ` (${match.hasTheWord})` : '');
export const rowId = (kind, from) => `f-${createHash('sha256').update(`${kind}:${from}`).digest('hex').slice(0, 10)}`;
const countBy = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** Per-sender stats over de-duplicated messages. A message seen in several runs keeps every bucket. */
export function senderStats(records) {
  const byMsg = new Map();
  let duplicates = 0;
  for (const r of records) {
    const m = byMsg.get(r.message_id);
    if (m) { duplicates++; m.buckets.add(r.bucket); if (!m.unsub && r.list_unsubscribe) m.unsub = r.list_unsubscribe; continue; }
    byMsg.set(r.message_id, { id: r.message_id, sender: r.sender, date: r.date, unsub: r.list_unsubscribe, buckets: new Set([r.bucket]) });
  }
  const senders = new Map();
  for (const m of byMsg.values()) {
    let s = senders.get(m.sender);
    if (!s) {
      const host = hostOf(m.sender);
      s = { sender: m.sender, host, domain: registrableDomain(host), messages: [] };
      senders.set(m.sender, s);
    }
    s.messages.push(m);
  }
  for (const s of senders.values()) {
    s.messages.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    s.total = s.messages.length;
    s.blocking = s.messages.filter((m) => [...m.buckets].some((b) => !ZERO_TOUCH.includes(b))).length;
    s.buckets = sortObj(countBy(s.messages.flatMap((m) => [...m.buckets])));
    const u = s.messages.map((m) => parseUnsubscribe(m.unsub)).find(Boolean);
    s.unsubscribe = u ? { sender: s.sender, ...u } : null;
  }
  return { senders, messages: byMsg.size, duplicates };
}

/** cleanup → promotions label; auto_handled → receipts label (per-domain override). Tie → auto_handled. */
export function actionFor(stat, policy) {
  const b = stat.buckets;
  const kind = (b.auto_handled ?? 0) >= (b.cleanup ?? 0) ? 'auto_handled' : 'cleanup';
  const byDomain = policy.labels.auto_handled_by_domain;
  const addLabel = kind === 'cleanup'
    ? policy.labels.cleanup
    : byDomain[stat.host] ?? byDomain[stat.domain] ?? policy.labels.auto_handled;
  const action = { addLabel, archive: true, markRead: false };
  return { kind, action };
}

/** Build the plan from parsed evidence records. Pure: `now` and `inputs` are passed in. */
export function buildPlan(records, { min = MIN_EVIDENCE, policy = normalizePolicy({}), now = new Date(), inputs = {} } = {}) {
  if (min < MIN_EVIDENCE_FLOOR) throw usageError(`min ${min} is below the floor of ${MIN_EVIDENCE_FLOOR}`);
  const { senders, messages, duplicates } = senderStats(records);
  const blocked = [];
  const belowMin = [];
  const qualifying = new Map();

  for (const s of senders.values()) {
    if (listMatches(s.sender, policy.protect)) {
      blocked.push({ sender: s.sender, total: s.total, blocking: s.total, buckets: s.buckets, reason: 'protected by policy' });
    } else if (s.blocking > 0) {
      blocked.push({ sender: s.sender, total: s.total, blocking: s.blocking, buckets: s.buckets, reason: 'mail outside the zero-touch buckets was observed from this sender' });
    } else if (s.total < min) {
      belowMin.push({ sender: s.sender, total: s.total, buckets: s.buckets });
    } else {
      qualifying.set(s.sender, { ...s, ...actionFor(s, policy) });
    }
  }

  const byDomain = new Map();
  for (const s of senders.values()) {
    if (!byDomain.has(s.domain)) byDomain.set(s.domain, []);
    byDomain.get(s.domain).push(s);
  }

  const rows = [];
  const makeRow = ({ kind, from, stats, action, note }) => {
    const msgs = stats.flatMap((s) => s.messages).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    const trash = stats.every((s) => listMatches(s.sender, policy.trash));
    const act = { ...action };
    if (trash) act.trash = true;
    const match = { from };
    const row = {
      id: rowId(kind, from),
      kind,
      senders: stats.map((s) => s.sender).sort(),
      criteria: queryFor(match),
      match,
      action: act,
      evidence_count: msgs.length,
      buckets: sortObj(countBy(msgs.flatMap((m) => [...m.buckets]))),
      sample_message_ids: msgs.slice(0, SAMPLE_IDS).map((m) => m.id),
    };
    const unsub = stats.map((s) => s.unsubscribe).filter(Boolean);
    if (unsub.length) row.unsubscribe = unsub;
    if (trash) { row.requires_explicit_approval = true; row.approved_trash = false; }
    row.approved = false;
    row.note = note + (trash ? ' · policy trash list matched: exporting shouldTrash also needs approved_trash: true' : '');
    return row;
  };

  for (const [domain, all] of byDomain) {
    const q = all.filter((s) => qualifying.has(s.sender)).map((s) => qualifying.get(s.sender));
    if (!q.length) continue;
    const sameAction = new Set(q.map((s) => JSON.stringify(s.action))).size === 1;
    const qHosts = new Set(q.map((s) => s.host));
    // A domain filter also catches unobserved addresses at its hosts; a protected one blocks it.
    const protectsHere = policy.protect.some((e) => e.includes('@') && !e.startsWith('@') && qHosts.has(hostOf(e)));
    const collapse = all.length >= 2 && q.length === all.length && sameAction && !protectsHere
      && q.every((s) => listMatches(s.sender, policy.trash)) === q.some((s) => listMatches(s.sender, policy.trash));
    if (collapse) {
      const hosts = [...new Set(q.map((s) => s.host))].sort();
      rows.push(makeRow({
        kind: 'domain',
        from: hosts.map((h) => `@${h}`).join(' OR '),
        stats: q,
        action: q[0].action,
        note: `${q.length} addresses at ${domain}, every observed message zero-touch (${q[0].kind})`,
      }));
      continue;
    }
    let why = '';
    if (all.length >= 2) {
      const blockedHere = all.filter((s) => !qualifying.has(s.sender));
      why = blockedHere.length
        ? ` · no domain filter: ${blockedHere.length} other address(es) at ${domain} blocked or below --min`
        : protectsHere
          ? ` · no domain filter: the policy protects an address at ${domain}`
          : ' · no domain filter: addresses at this domain take different actions';
    }
    for (const s of q) {
      rows.push(makeRow({ kind: 'address', from: s.sender, stats: [s], action: s.action, note: `every observed message zero-touch (${s.kind})${why}` }));
    }
  }

  rows.sort((a, b) => b.evidence_count - a.evidence_count || a.criteria.localeCompare(b.criteria));
  const kept = rows.slice(0, MAX_FILTERS);
  blocked.sort((a, b) => b.total - a.total || a.sender.localeCompare(b.sender));
  belowMin.sort((a, b) => b.total - a.total || a.sender.localeCompare(b.sender));

  return {
    schema: PLAN_SCHEMA,
    generated_at: now.toISOString(),
    generator: `gmf ${VERSION}`,
    review: 'Set "approved": true on each row to export; trash rows also need "approved_trash": true. Edit action/match freely — criteria must equal the query match builds.',
    inputs: { ...inputs, min, messages, duplicate_observations: duplicates, senders: senders.size },
    live: null,
    filters: kept,
    omitted_over_ceiling: rows.length - kept.length,
    blocked,
    below_min: belowMin,
  };
}

// ---- plan validation (export/show) ------------------------------------------

/** Structural check of a plan read from disk; returns its approved rows, validated for export. */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new GmfError('plan: not a JSON object');
  if (plan.schema !== PLAN_SCHEMA) throw new GmfError(`plan: schema is ${JSON.stringify(plan.schema)}, expected "${PLAN_SCHEMA}" — regenerate it with gmf plan`);
  if (!Array.isArray(plan.filters)) throw new GmfError('plan: "filters" must be an array');
  if (plan.filters.length > MAX_FILTERS) throw new GmfError(`plan: ${plan.filters.length} filters exceeds the ${MAX_FILTERS} ceiling (MAX_FILTERS)`);
  const ids = new Set();
  const problems = [];
  for (const [i, r] of plan.filters.entries()) {
    const at = `filters[${i}]${r && r.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r !== 'object') { problems.push(`${at}: not an object`); continue; }
    if (ids.has(r.id)) problems.push(`${at}: duplicate id`);
    ids.add(r.id);
    if (r.approved !== true && r.approved !== false) problems.push(`${at}: "approved" must be true or false (JSON boolean)`);
    if (r.approved !== true) continue;
    const m = r.match;
    if (!m || typeof m !== 'object' || typeof m.from !== 'string' || !m.from.trim()) { problems.push(`${at}: match.from is required`); continue; }
    for (const k of Object.keys(m)) if (!MATCH_KEYS.includes(k)) problems.push(`${at}: match.${k} is not supported (${MATCH_KEYS.join(', ')})`);
    if (m.hasTheWord !== undefined && (typeof m.hasTheWord !== 'string' || !m.hasTheWord.trim())) problems.push(`${at}: match.hasTheWord must be a non-empty string`);
    if (r.criteria !== queryFor(m)) problems.push(`${at}: criteria ${JSON.stringify(r.criteria)} does not equal the query its match builds (${JSON.stringify(queryFor(m))}) — edit both so what you reviewed is what exports`);
    const a = r.action;
    if (!a || typeof a !== 'object') { problems.push(`${at}: action is required`); continue; }
    for (const k of Object.keys(a)) if (!ACTION_KEYS.includes(k)) problems.push(`${at}: action.${k} is not supported (${ACTION_KEYS.join(', ')})`);
    for (const k of ['archive', 'markRead', 'neverSpam', 'trash']) if (a[k] !== undefined && typeof a[k] !== 'boolean') problems.push(`${at}: action.${k} must be true or false`);
    if (a.addLabel !== undefined) { try { assertLabel(a.addLabel, `${at}: action.addLabel`); } catch (e) { problems.push(e.message); } }
    if (a.trash === true && !(r.requires_explicit_approval === true && r.approved_trash === true)) {
      problems.push(`${at}: action.trash needs requires_explicit_approval: true AND approved_trash: true — set approved_trash, or set action.trash to false to export the archive+label action instead`);
    }
    if (!a.addLabel && !a.archive && !a.markRead && !a.neverSpam && !a.trash) problems.push(`${at}: action does nothing`);
  }
  if (problems.length) throw new GmfError(`plan has ${problems.length} problem(s); nothing written:\n  ${problems.join('\n  ')}`);
  return plan.filters.filter((r) => r.approved === true);
}

// ---- XML (Gmail's Atom filter export format) --------------------------------

// XML 1.0 forbids these outright; escaping cannot represent them.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
export function xmlEscape(s) {
  const str = String(s);
  if (XML_INVALID.test(str)) throw new GmfError(`value ${JSON.stringify(str)} contains a character XML cannot carry`);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

/** Gmail's property list for one row, in Gmail's own order. Only true booleans are emitted. */
export function filterProperties(row) {
  const a = row.action;
  const props = [['from', row.match.from]];
  if (row.match.hasTheWord) props.push(['hasTheWord', row.match.hasTheWord]);
  if (a.addLabel) props.push(['label', a.addLabel]);
  if (a.archive === true) props.push(['shouldArchive', 'true']);
  if (a.markRead === true) props.push(['shouldMarkAsRead', 'true']);
  if (a.neverSpam === true) props.push(['shouldNeverSpam', 'true']);
  if (a.trash === true && row.requires_explicit_approval === true && row.approved_trash === true && row.approved === true) props.push(['shouldTrash', 'true']);
  return props;
}

/** mailFilters.xml exactly as Gmail's Settings → Filters → Export writes it. */
export function renderFiltersXml(rows, { now = new Date() } = {}) {
  const updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const base = now.getTime() * 1000;
  const ids = rows.map((_, i) => String(base + i));
  const out = [
    "<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    '\t<title>Mail Filters</title>',
    `\t<id>tag:mail.google.com,2008:filters:${ids.join(',')}</id>`,
    `\t<updated>${updated}</updated>`,
  ];
  rows.forEach((row, i) => {
    out.push(
      '\t<entry>',
      "\t\t<category term='filter'></category>",
      '\t\t<title>Mail Filter</title>',
      `\t\t<id>tag:mail.google.com,2008:filter:${ids[i]}</id>`,
      `\t\t<updated>${updated}</updated>`,
      '\t\t<content></content>',
      ...filterProperties(row).map(([n, v]) => `\t\t<apps:property name='${xmlEscape(n)}' value='${xmlEscape(v)}'/>`),
      '\t</entry>',
    );
  });
  out.push('</feed>');
  return `${out.join('\n')}\n`;
}

// ---- output paths -----------------------------------------------------------

function realpathNearest(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function beltRoots(env = process.env) {
  const roots = new Set([BELT_ROOT, path.join(homedir(), 'Toolbelt')]);
  if (env.TOOLBELT) roots.add(env.TOOLBELT);
  return [...roots];
}

/**
 * Plans and XML name senders: private data. Refused: `/` or $HOME itself (as the path or as the
 * directory it lands in), an existing directory, and anywhere inside the Toolbelt tree.
 */
export function checkOutFile(file, { home = homedir(), roots = beltRoots(), cwd = process.cwd() } = {}) {
  const abs = path.resolve(cwd, String(file).replace(/^~(?=$|\/)/, home));
  const real = realpathNearest(abs);
  const realHome = realpathNearest(path.resolve(home));
  const dir = path.dirname(real);
  if (real === path.parse(real).root || dir === path.parse(real).root) throw usageError(`--out ${abs}: refused — / is not a place for private files; name a dedicated directory`);
  if (real === realHome || dir === realHome) throw usageError(`--out ${abs}: refused — not in your home directory itself; use a subdirectory such as ~/.local/share/toolbelt/gmail-filters/`);
  for (const r of roots) {
    const rr = realpathNearest(path.resolve(r));
    if (real === rr || real.startsWith(rr + path.sep)) {
      throw usageError(`--out ${abs} is inside the Toolbelt tree (${r}) — plans and filter files name your senders and never land in the belt`);
    }
  }
  if (existsSync(abs) && statSync(abs).isDirectory()) throw usageError(`--out ${abs} is a directory — name the file`);
  return abs;
}

/** Create a 600 file; refuses to overwrite (flag "wx"). The parent is created 700 if missing. */
export function writePrivateFile(file, content) {
  if (existsSync(file)) throw usageError(`${file} already exists — gmf never overwrites; move it aside or pick another --out`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  chmodSync(file, 0o600);
}

// ---- audit (SENSIBILITIES #7) -----------------------------------------------

export function auditLine(fields, now = new Date()) {
  const parts = [`[gmf audit] ${now.toISOString()}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${typeof v === 'number' ? v : JSON.stringify(String(v))}`);
  }
  return parts.join(' ');
}

function audit(fields) {
  const line = auditLine(fields);
  console.error(line);
  try {
    mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
    chmodSync(AUDIT_DIR, 0o700);
    appendFileSync(AUDIT_LOG, `${line}\n`, { mode: 0o600 });
    chmodSync(AUDIT_LOG, 0o600);
  } catch (e) {
    console.error(`gmf: could not append to ${AUDIT_LOG} (${e.message}) — the stderr line above is the only record`);
  }
}

// ---- --live: read-only match counts through gmh -----------------------------

export function gmhCommand(bin, args, execPath = process.execPath) {
  return /\.(m?js|cjs)$/.test(bin) ? [execPath, [bin, ...args]] : [bin, args];
}

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: LIVE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

/**
 * For each row, `gmh list --query "<criteria> newer_than:90d" --max LIVE_MAX --json`, one at a
 * time. The first failure stops the pass: the remaining rows keep evidence-only counts and the
 * plan records why (SENSIBILITIES #8).
 */
export async function addLiveCounts(plan, { bin = process.env.GMH_BIN || DEFAULT_GMH, run = execFileP } = {}) {
  plan.live = { window: LIVE_WINDOW, max: LIVE_MAX, gmh: bin, calls: 0, error: null };
  for (const row of plan.filters) {
    const [cmd, args] = gmhCommand(bin, ['list', '--query', `${row.criteria} newer_than:${LIVE_WINDOW}`, '--max', String(LIVE_MAX), '--json']);
    plan.live.calls++;
    try {
      const { stdout } = await run(cmd, args);
      const list = JSON.parse(stdout);
      if (!Array.isArray(list)) throw new Error('gmh list --json did not print an array');
      row.live_count_90d = list.length;
      if (list.length >= LIVE_MAX) row.live_count_capped = true;
    } catch (e) {
      const why = String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).pop() ?? 'unknown error';
      plan.live.error = `gmh failed on ${row.id}: ${why.slice(0, 300)} — remaining rows have evidence-only counts`;
      break;
    }
  }
  return plan;
}

// ---- human rendering --------------------------------------------------------

const fmtBuckets = (b) => Object.entries(b).map(([k, n]) => `${k}:${n}`).join(' ');
function fmtAction(r) {
  const a = r.action ?? {};
  const bits = [];
  if (a.trash) bits.push(r.approved_trash === true ? 'TRASH' : 'TRASH?');
  if (a.addLabel) bits.push(`+${a.addLabel}`);
  if (a.archive) bits.push('archive');
  if (a.markRead) bits.push('read');
  if (a.neverSpam) bits.push('never-spam');
  return bits.join(' ');
}

export function renderShow(plan) {
  const rows = plan.filters ?? [];
  const lines = [];
  const approved = rows.filter((r) => r.approved === true).length;
  lines.push(`plan ${plan.generated_at ?? '?'} · ${rows.length} proposed · ${approved} approved · ${(plan.blocked ?? []).length} blocked · ${(plan.below_min ?? []).length} below --min ${plan.inputs?.min ?? '?'}`
    + (plan.live ? ` · live ${plan.live.window}${plan.live.error ? ' (partial)' : ''}` : ' · counts are evidence-only'));
  if (plan.omitted_over_ceiling) lines.push(`${plan.omitted_over_ceiling} more proposal(s) omitted at the ${MAX_FILTERS} ceiling`);
  if (rows.length) {
    const table = rows.map((r) => [
      r.approved === true ? '[x]' : '[ ]',
      r.id ?? '',
      r.kind ?? '',
      String(r.evidence_count ?? ''),
      r.live_count_90d === undefined ? '-' : `${r.live_count_capped ? '≥' : ''}${r.live_count_90d}`,
      fmtAction(r),
      r.unsubscribe ? 'unsub' : '',
      r.criteria ?? '',
    ]);
    const head = ['ok', 'id', 'kind', 'n', '90d', 'action', '', 'criteria'];
    const w = head.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)));
    const fmt = (t) => t.map((c, i) => (i === t.length - 1 ? c : c.padEnd(w[i]))).join('  ').trimEnd();
    lines.push('', fmt(head), ...table.map(fmt));
  }
  if ((plan.blocked ?? []).length) {
    lines.push('', 'blocked (never proposed):');
    for (const b of plan.blocked.slice(0, 25)) lines.push(`  ${b.sender}  ${b.blocking}/${b.total} blocking  ${fmtBuckets(b.buckets ?? {})}${b.reason === 'protected by policy' ? '  (policy protect)' : ''}`);
    if (plan.blocked.length > 25) lines.push(`  … ${plan.blocked.length - 25} more in the plan file`);
  }
  if (plan.live?.error) lines.push('', `live: ${plan.live.error}`);
  lines.push('', 'review: edit the plan, set "approved": true per row (trash rows also "approved_trash": true), then gmf export --plan <plan> --out <file>.xml');
  return lines.join('\n');
}

// ---- verbs ------------------------------------------------------------------

function readJson(file, what) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new GmfError(`cannot read ${what} ${file} (${e.code ?? e.message})`); }
  try { return JSON.parse(text); } catch (e) { throw new GmfError(`${what} ${file} is not valid JSON (${e.message})`); }
}

async function cmdPlan(cli) {
  const out = cli.out ? checkOutFile(cli.out) : null;
  if (out && existsSync(out)) throw usageError(`${out} already exists — gmf never overwrites (a plan may carry your approvals); move it aside or pick another --out`);
  const { policy, source } = loadPolicy(cli.policy ?? process.env.GMF_POLICY ?? POLICY_PATH);
  if (!source) console.error(`gmf: no policy file — using default labels (${DEFAULT_LABELS.cleanup}, ${DEFAULT_LABELS.auto_handled}), no trash or protect lists. Copy policy.json.example to ${POLICY_PATH} (chmod 600) to set them`);
  const all = [];
  const skipped = { meta: 0, malformed: 0, no_message_id: 0, no_sender: 0 };
  let lines = 0;
  for (const f of cli.evidence) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch (e) { throw new GmfError(`cannot read evidence ${f} (${e.code ?? e.message})`); }
    const { records, stats } = parseEvidence(text, f);
    all.push(...records);
    lines += stats.lines;
    for (const k of Object.keys(skipped)) skipped[k] += stats[k];
  }
  const plan = buildPlan(all, {
    min: cli.min,
    policy,
    inputs: { evidence: cli.evidence.map((f) => path.resolve(f)), lines, records: all.length, skipped, policy: source },
  });
  if (cli.live) await addLiveCounts(plan);
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (out) writePrivateFile(out, json);
  else process.stdout.write(json);
  audit({
    verb: 'plan', evidence_files: cli.evidence.length, records: all.length, messages: plan.inputs.messages, senders: plan.inputs.senders,
    min: cli.min, proposed: plan.filters.length, blocked: plan.blocked.length, below_min: plan.below_min.length,
    omitted: plan.omitted_over_ceiling || undefined, live_calls: plan.live?.calls, live_error: plan.live?.error ? 'yes' : undefined,
    policy: source ?? 'defaults', out: out ?? 'stdout',
  });
  if (plan.live?.error) console.error(`gmf: ${plan.live.error}`);
  if (out) console.error(`gmf: ${plan.filters.length} proposed · ${plan.blocked.length} blocked · ${plan.below_min.length} below --min ${cli.min} → ${out} (600). Review with: gmf show --plan ${out}`);
  if (!all.length) console.error('gmf: 0 usable records — every line was _meta, malformed, or lacked message_id/from; check the evidence producer');
  return 0;
}

async function cmdShow(cli) {
  const plan = readJson(cli.plan, 'plan');
  if (plan.schema !== PLAN_SCHEMA) throw new GmfError(`plan: schema is ${JSON.stringify(plan.schema)}, expected "${PLAN_SCHEMA}"`);
  audit({ verb: 'show', plan: path.resolve(cli.plan), proposed: plan.filters?.length ?? 0, approved: (plan.filters ?? []).filter((r) => r.approved === true).length });
  if (cli.json) { console.log(JSON.stringify(plan.filters ?? [], null, 2)); return 0; }
  console.log(renderShow(plan));
  return 0;
}

async function cmdExport(cli) {
  const out = cli.out ? checkOutFile(cli.out) : null;
  if (out && !cli.explain && existsSync(out)) throw usageError(`${out} already exists — gmf never overwrites; move it aside or pick another --out`);
  const plan = readJson(cli.plan, 'plan');
  const rows = validatePlan(plan);
  if (!rows.length) throw new GmfError(`0 rows approved in ${cli.plan} — set "approved": true on the rows you reviewed, then re-run`);
  const trash = rows.filter((r) => filterProperties(r).some(([n]) => n === 'shouldTrash')).length;
  if (cli.explain) {
    console.log([
      `would write ${rows.length} filter(s) (${trash} with shouldTrash) of ${plan.filters.length} proposed`,
      ...rows.map((r) => `  ${r.id}  ${fmtAction(r)}  ${r.criteria}`),
      `to ${out ?? '<--out>'} · nothing written`,
    ].join('\n'));
    audit({ verb: 'export', mode: 'explain', plan: path.resolve(cli.plan), approved: rows.length, trash });
    return 0;
  }
  writePrivateFile(out, renderFiltersXml(rows));
  audit({ verb: 'export', plan: path.resolve(cli.plan), approved: rows.length, exported: rows.length, trash, out });
  console.error(`gmf: ${rows.length} filter(s) → ${out} (600). Import: Gmail → Settings → Filters and Blocked Addresses → Import filters → choose the file → Open file → review → Create filters. New mail only.`);
  return 0;
}

// ---- unsub-plan: how each candidate sender can be unsubscribed (headers only) -----
// Reads gmh export directories (index.jsonl + <id>.eml), takes each sender's newest message that
// carries List-Unsubscribe (else its newest), and classifies: one_click (RFC 8058: https target +
// List-Unsubscribe-Post), mailto, landing (https page only) or none. No network.

/** Unfolded, lowercased header map from the head of a raw message (first value wins). */
export function parseHeaders(raw) {
  const s = typeof raw === 'string' ? raw : raw.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  const head = (m ? s.slice(0, m.index) : s).replace(/\r?\n[ \t]+/g, ' ');
  const out = {};
  const all = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (!(k in out)) out[k] = val;
    (all[k] ??= []).push(val);
  }
  return { first: out, all };
}

/** RFC 2047 encoded-words (some senders Q-encode the whole List-Unsubscribe value). */
export function decodeWords(v) {
  return String(v ?? '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, _cs, enc, text) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))));
}

/** {method, https, mailto} from List-Unsubscribe / List-Unsubscribe-Post values. */
export function classifyUnsubscribe(lu, post) {
  const v = decodeWords(lu);
  let targets = [...v.matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
  if (!targets.length) targets = v.split(',').map((t) => t.trim()).filter((t) => /^(https|mailto):/i.test(t)); // bare, off-RFC
  const https = targets.find((t) => /^https:/i.test(t)) ?? null;
  const mailto = targets.find((t) => /^mailto:/i.test(t)) ?? null;
  const oneClick = /list-unsubscribe=one-click/i.test(post ?? '');
  return { method: https && oneClick ? 'one_click' : mailto ? 'mailto' : https ? 'landing' : 'none', https, mailto };
}

/** True when an Authentication-Results header shows dkim=pass for the sender's registrable domain. */
export function dkimAligned(authResults, sender) {
  const dom = registrableDomain(String(sender).split('@')[1] ?? '');
  return (authResults ?? []).some((ar) => [...ar.matchAll(/dkim=pass[^;]*?header\.(?:i|d)=@?([\w.-]+)/gi)]
    .some((x) => registrableDomain(x[1].toLowerCase()) === dom));
}

async function cmdUnsubPlan(cli) {
  const out = checkOutFile(cli.out);
  if (existsSync(out)) throw usageError(`${out} already exists — gmf never overwrites; move it aside or pick another --out`);
  const text = readFileSync(cli.senders, 'utf8');
  let list;
  try { list = JSON.parse(text).map((r) => (typeof r === 'string' ? r : r.sender)); } catch { list = text.split('\n'); }
  const want = new Set(list.map(normalizeAddress).filter(Boolean));
  const best = new Map();
  for (const dir of cli.mail) {
    let idx;
    try { idx = readFileSync(path.join(dir, 'index.jsonl'), 'utf8'); } catch (e) { throw new GmfError(`cannot read ${dir}/index.jsonl (${e.code ?? e.message}) — --mail takes gmh export directories`); }
    for (const line of idx.split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r.sha256 || !r.id) continue;
      const file = path.join(dir, `${r.id}.eml`);
      let head;
      try { head = readFileSync(file).subarray(0, 131072); } catch { continue; }
      const h = parseHeaders(head);
      const from = normalizeAddress(decodeWords(h.first.from ?? ''));
      if (!from || !want.has(from)) continue;
      const rank = Number(r.internalDate) + ('list-unsubscribe' in h.first ? 1e15 : 0);
      if (!best.has(from) || best.get(from).rank < rank) best.set(from, { rank, id: r.id, h });
    }
  }
  const candidates = [...want].map((sender) => {
    const b = best.get(sender);
    if (!b) return { sender, method: 'not_found' };
    const c = classifyUnsubscribe(b.h.first['list-unsubscribe'], b.h.first['list-unsubscribe-post']);
    const host = c.https ? new URL(c.https).hostname : c.mailto ? (c.mailto.replace(/^mailto:/i, '').split('?')[0].split('@')[1] ?? '') : null;
    return {
      sender, method: c.method, https: c.https, mailto: c.mailto, target_host: host,
      host_matches_sender: host ? registrableDomain(host) === registrableDomain(sender.split('@')[1]) : null,
      dkim_aligned: dkimAligned(b.h.all['authentication-results'], sender),
      evidence_message: b.id, evidence_date: new Date(b.rank % 1e15).toISOString().slice(0, 10),
    };
  });
  const doc = {
    schema: UNSUB_SCHEMA, approved_by: null, words: null, approved: [],
    note: 'Candidates only. To approve: copy rows into approved[] as {sender, do: "one_click", https}, set approved_by and the operator\'s own words, then gmf unsubscribe --approved <this file>.',
    candidates,
  };
  writePrivateFile(out, `${JSON.stringify(doc, null, 1)}\n`);
  const count = (k) => candidates.filter((c) => c.method === k).length;
  audit({ verb: 'unsub-plan', mail_dirs: cli.mail.length, senders: want.size, one_click: count('one_click'), mailto: count('mailto'), landing: count('landing'), none: count('none'), not_found: count('not_found'), out });
  console.error(`gmf: ${want.size} senders → one_click ${count('one_click')} · mailto ${count('mailto')} · landing ${count('landing')} · none ${count('none')} · not_found ${count('not_found')} → ${out} (600). Nothing approved yet.`);
  return 0;
}

// ---- unsubscribe: RFC 8058 one-click, approved senders only -------------------

/** A one-click target gmf will POST to: https, a public hostname, a sane length. Null otherwise. */
export function oneClickTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^[\d.]+$/.test(h) || h.startsWith('[')) return null; // IP literals
  return u;
}

/** The approval file → the rows gmf may act on. Pure; refuses what an operator did not sign. */
export function validateApproval(doc) {
  if (!doc || doc.schema !== UNSUB_SCHEMA) throw new GmfError(`approval: schema is ${JSON.stringify(doc?.schema)}, expected "${UNSUB_SCHEMA}"`);
  if (typeof doc.approved_by !== 'string' || !doc.approved_by || typeof doc.words !== 'string' || !doc.words.trim()) {
    throw new GmfError('approval: needs approved_by and the operator\'s own words (words) — gmf acts only on a recorded approval');
  }
  if (!Array.isArray(doc.approved)) throw new GmfError('approval: approved[] is missing');
  const rows = [];
  const skipped = { not_one_click: 0, bad_target: 0, duplicate: 0 };
  const seen = new Set();
  for (const r of doc.approved) {
    const sender = normalizeAddress(r?.sender);
    if (!sender) { skipped.bad_target++; continue; }
    if (r.do !== 'one_click') { skipped.not_one_click++; continue; }
    const target = oneClickTarget(r.https);
    if (!target) { skipped.bad_target++; continue; }
    if (seen.has(sender)) { skipped.duplicate++; continue; }
    seen.add(sender);
    rows.push({ sender, url: target.href, host: target.hostname });
  }
  if (rows.length > MAX_UNSUB) throw new GmfError(`approval lists ${rows.length} one-click senders; the ceiling is ${MAX_UNSUB} per run (MAX_UNSUB, a code constant) — split the list`);
  return { rows, skipped };
}

/** Senders already unsubscribed according to the results log (last line per sender wins). */
export function doneSenders(text) {
  const last = new Map();
  for (const line of String(text ?? '').split('\n')) {
    try { const r = JSON.parse(line); if (r.sender) last.set(r.sender, r.ok === true); } catch { /* skip */ }
  }
  return new Set([...last].filter(([, ok]) => ok).map(([s]) => s));
}

/** One RFC 8058 POST. No cookies or credentials exist in this process; redirects are not followed. */
// --follow-redirects (operator opt-in, for senders whose endpoint answered 3xx): re-POST the same
// one-click body to each Location, up to MAX_REDIRECTS hops — the unsubscribe stays a POST (fetch's
// own redirect mode would turn a 301/302/303 into a GET of a landing page). Only https targets that
// pass oneClickTarget are followed.
export const MAX_REDIRECTS = 5;
export async function postOneClick(url, { fetchImpl = fetch, timeoutMs = UNSUB_TIMEOUT_MS, follow = false } = {}) {
  let target = url;
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: null, note: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message ?? e).slice(0, 160) };
    }
    const ok = res.status >= 200 && res.status < 300;
    if (ok) return { ok, status: res.status, note: hop ? `after ${hop} redirect(s)` : null };
    const isRedirect = res.status >= 300 && res.status < 400;
    if (!isRedirect) return { ok: false, status: res.status, note: 'non-2xx' };
    if (!follow) return { ok: false, status: res.status, note: 'redirect not followed' };
    const loc = res.headers?.get?.('location');
    const nextUrl = loc ? oneClickTarget(new URL(loc, target).href) : null;
    if (!nextUrl) return { ok: false, status: res.status, note: 'redirect to a refused target' };
    if (hop + 1 > MAX_REDIRECTS) return { ok: false, status: res.status, note: `more than ${MAX_REDIRECTS} redirects` };
    target = nextUrl.href;
  }
}

async function cmdUnsubscribe(cli, { fetchImpl = fetch, delayMs = UNSUB_DELAY_MS } = {}) {
  const file = path.resolve(cli.approved);
  const { rows, skipped } = validateApproval(readJson(file, 'approval'));
  const results = `${file.replace(/\.json$/, '')}.results.jsonl`;
  const done = doneSenders(existsSync(results) ? readFileSync(results, 'utf8') : '');
  const todo = rows.filter((r) => !done.has(r.sender));
  const skip = Object.entries(skipped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
  if (!cli.yes) {
    console.log([
      `would POST "List-Unsubscribe=One-Click" (RFC 8058) for ${todo.length} approved sender(s); ${done.size} already done${skip ? `; skipped: ${skip}` : ''}`,
      ...todo.map((r) => `  ${r.sender.padEnd(46)} → ${r.host}`),
      'nothing sent. Read the list, then re-run with --yes (the operator supplies it).',
    ].join('\n'));
    audit({ verb: 'unsubscribe', mode: 'preview', approval: file, pending: todo.length, done: done.size, ...skipped });
    return 0;
  }
  if (existsSync(results)) chmodSync(results, 0o600);
  let ok = 0;
  for (const [i, r] of todo.entries()) {
    const res = await postOneClick(r.url, { fetchImpl, follow: cli.followRedirects });
    appendFileSync(results, `${JSON.stringify({ sender: r.sender, host: r.host, ok: res.ok, status: res.status, note: res.note, followed_redirects: cli.followRedirects || undefined, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    ok += res.ok ? 1 : 0;
    console.error(`  ${res.ok ? 'ok  ' : 'FAIL'} ${r.sender} (${r.host}) ${res.status ?? ''} ${res.note ?? ''}`.trimEnd());
    if (i < todo.length - 1 && delayMs) await new Promise((z) => setTimeout(z, delayMs));
  }
  chmodSync(results, 0o600);
  audit({ verb: 'unsubscribe', approval: file, attempted: todo.length, ok, failed: todo.length - ok, done_before: done.size, results });
  console.error(`gmf: ${ok}/${todo.length} one-click unsubscribes accepted → ${results} (600). A 2xx is the sender's claim: read back in ~2 weeks with gmh list --query "from:<sender> newer_than:14d". Failures can be retried by re-running; they are never marked done.`);
  return ok === todo.length ? 0 : 1;
}

function usage() {
  return [
    'usage: gmf plan --evidence FILE... [--min N] [--out plan.json] [--policy FILE] [--live]',
    '                                    propose filters from triage evidence (JSONL); --live adds 90-day counts via gmh',
    '       gmf show --plan plan.json [--json]            the proposals as a table',
    '       gmf export --plan plan.json --out mailFilters.xml [--explain]',
    '       gmf unsub-plan --mail DIR... --senders FILE --out candidates.json',
    '                                    how each sender can be unsubscribed (headers of gmh exports; no network)',
    '       gmf unsubscribe --approved approved.json [--yes] [--follow-redirects]',
    '                                    RFC 8058 one-click POST per approved sender; previews unless --yes',
    '                                    approved rows only → Gmail-importable XML; never overwrites',
    `ceilings: ${MAX_FILTERS} filters per plan · --min default ${MIN_EVIDENCE}, floor ${MIN_EVIDENCE_FLOOR}`,
    `policy: ${POLICY_PATH.replace(homedir(), '~')} (600; GMF_POLICY or --policy overrides) · audit: ${AUDIT_LOG.replace(homedir(), '~')}`,
    'no Gmail writes: import the XML yourself in Gmail → Settings → Filters and Blocked Addresses',
    `unsubscribe: at most ${MAX_UNSUB} senders per run; results beside the approval file (600); resumable`,
    'exit: 0 ok · 1 input/plan/live failure · 2 bad usage or refused path',
  ].join('\n');
}

async function run() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`gmf: ${e.message}\n${usage()}`);
    return 2;
  }
  if (cli.help) { console.log(usage()); return 0; }
  if (cli.version) { console.log(`gmf ${VERSION}`); return 0; }
  try {
    if (cli.verb === 'plan') return await cmdPlan(cli);
    if (cli.verb === 'show') return await cmdShow(cli);
    if (cli.verb === 'unsubscribe') return await cmdUnsubscribe(cli);
    if (cli.verb === 'unsub-plan') return await cmdUnsubPlan(cli);
    return await cmdExport(cli);
  } catch (e) {
    const known = e instanceof GmfError;
    const msg = known ? e.message : `internal: ${e.message}`;
    console.error(`gmf: ${msg}`);
    audit({ verb: cli.verb, result: 'error', error: msg.split('\n')[0].slice(0, 200) });
    return known ? e.exitCode : 1;
  }
}

let direct = false;
try { direct = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === SELF; } catch { /* not a file path */ }
if (direct) run().then((code) => { process.exitCode = code; });
