#!/usr/bin/env node
// imsg — read iMessage/SMS history from this Mac's Messages database; send one message at a time
// behind a human gate.
//
// Reads open ~/Library/Messages/chat.db read-only (node:sqlite, { readOnly: true }) and resolve
// handles to names from the local Contacts stores. They need Full Disk Access for the terminal
// app and nothing else: no network, no credential.
//
// `send` goes out as the operator, to a real person, and cannot be recalled by this tool, so it
// is gated on the controlling terminal: a preview, then the word "send" typed at /dev/tty.
// With no terminal (an agent) the message is STAGED under ~/.local/share/imessage/pending/ and
// only `toolbelt approve imessage <code>`, where a human types "send", delivers it. After a
// send, chat.db is re-read until the outgoing row appears: Messages' "ok" is a claim, the row
// is the evidence.
//
// Exit codes: 0 done or previewed · 1 declined / failed / unverified · 2 usage · 3 staged,
// awaiting a human · 4 a gate needed a terminal and none was there.

import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, writeSync, constants as FS } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachmentsFor, directChatsFor, getChat, listChats, maxRowid, messagesAfter, messagesIn, openChatDb, searchMessages, threadOf } from './lib/db.mjs';
import { findPeople, handleKey, loadContacts, looksLikeHandle } from './lib/contacts.mjs';
import { discardPending, listPending, loadPending, stageWrite, ttyDevice, typedEchoMatches, PENDING_TTL_S } from './lib/gate.mjs';
import { explainOsascriptError, osascriptSend } from './lib/send.mjs';

export const TOOL = 'imessage';
export const CLI = 'imsg';

// ---------------------------------------------------------------- ceilings (code, not config)

export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 1000;
export const SEARCH_SCAN_CEILING = 250_000;
export const EXPORT_MAX = 250_000;
export const TEXT_MAX = 2000;
export const WATCH_MIN_INTERVAL_S = 1;

// ---------------------------------------------------------------- tiers (data, not prose)

/** Every verb's tier, as the manifest declares it; the test suite asserts the two agree. */
export const VERBS = {
  chats: { tier: 'read' },
  history: { tier: 'read' },
  thread: { tier: 'read' },
  search: { tier: 'read' },
  whois: { tier: 'read' },
  watch: { tier: 'read' },
  export: { tier: 'read', note: 'writes only the JSONL file the operator names' },
  send: { tier: 'write-gated', gate: 'tty' },
  approve: { tier: 'write-gated', gate: 'tty' },
};

// ---------------------------------------------------------------- environment

export function makeEnv(overrides = {}) {
  const home = overrides.home ?? process.env.IMSG_HOME ?? path.join(homedir(), '.local', 'share', 'imessage');
  const env = {
    chatDb: overrides.chatDb ?? process.env.IMSG_CHAT_DB ?? path.join(homedir(), 'Library', 'Messages', 'chat.db'),
    contactsDir: overrides.contactsDir ?? process.env.IMSG_CONTACTS_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'AddressBook'),
    home,
    pending: path.join(home, 'pending'),
    auditLog: path.join(home, 'audit.log'),
    out: overrides.out ?? ((s) => process.stdout.write(s + '\n')),
    err: overrides.err ?? ((s) => process.stderr.write(s + '\n')),
    now: overrides.now ?? (() => Date.now()),
    tty: overrides.tty ?? ttyDevice(),
    osascript: overrides.osascript ?? osascriptSend,
    sleep: overrides.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)),
    verifyTimeoutMs: overrides.verifyTimeoutMs ?? 20_000,
    _db: null,
    _contacts: null,
  };
  return env;
}

function db(env) {
  if (!env._db) env._db = openChatDb(env.chatDb);
  return env._db;
}

function contacts(env) {
  if (!env._contacts) env._contacts = loadContacts(env.contactsDir);
  return env._contacts;
}

function names(env) {
  return contacts(env).byKey;
}

