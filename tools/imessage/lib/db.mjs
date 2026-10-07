// db.mjs — read-only queries over ~/Library/Messages/chat.db.
//
// The database is opened with { readOnly: true } and never with a write handle, so no code
// path in this module can change it. Messages keeps writing to it while we read (WAL mode);
// a read-only connection still sees committed rows, which is what `watch` and send's
// re-read rely on.
import { DatabaseSync } from 'node:sqlite';
import { messageText } from './typedstream.mjs';
import { handleKey } from './contacts.mjs';

/** Seconds between the Unix epoch and Apple's (2001-01-01T00:00:00Z). */
export const APPLE_EPOCH_S = 978307200;

/** chat.db stores nanoseconds since 2001 on current macOS and seconds on old databases. */
export function appleToMs(v) {
  if (v === null || v === undefined || v === 0) return null;
  const n = Number(v);
  const s = Math.abs(n) > 1e12 ? n / 1e9 : n;
  return Math.round((s + APPLE_EPOCH_S) * 1000);
}

export function msToApple(ms) {
  return BigInt(Math.round(ms / 1000 - APPLE_EPOCH_S)) * 1_000_000_000n;
}

/** chat.style: 43 is a group conversation, 45 a one-to-one. */
export const GROUP_STYLE = 43;

const TAPBACKS = {
  2000: 'loved', 2001: 'liked', 2002: 'disliked', 2003: 'laughed at', 2004: 'emphasized', 2005: 'questioned', 2006: 'reacted to',
  3000: 'removed a heart from', 3001: 'removed a like from', 3002: 'removed a dislike from', 3003: 'removed a laugh from',
  3004: 'removed an emphasis from', 3005: 'removed a question from', 3006: 'removed a reaction from',
};

/** Read-only, and integers as BigInt: `date` columns are nanoseconds and overflow a double's
 *  exact range, which node:sqlite otherwise refuses to return. Every shaped value is a Number. */
export function openChatDb(file) {
  return new DatabaseSync(file, { readOnly: true, readBigInts: true });
}

const MSG_COLS = `m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.date_read, m.date_delivered,
  m.is_from_me, m.is_sent, m.is_delivered, m.is_read, m.error, m.service, m.item_type,
  m.associated_message_type, m.associated_message_emoji, m.cache_has_attachments,
  m.date_edited, m.date_retracted, m.thread_originator_guid, m.associated_message_guid,
  m.balloon_bundle_id, m.group_title, h.id AS handle`;

/** associated_message_guid carries a part prefix ("p:0/…", "bp:…"); the bare guid is the target. */
export function targetGuid(v) {
  return v ? String(v).replace(/^(?:p:\d+\/|bp:)/, '') : null;
}

/**
 * A tapback from an SMS/RCS phone arrives as text ("Loved “see you at 7”"), not as a reaction
 * row. Recognised only on SMS/RCS rows, so an iMessage that happens to start with "Loved" stays
 * a message.
 */
const FALLBACK_REACTION = /^(?:Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Reacted \S+ to) [“"].*[”"]$/su;

const iso = (v) => { const ms = appleToMs(v); return ms === null ? null : new Date(ms).toISOString(); };

/** Shape a raw message row into what every verb prints. `names` maps handleKey → contact name. */
export function shapeMessage(row, names, chat = null) {
  const amt = Number(row.associated_message_type ?? 0);
  let kind = 'message';
  let text = messageText(row);
  if (amt >= 2000 && amt < 4000) {
    kind = 'reaction';
    const verb = TAPBACKS[amt] ?? 'reacted to';
    const emoji = amt === 2006 && row.associated_message_emoji ? ` ${row.associated_message_emoji}` : '';
    text = `${verb}${emoji} a message`;
  } else if (Number(row.item_type ?? 0) !== 0) {
    kind = 'event';
    if (row.group_title) text = `named the conversation "${row.group_title}"`;
  }
  let fallback = false;
  if (kind === 'message' && /^(SMS|RCS)$/i.test(row.service ?? '') && text && FALLBACK_REACTION.test(text.trim())) {
    kind = 'reaction';
    fallback = true;
  }
  const fromMe = Number(row.is_from_me) === 1;
  const who = fromMe ? 'me' : (row.handle ? (names?.get(handleKey(row.handle)) ?? row.handle) : 'unknown');
  const out = {
    rowid: Number(row.rowid),
    guid: row.guid,
    date: new Date(appleToMs(row.date)).toISOString(),
    from_me: fromMe,
    from: who,
    handle: row.handle ?? null,
    service: row.service ?? null,
    kind,
    text: text ?? '',
  };
  if (chat) out.chat = chat;
  if (fromMe) {
    out.delivered = Number(row.is_delivered) === 1;
    if (Number(row.error)) out.error = Number(row.error);
  }
  if (row.thread_originator_guid) out.reply_to = row.thread_originator_guid;
  if (kind === 'reaction' && row.associated_message_guid) out.reacts_to = targetGuid(row.associated_message_guid);
  if (fallback) out.reaction_fallback = true;
  if (row.date_edited) { out.edited = true; out.edited_at = iso(row.date_edited); }
  if (row.date_retracted) { out.unsent = true; out.unsent_at = iso(row.date_retracted); }
  if (row.balloon_bundle_id) out.app = row.balloon_bundle_id;
  return out;
}

