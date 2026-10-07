// contacts.mjs — phone/email handles ↔ names, from the local Contacts databases.
//
// Contacts keeps one SQLite store per account under
// ~/Library/Application Support/AddressBook/Sources/<uuid>/AddressBook-v22.abcddb, plus a root
// store. All of them are read (read-only) and merged. The same Full Disk Access grant that
// opens chat.db opens these; with no Contacts store, names are simply absent and every verb
// still works on raw handles.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORE = 'AddressBook-v22.abcddb';

/** The key two spellings of one handle share: last 10 digits of a phone, lowercased email. */
export function handleKey(handle) {
  if (!handle) return '';
  const h = String(handle).trim();
  if (h.includes('@')) return h.toLowerCase();
  const digits = h.replace(/\D/g, '');
  if (!digits) return h.toLowerCase();
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** True when the string reads as a phone number or an email address rather than a name. */
export function looksLikeHandle(s) {
  if (!s) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;
  return /^\+?[\d\s().-]{7,}$/.test(s) && s.replace(/\D/g, '').length >= 7;
}

export function contactStores(dir) {
  if (!dir || !existsSync(dir)) return [];
  const stores = [];
  const root = path.join(dir, STORE);
  if (existsSync(root)) stores.push(root);
  const sources = path.join(dir, 'Sources');
  if (existsSync(sources)) {
    for (const s of readdirSync(sources)) {
      const f = path.join(sources, s, STORE);
      if (existsSync(f)) stores.push(f);
    }
  }
  return stores;
}

function displayName(r) {
  const full = [r.ZFIRSTNAME, r.ZLASTNAME].filter(Boolean).join(' ').trim();
  return full || r.ZORGANIZATION || r.ZNICKNAME || null;
}

/**
 * Load every contact that has at least one phone or email.
 * Returns { byKey: Map<handleKey, name>, people: [{ name, handles: [raw…] }], stores: n }.
 */
export function loadContacts(dir) {
  const byKey = new Map();
  const people = [];
  const stores = contactStores(dir);
  for (const file of stores) {
    let db;
    try { db = new DatabaseSync(file, { readOnly: true }); } catch { continue; }
    try {
      const names = new Map();
      for (const r of db.prepare('SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME FROM ZABCDRECORD').iterate()) {
        const n = displayName(r);
        if (n) names.set(r.Z_PK, { name: n, handles: [] });
      }
      const add = (owner, raw) => {
        const p = names.get(owner);
        if (!p || !raw) return;
        p.handles.push(raw);
        const k = handleKey(raw);
        if (k && !byKey.has(k)) byKey.set(k, p.name);
      };
      for (const r of db.prepare('SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER').iterate()) add(r.ZOWNER, r.ZFULLNUMBER);
      for (const r of db.prepare('SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS').iterate()) add(r.ZOWNER, r.ZADDRESS);
      for (const p of names.values()) if (p.handles.length) people.push(p);
    } catch {
      // a store with an unexpected schema contributes nothing rather than failing the read
    } finally {
      db.close();
    }
  }
  return { byKey, people, stores: stores.length };
}

/** Contacts whose name contains every word of the query (case-insensitive), handles de-duplicated. */
export function findPeople(contacts, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const merged = new Map();
  for (const p of contacts.people) {
    const n = p.name.toLowerCase();
    if (!words.every((w) => n.includes(w))) continue;
    const m = merged.get(p.name) ?? { name: p.name, handles: [] };
    for (const h of p.handles) if (!m.handles.some((x) => handleKey(x) === handleKey(h))) m.handles.push(h);
    merged.set(p.name, m);
  }
  return [...merged.values()];
}