export function display(p) {
  const h = homedir();
  return p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

function nameFor(env, handle) {
  return names(env).get(handleKey(handle)) ?? null;
}

// ---------------------------------------------------------------- parsing helpers

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const valued = new Set(['limit', 'since', 'chat', 'out', 'service', 'interval', 'for', 'discard', 'after-rowid']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (valued.has(key)) flags[key] = eq === -1 ? argv[++i] : a.slice(eq + 1);
      else flags[key] = true;
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

/** --since: an ISO date/time, or a span back from now — 90m, 12h, 7d, 4w. */
export function parseSince(s, now) {
  if (s === undefined || s === null) return null;
  const m = /^(\d+)\s*([mhdw])$/.exec(String(s).trim());
  if (m) return now - Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** --after-rowid: a non-negative integer ROWID watermark; null when absent, undefined when bad. */
export function parseRowid(v) {
  if (v === undefined || v === null) return null;
  return /^\d+$/.test(String(v)) ? Number(v) : undefined;
}

export function parseLimit(v, max = LIMIT_MAX) {
  if (v === undefined) return LIMIT_DEFAULT;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, max);
}

function localStamp(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function humanBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

export function renderMessage(m) {
  const who = m.from_me ? 'me' : m.from;
  let body;
  if (m.kind === 'reaction') body = `${who} ${m.text}`;
  else body = `${who}: ${m.text}`;
  const extras = [];
  if (m.reply_to) extras.push(`[reply to ${m.reply_to}]`);
  if (m.reacts_to) extras.push(`[on ${m.reacts_to}]`);
  if (m.app) extras.push(`[app message: ${m.app.split(':').pop()}]`);
  for (const a of m.attachments ?? []) extras.push(`[attachment ${[a.name, a.mime, humanBytes(a.bytes)].filter(Boolean).join(', ')}]`);
  if (m.edited) extras.push(m.edited_at ? `[edited ${localStamp(m.edited_at)}]` : '[edited]');
  if (m.unsent) extras.push(m.unsent_at ? `[unsent ${localStamp(m.unsent_at)}]` : '[unsent]');
  if (m.from_me && m.error) extras.push(`[not delivered: error ${m.error}]`);
  return `[${localStamp(m.date)}] ${body}${extras.length ? ' ' + extras.join(' ') : ''}`;
}

function emit(env, flags, rows, render) {
  if (flags.json) for (const r of rows) env.out(JSON.stringify(r));
  else for (const r of rows) env.out(render(r));
}

// ---------------------------------------------------------------- target resolution

/**
 * A conversation named on the command line: `chat:<id>` or a short bare number (a chat id from
 * `imsg chats`), a phone number or email (every one-to-one chat with that handle), or a contact
 * name (every one-to-one chat with every handle of exactly one matching contact).
 */
export function resolveTarget(env, target) {
  if (!target) return { error: 'name a conversation: a chat id from `imsg chats`, a phone number, an email, or a contact name' };
  const t = String(target).trim();
  const idm = /^(?:chat:)?(\d{1,6})$/.exec(t);
  if (idm) {
    const c = getChat(db(env), Number(idm[1]), names(env));
    if (!c) return { error: `no chat with id ${idm[1]} — list them with: ${CLI} chats` };
    return { chatIds: [c.id], label: c.label, group: c.group, chats: [c] };
  }
  if (looksLikeHandle(t)) {
    const chats = directChatsFor(db(env), t);
    const name = nameFor(env, t);
    if (!chats.length) return { error: `no conversation with ${t}${name ? ` (${name})` : ''} in this Mac's Messages history`, handle: t, name };
    return { chatIds: chats.map((c) => c.id), label: name ? `${name} <${t}>` : t, handle: t, name, chats };
  }
  const people = findPeople(contacts(env), t);
  if (!people.length) return { error: `no contact matches "${t}"${contacts(env).stores ? '' : ' (no Contacts store readable — use a phone number or email)'}` };
  if (people.length > 1) return { error: `"${t}" matches ${people.length} contacts: ${people.slice(0, 10).map((p) => p.name).join('; ')}${people.length > 10 ? '; …' : ''} — be more specific, or use a phone number/email`, candidates: people };
  const p = people[0];
  const chats = [];
  for (const h of p.handles) for (const c of directChatsFor(db(env), h)) if (!chats.some((x) => x.id === c.id)) chats.push({ ...c, handle: h });
  if (!chats.length) return { error: `${p.name} has no conversation in this Mac's Messages history (handles: ${p.handles.join(', ')})`, person: p };
  chats.sort((a, b) => String(b.last).localeCompare(String(a.last)));
  return { chatIds: chats.map((c) => c.id), label: p.name, person: p, chats };
}

// ---------------------------------------------------------------- reads

function cmdChats(env, flags) {
  const limit = parseLimit(flags.limit);
  if (limit === undefined) return usage(env, '--limit takes a positive integer');
  const rows = listChats(db(env), names(env), limit);
  emit(env, flags, rows, (c) => `${String(c.id).padStart(6)}  ${localStamp(c.last)}  ${c.group ? 'group ' : ''}${c.label}  (${c.messages} msg, ${c.service})`);
  if (!flags.json) env.err(`${rows.length} chat(s), most recent first — read one with: ${CLI} history <id|number|name>`);
  return 0;
}

function cmdHistory(env, target, flags) {
  const limit = parseLimit(flags.limit);
  if (limit === undefined) return usage(env, '--limit takes a positive integer');
  const since = parseSince(flags.since, env.now());
  if (since === undefined) return usage(env, `--since takes an ISO date or a span like 7d, 12h, 90m (got ${JSON.stringify(flags.since)})`);
  const afterRowid = parseRowid(flags['after-rowid']);
  if (afterRowid === undefined) return usage(env, '--after-rowid takes a non-negative integer');
  if (flags.changed && since === null) return usage(env, '--changed needs --since: it widens the window to edits and unsends inside it');
  const r = resolveTarget(env, flags.chat ? `chat:${flags.chat}` : target);
  if (r.error) { env.err(`${CLI}: ${r.error}`); return 2; }
  const rows = messagesIn(db(env), r.chatIds, { limit, sinceMs: since, changed: Boolean(flags.changed), afterRowid }, names(env));
  if (!flags.json) env.err(`── ${r.label} — ${rows.length} message(s)${since !== null ? ` since ${localStamp(new Date(since).toISOString())}` : ''}${flags.changed ? ' (or edited/unsent since)' : ''}${afterRowid !== null ? ` after row ${afterRowid}` : ''}, newest ${limit} max`);
  env.err(`newest row: ${rows.reduce((mx, m) => Math.max(mx, m.rowid), afterRowid ?? 0)} (pass as --after-rowid next time)`);
  emit(env, flags, rows, renderMessage);
  return 0;
}

function cmdThread(env, guid, flags) {
  if (!guid) return usage(env, 'thread needs a message guid (the reply_to of a reply, or any message guid)');
  const rows = threadOf(db(env), guid.trim(), names(env));
  if (!rows.length) { env.err(`${CLI}: no message with guid ${guid} or replies to it`); return 1; }
  const head = rows.find((m) => m.guid === guid.trim());
  if (!flags.json) env.err(`── thread ${guid}${head ? '' : ' (the original message is not on this Mac)'} — ${rows.length} message(s)`);
  emit(env, flags, rows, renderMessage);
  return 0;
}

function cmdSearch(env, query, flags) {
  if (!query) return usage(env, 'search needs the text to look for');
  const limit = parseLimit(flags.limit);
  if (limit === undefined) return usage(env, '--limit takes a positive integer');
  const since = parseSince(flags.since, env.now());
  if (since === undefined) return usage(env, `--since takes an ISO date or a span like 7d, 12h, 90m`);
  let chatIds = null;
  if (flags.chat) {
    const r = resolveTarget(env, flags.chat);
    if (r.error) { env.err(`${CLI}: ${r.error}`); return 2; }
    chatIds = r.chatIds;
  }
  const { hits, scanned, capped } = searchMessages(db(env), query, { limit, sinceMs: since, chatIds, scanCeiling: SEARCH_SCAN_CEILING }, names(env));
  const labels = new Map();
  for (const h of hits) {
    if (!labels.has(h.chat)) labels.set(h.chat, getChat(db(env), h.chat, names(env))?.label ?? `chat ${h.chat}`);
    h.chat_label = labels.get(h.chat);
  }
  emit(env, flags, hits, (m) => `${String(m.chat).padStart(6)}  ${m.chat_label} — ${renderMessage(m)}`);
  env.err(`${hits.length} hit(s) for ${JSON.stringify(query)} in ${scanned} message(s) scanned${capped ? ` (scan ceiling ${SEARCH_SCAN_CEILING} reached — narrow with --since or --chat)` : ''}`);
  return 0;
}

function cmdWhois(env, query, flags) {
  if (!query) return usage(env, 'whois needs a phone number, email, or name');
  const out = [];
  if (looksLikeHandle(query)) {
    out.push({ name: nameFor(env, query), handles: [{ handle: query, chats: directChatsFor(db(env), query) }] });
  } else {
    const people = findPeople(contacts(env), query);
    for (const p of people.slice(0, 25)) out.push({ name: p.name, handles: p.handles.map((h) => ({ handle: h, chats: directChatsFor(db(env), h) })) });
    if (!people.length) env.err(`${CLI}: no contact matches "${query}"${contacts(env).stores ? '' : ' (no Contacts store readable)'}`);
  }
  if (flags.json) { for (const o of out) env.out(JSON.stringify(o)); return 0; }
  for (const o of out) {
    env.out(o.name ?? '(not in Contacts)');
    for (const h of o.handles) {
      if (!h.chats.length) { env.out(`  ${h.handle} — no conversation`); continue; }
      for (const c of h.chats) env.out(`  ${h.handle} — chat ${c.id} (${c.service}, ${c.messages} msg, last ${c.last ? localStamp(c.last) : 'never'})`);
    }
  }
  return 0;
}

function cmdWatch(env, target, flags) {
  const interval = flags.interval === undefined ? 2 : Number(flags.interval);
  if (!Number.isFinite(interval) || interval < WATCH_MIN_INTERVAL_S) return usage(env, `--interval takes seconds, at least ${WATCH_MIN_INTERVAL_S}`);
  const forS = flags.for === undefined ? null : Number(flags.for);
  if (forS !== null && (!Number.isFinite(forS) || forS <= 0)) return usage(env, '--for takes a positive number of seconds');
  let chatIds = null;
  if (target || flags.chat) {
    const r = resolveTarget(env, flags.chat ? `chat:${flags.chat}` : target);
    if (r.error) { env.err(`${CLI}: ${r.error}`); return 2; }
    chatIds = r.chatIds;
  }
  let last = maxRowid(db(env));
  const until = forS === null ? Infinity : env.now() + forS * 1000;
  env.err(`watching${chatIds ? ` chat(s) ${chatIds.join(', ')}` : ' all chats'} for new messages every ${interval}s${forS === null ? ' (Ctrl-C to stop)' : ` for ${forS}s`}`);
  while (env.now() < until) {
    const rows = messagesAfter(db(env), last, names(env), { chatIds });
    const atts = attachmentsFor(db(env), rows.map((m) => m.rowid));
    for (const m of rows) {
      last = Math.max(last, m.rowid);
      if (atts.has(m.rowid)) m.attachments = atts.get(m.rowid);
      env.out(flags.json ? JSON.stringify(m) : renderMessage(m));
    }
    if (env.now() + interval * 1000 > until) break;
    env.sleep(interval * 1000);
  }
  return 0;
}

function cmdExport(env, target, flags) {
  if (!flags.out) return usage(env, 'export needs --out <file.jsonl>');
  const limit = parseLimit(flags.limit ?? String(EXPORT_MAX), EXPORT_MAX);
  if (limit === undefined) return usage(env, '--limit takes a positive integer');
  const since = parseSince(flags.since, env.now());
  if (since === undefined) return usage(env, '--since takes an ISO date or a span like 7d, 12h, 90m');
  let chatIds = null;
  let label = 'every chat';
  if (!flags.all) {
    const r = resolveTarget(env, flags.chat ? `chat:${flags.chat}` : target);
    if (r.error) { env.err(`${CLI}: ${r.error}`); return 2; }
    chatIds = r.chatIds;
    label = r.label;
  }
  const afterRowid = parseRowid(flags['after-rowid']);
  if (afterRowid === undefined) return usage(env, '--after-rowid takes a non-negative integer');
  if (flags.changed && since === null) return usage(env, '--changed needs --since');
  const outPath = path.resolve(flags.out);
  if (flags.explain) {
    env.out(`would write up to ${limit} message(s) from ${label}${since !== null ? ` since ${new Date(since).toISOString()}` : ''} to ${display(outPath)} as JSONL (mode 600; refuses to overwrite)`);
    return 0;
  }
  if (existsSync(outPath)) { env.err(`${CLI}: ${display(outPath)} exists — export never overwrites; choose a new --out`); return 2; }
  const rows = messagesIn(db(env), chatIds, { limit, sinceMs: since, changed: Boolean(flags.changed), afterRowid }, names(env));
  mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = openSync(outPath, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
  try {
    for (const m of rows) writeSync(fd, JSON.stringify(m) + '\n');
  } finally { closeSync(fd); }
  env.err(`[${CLI} audit] ${new Date(env.now()).toISOString()} verb="export" target=${JSON.stringify(label)} rows=${rows.length} file=${display(outPath)}`);
  env.out(`wrote ${rows.length} message(s) from ${label} to ${display(outPath)} (mode 600)${rows.length >= limit ? ` — capped at ${limit}; narrow with --since or raise --limit (max ${EXPORT_MAX})` : ''}`);
  return 0;
}

// ---------------------------------------------------------------- send (write-gated: tty)

/**
 * Resolve who a send goes to, without sending. A group or an existing conversation is sent to
 * by chat guid (Messages keeps its service); a handle with no conversation yet is sent to as a
 * participant of the chosen service account. Ambiguity is an error, never a guess.
 */
export function resolveSend(env, recipient, { chat, service }) {
  const svc = service ? ({ imessage: 'iMessage', sms: 'SMS' }[String(service).toLowerCase()]) : null;
  if (service && !svc) return { error: `--service takes imessage or sms, not ${JSON.stringify(service)}` };
  if (chat) {
    const c = getChat(db(env), Number(String(chat).replace(/^chat:/, '')), names(env));
    if (!c) return { error: `no chat with id ${chat} — list them with: ${CLI} chats` };
    if (svc) return { error: '--service does not apply to --chat: a chat is sent on its own service' };
    return { kind: 'chat', target: c.guid, service: c.service_name, label: c.label, group: c.group, participants: c.participants, chatIds: [c.id], handle: c.group ? null : c.participants[0] ?? null, prior: priorOf(env, [c.id]) };
  }
  if (!recipient) return { error: 'send needs a recipient (phone, email, or contact name) or --chat <id>' };
  let handle;
  let name;
  if (looksLikeHandle(recipient)) {
    handle = recipient.trim();
    name = nameFor(env, handle);
  } else {
    const people = findPeople(contacts(env), recipient);
    if (!people.length) return { error: `no contact matches "${recipient}" — use a phone number or email` };
    if (people.length > 1) return { error: `"${recipient}" matches ${people.length} contacts: ${people.slice(0, 10).map((p) => p.name).join('; ')} — be more specific, or use a phone number/email` };
    const p = people[0];
    name = p.name;
    // Prefer the handle of the most recent one-to-one conversation; with none, a single handle.
    const withChats = p.handles.map((h) => ({ h, chats: directChatsFor(db(env), h) })).filter((x) => x.chats.length);
    withChats.sort((a, b) => String(b.chats[0].last).localeCompare(String(a.chats[0].last)));
    if (withChats.length) handle = withChats[0].h;
    else if (p.handles.length === 1) handle = p.handles[0];
    else return { error: `${p.name} has ${p.handles.length} handles and no conversation yet: ${p.handles.join(', ')} — send to one of them explicitly` };
  }
  const chats = directChatsFor(db(env), handle);
  const pick = svc ? chats.find((c) => c.service === svc) : chats[0];
  if (pick) {
    return { kind: 'chat', target: pick.guid, service: pick.service, label: name ? `${name} <${handle}>` : handle, group: false, participants: [handle], chatIds: [pick.id], handle, prior: priorOf(env, [pick.id]) };
  }
  return { kind: svc ?? 'iMessage', target: handle, service: svc ?? 'iMessage', label: name ? `${name} <${handle}>` : handle, group: false, participants: [handle], chatIds: [], handle, prior: null };
}

function priorOf(env, chatIds) {
  const last = messagesIn(db(env), chatIds, { limit: 1 }, names(env))[0];
  if (!last) return null;
  const count = directCount(env, chatIds);
  return { messages: count, last: last.date, last_from: last.from_me ? 'me' : last.from };
}

function directCount(env, chatIds) {
  return Number(db(env).prepare(`SELECT COUNT(*) AS n FROM chat_message_join WHERE chat_id IN (${chatIds.map(() => '?').join(',')})`).get(...chatIds).n);
}

export function renderSendPreview(plan, text) {
  const lines = [
    `── imsg send preview ─────────────────────────────`,
    `To:       ${plan.label}${plan.group ? `  (GROUP — ${plan.participants.length} people: ${plan.participants.join(', ')})` : ''}`,
    `Service:  ${plan.service}${plan.kind === 'chat' ? '  (existing conversation)' : '  (NEW conversation — no prior messages with this handle on this Mac)'}`,
  ];
  if (plan.prior) lines.push(`History:  ${plan.prior.messages} message(s); last ${localStamp(plan.prior.last)} from ${plan.prior.last_from}`);
  lines.push(`Length:   ${[...text].length} character(s)`);
  lines.push(`──────────────────────────────────────────────────`, text, `──────────────────────────────────────────────────`);
  return lines.join('\n');
}

function sha12(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Audit line: stderr and the 600-mode audit log. Never the message text — its length and hash. */
function audit(env, fields) {
  const line = `[${CLI} audit] ${new Date(env.now()).toISOString()} ` + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' && /\s|"/.test(v) ? JSON.stringify(v) : v}`).join(' ');
  env.err(line);
  try {
    mkdirSync(env.home, { recursive: true, mode: 0o700 });
    appendFileSync(env.auditLog, line + '\n', { mode: 0o600 });
    chmodSync(env.auditLog, 0o600);
  } catch (e) {
    env.err(`${CLI}: could not append to ${display(env.auditLog)}: ${e.message}`);
  }
}

/**
 * Deliver one message and prove it. Called only after a human typed "send" at /dev/tty (in
 * cmdSend or cmdApprove); nothing else reaches it.
 */
function deliver(env, plan, text, via) {
  const before = maxRowid(db(env));
  const r = env.osascript({ target: plan.target, text, kind: plan.kind === 'chat' ? 'chat' : plan.service });
  const base = { verb: 'send', via, to: plan.handle ?? plan.target, chat: plan.chatIds[0] ?? 'new', service: plan.service, chars: [...text].length, sha: sha12(text) };
  if (r.status !== 0) {
    audit(env, { ...base, result: 'error' });
    env.err(`${CLI}: Messages refused the send: ${r.stderr || `osascript exit ${r.status}`}`);
    const hint = explainOsascriptError(r.stderr);
    if (hint) env.err(hint);
    return 1;
  }
  // Re-read: the send counts once its outgoing row is in chat.db.
  const want = text.trim();
  const key = plan.handle ? handleKey(plan.handle) : null;
  const deadline = env.now() + env.verifyTimeoutMs;
  let found = null;
  for (;;) {
    const rows = messagesAfter(db(env), before, names(env), { limit: 200 });
    found = rows.find((m) => m.from_me && m.text === want && ((plan.chatIds.length && plan.chatIds.includes(m.chat)) || (key && m.handle && handleKey(m.handle) === key)));
    if (found || env.now() >= deadline) break;
    env.sleep(500);
  }
  if (!found) {
    audit(env, { ...base, result: 'unverified' });
    env.err(`RE-READ MISMATCH: Messages accepted the send, but no outgoing row matching it appeared in chat.db within ${Math.round(env.verifyTimeoutMs / 1000)}s. Check Messages.app before sending again.`);
    return 1;
  }
  audit(env, { ...base, result: 'sent', rowid: found.rowid });
  env.out(`sent to ${plan.label} via ${found.service ?? plan.service} — re-read confirms message ${found.rowid} at ${localStamp(found.date)}${found.error ? ` (error ${found.error})` : ''}. No unsend from this tool; recall it in Messages.app within Apple's window if needed.`);
  return 0;
}

const SEND_WORD = 'send';

function sendPrompt(plan, extra = '') {
  return [
    ``,
    `CONFIRM — imsg send`,
    `  What:  send the message above to ${plan.label}${plan.group ? ` and everyone in the group` : ''}, as you, via ${plan.service}.`,
    `  Why the gate: a sent message reaches a real person and this tool cannot recall it.${extra}`,
    `  Type "${SEND_WORD}" to send it now; anything else (or Enter) sends nothing.`,
    `> `,
  ].join('\n');
}

function cmdSend(env, positional, flags) {
  const recipient = flags.chat ? null : positional[0];
  const text = (flags.chat ? positional : positional.slice(1)).join(' ');
  if (!text) return usage(env, 'send needs the message text');
  if ([...text].length > TEXT_MAX) { env.err(`${CLI}: message is ${[...text].length} characters; the ceiling is ${TEXT_MAX} (one message per send)`); return 2; }
  const plan = resolveSend(env, recipient, { chat: flags.chat, service: flags.service });
  if (plan.error) { env.err(`${CLI}: ${plan.error}`); return 2; }
  if (flags.explain) {
    env.out(renderSendPreview(plan, text));
    env.out(`would send 1 message (tier: write-gated, gate: tty — type "${SEND_WORD}" at /dev/tty; no terminal → staged for toolbelt approve ${TOOL} <code>)`);
    return 0;
  }
  if (flags.stage || !env.tty.has()) {
    const args = { recipient: recipient ?? null, chat: flags.chat ?? null, service: flags.service ?? null, text };
    const summary = `send ${[...text].length} chars to ${plan.label} via ${plan.service}`;
    const record = stageWrite(env.pending, env.now(), { tool: TOOL, verb: 'send', args, summary });
    env.err(renderSendPreview(plan, text));
    if (flags.yes) env.err(`--yes is honored only at a terminal a human is sitting at; staged instead.`);
    env.err(`staged — a human confirms with: toolbelt approve ${TOOL} ${record.code}`);
    env.err(`(nothing was sent; the payload lives in ${display(env.pending)}/${record.code}.json until ${record.expires}; it goes out only after "${SEND_WORD}" is typed at a real terminal)`);
    audit(env, { verb: 'send', result: 'staged', code: record.code, to: plan.handle ?? plan.target, service: plan.service, chars: [...text].length, sha: sha12(text) });
    env.out(JSON.stringify({ ok: false, error: 'pending_confirmation', code: record.code, approve: `toolbelt approve ${TOOL} ${record.code}`, expires: record.expires, summary }));
    return 3;
  }
  env.err(renderSendPreview(plan, text));
  if (flags.yes) {
    // A deliberate human at this terminal is never refused; /dev/tty opened, so one could have typed it.
    env.err(`--yes: skipping the typed word on your say-so.`);
  } else {
    const answer = env.tty.readLine(sendPrompt(plan));
    if (answer === null) { env.err(`${CLI}: send needs a human at /dev/tty to type "${SEND_WORD}"; nothing sent.`); return 4; }
    if (!typedEchoMatches(answer, SEND_WORD)) { env.err(`aborted — you typed ${JSON.stringify(answer)}, not "${SEND_WORD}"; nothing sent.`); return 1; }
  }
  return deliver(env, plan, text, 'terminal');
}

function cmdApprove(env, positional, flags) {
  if (flags.list || (!positional[0] && !flags.discard)) {
    const pending = listPending(env.pending, env.now());
    if (!pending.length) { env.out(`No staged sends pending under ${display(env.pending)}.`); return 0; }
    for (const r of pending) env.out(`${r.code}  expires ${r.expires}  ${r.summary}`);
    return 0;
  }
  if (flags.discard) {
    const gone = discardPending(env.pending, flags.discard);
    env.out(JSON.stringify({ ok: true, discarded: flags.discard, existed: gone }));
    return 0;
  }
  const code = positional[0];
  const record = loadPending(env.pending, env.now(), code);
  if (!record) {
    env.out(JSON.stringify({ ok: false, error: 'no_such_pending', message: `No staged send ${JSON.stringify(code)} (staged sends live ${PENDING_TTL_S / 60} minutes; it may have expired). Ask the agent to compose it again.` }));
    return 1;
  }
  const a = record.args ?? {};
  if (record.tool !== TOOL || record.verb !== 'send' || typeof a.text !== 'string' || !a.text) {
    discardPending(env.pending, code);
    env.out(JSON.stringify({ ok: false, error: 'bad_record', message: `Refusing to run a record for ${record.tool}/${record.verb}; record discarded.` }));
    return 1;
  }
  // Resolve again now: the preview a human approves is what will actually happen.
  const plan = resolveSend(env, a.recipient, { chat: a.chat, service: a.service });
  if (plan.error) {
    env.err(`${CLI}: staged send ${code} no longer resolves: ${plan.error}. Record kept until ${record.expires}; discard with: toolbelt approve ${TOOL} --discard ${code}`);
    return 1;
  }
  env.err(`\nStaged send ${code} — ${record.summary}\n  staged : ${record.created}   expires: ${record.expires}`);
  env.err(renderSendPreview(plan, a.text));
  const answer = env.tty.readLine(sendPrompt(plan, ' An agent composed this without a terminal; it waits for you.'));
  if (answer === null) {
    env.err(`${CLI}: approve needs /dev/tty to take the typed word; record kept. Run \`toolbelt approve ${TOOL} ${code}\` in a real terminal.`);
    return 4;
  }
  if (!typedEchoMatches(answer, SEND_WORD)) {
    env.out(JSON.stringify({ ok: false, error: 'send_not_confirmed', message: `Not sent. Staged send ${code} is kept until ${record.expires}; discard with: toolbelt approve ${TOOL} --discard ${code}` }));
    return 3;
  }
  try {
    return deliver(env, plan, a.text, `approve:${code}`);
  } finally {
    discardPending(env.pending, code); // single use, whether the send succeeded or not
  }
}

// ---------------------------------------------------------------- cli

const HELP = `${CLI} — iMessage/SMS on this Mac: read the Messages database; send one message behind a human gate

reads (free; chat.db opened read-only)
  ${CLI} chats [--limit N]                         recent conversations with ids
  ${CLI} history <id|phone|email|name> [--limit N] [--since 7d|ISO] [--changed] [--after-rowid N]
      --changed       also old messages edited or unsent inside the --since window
      --after-rowid   only rows written after row N (catches late-synced messages; stderr prints the newest row)
  ${CLI} thread <guid>                             a message and every inline reply to it, any age
  ${CLI} search <text> [--chat <id|who>] [--since …] [--limit N]
  ${CLI} whois <phone|email|name>                  contact ↔ handles ↔ chats
  ${CLI} watch [<who>|--chat <id>] [--interval S] [--for S]   print new messages as they arrive
  ${CLI} export <who>|--chat <id>|--all --out <file.jsonl> [--since …] [--changed] [--after-rowid N] [--limit N] [--explain]

write-gated (tty) — one message, as you
  ${CLI} send <phone|email|name> <text…>           preview, then type "send" at the terminal
  ${CLI} send --chat <id> <text…>                  a group or any existing chat
      --service imessage|sms   force the service for a handle   --explain  preview only
      with no terminal the send is STAGED: a human runs  toolbelt approve ${TOOL} <code>
      --yes skips the typed word only where /dev/tty opens; without a terminal it stages anyway

approve (what \`toolbelt approve ${TOOL} …\` runs)
  ${CLI} approve <code> | --list | --discard <code>

flags   --json  one JSON object per line (reads)
limits  --limit default ${LIMIT_DEFAULT}, max ${LIMIT_MAX} · search scans ≤ ${SEARCH_SCAN_CEILING} rows · export ≤ ${EXPORT_MAX} rows · send ≤ ${TEXT_MAX} chars
env     IMSG_CHAT_DB  IMSG_CONTACTS_DIR  IMSG_HOME (default ~/.local/share/imessage: pending/, audit.log)`;

function usage(env, msg) {
  env.err(`${CLI}: ${msg}\n\n${HELP}`);
  return 2;
}

function openError(env, e) {
  if (/unable to open|authorization denied|not authorized|SQLITE_CANTOPEN|SQLITE_AUTH/i.test(String(e.message))) {
    env.err(`${CLI}: cannot open ${display(env.chatDb)} — ${e.message}`);
    env.err(`Grant Full Disk Access to your terminal app in System Settings › Privacy & Security › Full Disk Access, then restart the terminal.`);
    return 1;
  }
  throw e;
}

export function main(argv, overrides = {}) {
  const env = makeEnv(overrides);
  const { flags, positional } = parseArgs(argv);
  const [verb, ...rest] = positional;
  if (!verb || flags.help || verb === 'help') { env.out(HELP); return verb ? 0 : 2; }
  try {
    switch (verb) {
      case 'chats': return cmdChats(env, flags);
      case 'history': return cmdHistory(env, rest.join(' '), flags);
      case 'thread': return cmdThread(env, rest.join(' '), flags);
      case 'search': return cmdSearch(env, rest.join(' '), flags);
      case 'whois': return cmdWhois(env, rest.join(' '), flags);
      case 'watch': return cmdWatch(env, rest.join(' '), flags);
      case 'export': return cmdExport(env, rest.join(' '), flags);
      case 'send': return cmdSend(env, rest, flags);
      case 'approve': return cmdApprove(env, rest, flags);
      default: return usage(env, `unknown verb "${verb}"`);
    }
  } catch (e) {
    return openError(env, e);
  } finally {
    try { env._db?.close(); } catch { /* already closed */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