export function attachmentsFor(db, rowids) {
  const map = new Map();
  if (!rowids.length) return map;
  const q = db.prepare(`SELECT maj.message_id AS mid, a.transfer_name, a.filename, a.mime_type, a.total_bytes
    FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ?`);
  for (const id of rowids) {
    const rows = q.all(id);
    if (rows.length) map.set(id, rows.map((a) => ({ name: a.transfer_name ?? (a.filename ? a.filename.split('/').pop() : null), mime: a.mime_type ?? null, bytes: Number(a.total_bytes ?? 0), path: a.filename ?? null })));
  }
  return map;
}

/** Participants (raw handle ids) of each chat. */
function participantsOf(db, chatId) {
  return db.prepare(`SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ? ORDER BY h.id`).all(chatId).map((r) => r.id);
}

export function chatLabel(chat, names) {
  if (chat.display_name) return chat.display_name;
  const ps = chat.participants ?? [];
  if (!ps.length) return chat.chat_identifier;
  return ps.map((h) => names?.get(handleKey(h)) ?? h).join(', ');
}

export function getChat(db, chatId, names) {
  const c = db.prepare(`SELECT ROWID AS id, guid, chat_identifier, display_name, service_name, style FROM chat WHERE ROWID = ?`).get(chatId);
  if (!c) return null;
  c.id = Number(c.id);
  c.style = Number(c.style);
  c.group = c.style === GROUP_STYLE;
  c.participants = participantsOf(db, c.id);
  c.label = chatLabel(c, names);
  return c;
}

/** Most recent chats first, with participants, message count and last activity. */
export function listChats(db, names, limit) {
  const rows = db.prepare(`SELECT c.ROWID AS id, c.guid, c.chat_identifier, c.display_name, c.service_name, c.style,
      MAX(cmj.message_date) AS last_date, COUNT(cmj.message_id) AS n
    FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    GROUP BY c.ROWID ORDER BY last_date DESC LIMIT ?`).all(limit);
  return rows.map((c) => {
    const chat = { id: Number(c.id), guid: c.guid, chat_identifier: c.chat_identifier, display_name: c.display_name || null, service: c.service_name, group: Number(c.style) === GROUP_STYLE, participants: participantsOf(db, Number(c.id)), messages: Number(c.n), last: new Date(appleToMs(c.last_date)).toISOString() };
    chat.label = chatLabel(chat, names);
    return chat;
  });
}

/** Handle rows (ROWIDs) whose id matches the given handle under handleKey. */
export function handleRowsFor(db, handle) {
  const k = handleKey(handle);
  if (!k) return [];
  return db.prepare('SELECT ROWID AS rowid, id, service FROM handle').all().filter((h) => handleKey(h.id) === k).map((h) => ({ rowid: Number(h.rowid), id: h.id, service: h.service }));
}

/** One-to-one chats with a handle (iMessage and SMS threads are separate chats), newest first. */
export function directChatsFor(db, handle) {
  const hs = handleRowsFor(db, handle);
  if (!hs.length) return [];
  const ids = hs.map((h) => h.rowid);
  const rows = db.prepare(`SELECT c.ROWID AS id, c.guid, c.service_name, c.style, MAX(cmj.message_date) AS last_date, COUNT(cmj.message_id) AS n
    FROM chat c JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    WHERE chj.handle_id IN (${ids.map(() => '?').join(',')}) AND c.style != ${GROUP_STYLE}
    GROUP BY c.ROWID ORDER BY last_date DESC`).all(...ids);
  return rows.map((c) => ({ id: Number(c.id), guid: c.guid, service: c.service_name, messages: Number(c.n), last: c.last_date ? new Date(appleToMs(c.last_date)).toISOString() : null }));
}

/**
 * Messages of the given chats (null = every chat), newest `limit`, oldest first.
 * `sinceMs` matches the send time; with `changed` it also matches an edit or unsend inside the
 * window, so an old message changed today is not missed. `afterRowid` keeps only rows written to
 * the database after that row — the watermark that catches messages synced late with an old date.
 */
export function messagesIn(db, chatIds, { limit, sinceMs = null, changed = false, afterRowid = null }, names) {
  if (chatIds !== null && !chatIds.length) return [];
  const since = sinceMs === null ? 0n : msToApple(sinceMs);
  const conds = [];
  const params = [];
  if (chatIds !== null) { conds.push(`cmj.chat_id IN (${chatIds.map(() => '?').join(',')})`); params.push(...chatIds); }
  if (changed && sinceMs !== null) { conds.push('(m.date >= ? OR m.date_edited >= ? OR m.date_retracted >= ?)'); params.push(since, since, since); }
  else { conds.push('m.date >= ?'); params.push(since); }
  if (afterRowid !== null) { conds.push('m.ROWID > ?'); params.push(afterRowid); }
  const rows = db.prepare(`SELECT ${MSG_COLS}, cmj.chat_id AS chat_id
    FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE ${conds.join(' AND ')}
    ORDER BY m.date DESC LIMIT ?`).all(...params, limit);
  const atts = attachmentsFor(db, rows.filter((r) => Number(r.cache_has_attachments)).map((r) => Number(r.rowid)));
  return rows.reverse().map((r) => {
    const m = shapeMessage(r, names, Number(r.chat_id));
    const a = atts.get(m.rowid);
    if (a) m.attachments = a;
    return m;
  });
}

/**
 * Case-insensitive text search, newest first. The text lives in a blob for most rows, so the
 * match happens after decoding, over at most `scanCeiling` rows.
 */
export function searchMessages(db, query, { limit, sinceMs = null, chatIds = null, scanCeiling }, names) {
  const needle = query.toLowerCase();
  const since = sinceMs === null ? 0n : msToApple(sinceMs);
  const where = chatIds?.length ? `AND cmj.chat_id IN (${chatIds.map(() => '?').join(',')})` : '';
  const stmt = db.prepare(`SELECT ${MSG_COLS}, cmj.chat_id AS chat_id
    FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.date >= ? ${where} ORDER BY m.date DESC LIMIT ?`);
  const hits = [];
  let scanned = 0;
  for (const r of stmt.iterate(since, ...(chatIds ?? []), scanCeiling)) {
    scanned++;
    const t = messageText(r);
    if (t && t.toLowerCase().includes(needle)) {
      hits.push(shapeMessage(r, names, Number(r.chat_id)));
      if (hits.length >= limit) break;
    }
  }
  return { hits, scanned, capped: scanned >= scanCeiling };
}

/**
 * One inline-reply thread: the message that started it, then every reply to it (any age),
 * oldest first. Replies to a message older than a read window carry `reply_to`; this is how the
 * caller fetches what they answer.
 */
export function threadOf(db, guid, names) {
  const rows = db.prepare(`SELECT ${MSG_COLS}, cmj.chat_id AS chat_id
    FROM message m LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.guid = ? OR m.thread_originator_guid = ? ORDER BY m.date ASC`).all(guid, guid);
  const atts = attachmentsFor(db, rows.filter((r) => Number(r.cache_has_attachments)).map((r) => Number(r.rowid)));
  return rows.map((r) => {
    const m = shapeMessage(r, names, r.chat_id === null ? null : Number(r.chat_id));
    const a = atts.get(m.rowid);
    if (a) m.attachments = a;
    return m;
  });
}

export function maxRowid(db) {
  return Number(db.prepare('SELECT MAX(ROWID) AS m FROM message').get().m ?? 0);
}

/** Messages with ROWID > after, oldest first (the `watch` poll and send's re-read). */
export function messagesAfter(db, after, names, { chatIds = null, limit = 500 } = {}) {
  const where = chatIds?.length ? `AND cmj.chat_id IN (${chatIds.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT ${MSG_COLS}, cmj.chat_id AS chat_id
    FROM message m LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.ROWID > ? ${where} ORDER BY m.ROWID ASC LIMIT ?`).all(after, ...(chatIds ?? []), limit);
  return rows.map((r) => shapeMessage(r, names, r.chat_id === null ? null : Number(r.chat_id)));
}
