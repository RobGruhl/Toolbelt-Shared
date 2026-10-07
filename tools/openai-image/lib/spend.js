// What oimg has really spent, and the hard ask before it spends more.
//
// Real spend comes from the audit log's token counts at TOKEN_RATES. The per-image estimate is
// used only for lines that carry no tokens. Per-call ceilings never caught the real failure:
// 513 renders, each under $2, that added up to about $100 in one afternoon. So the hard ask is
// on the ROLLING 24-HOUR TOTAL. It only applies to calls that go through this CLI; code that
// imports lib/gpt-image.js directly isn't covered.
//
// Passing the ask needs the operator's say-so. The caller stops (exit 3) and asks. Once the
// operator acknowledges an amount, `oimg allow --usd N --note "<their words>" --yes` appends an
// allowance, logged with the note. It permits N more on top of the spend at that moment, for 24h.

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { TOKEN_RATES } from './constants.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse one audit line into {at, model, usd, tokens}. Returns null for anything else. */
export function auditCost(line) {
  if (!line.startsWith('[oimg audit] ')) return null;
  const at = Date.parse(line.slice(13, 37));
  if (Number.isNaN(at)) return null;
  const f = Object.fromEntries([...line.matchAll(/(\w+)=("[^"]*"|\S+)/g)].map(m => [m[1], m[2]]));
  const out = Number(f.tokens_out), inp = Number(f.tokens_in);
  const rates = TOKEN_RATES[f.model];
  if (rates && Number.isFinite(out)) {
    // tokens_in is text for generate/responses; an edit's image input is billed higher, so price it as image-in (upper bound)
    const inRate = f.verb === 'edit' ? rates.imageIn : rates.textIn;
    return { at, model: f.model, usd: (out * rates.imageOut + (Number.isFinite(inp) ? inp * inRate : 0)) / 1e6, tokens: true };
  }
  const est = Number(f.est_usd);
  return { at, model: f.model, usd: Number.isFinite(est) ? est : 0, tokens: false };
}

/** Spend in the window ending `now` (default: the last 24 hours), from the audit log. */
export function spentSince(auditFile, now = Date.now(), windowMs = DAY_MS) {
  let usd = 0, images = 0, estimated = 0;
  if (!existsSync(auditFile)) return { usd, images, estimated };
  for (const line of readFileSync(auditFile, 'utf8').split('\n')) {
    const c = auditCost(line);
    if (!c || c.at <= now - windowMs || c.at > now) continue;
    usd += c.usd; images++;
    if (!c.tokens) estimated++;
  }
  return { usd, images, estimated };
}

/**
 * The line the operator's allowances set. Each allowance is JSON {at, usd, base, note}, where
 * base is the real 24h spend when it was granted. It permits `usd` more ON TOP OF that, so a
 * yes for "$2 more" means $2 more even when spend is already past the line. Returns the
 * highest base + usd among allowances still inside the window (0 if none). An allowance with
 * no base is treated as base 0.
 */
export function allowedSince(allowFile, now = Date.now(), windowMs = DAY_MS) {
  let top = 0;
  if (!existsSync(allowFile)) return top;
  for (const line of readFileSync(allowFile, 'utf8').split('\n')) {
    try {
      const a = JSON.parse(line);
      const at = Date.parse(a.at);
      if (at > now - windowMs && at <= now && a.usd > 0) top = Math.max(top, (Number(a.base) || 0) + a.usd);
    } catch { /* blank or torn line */ }
  }
  return top;
}

/** Would a call estimated at `est` pass the line? Pure given the two files. */
export function checkSpend({ auditFile, allowFile, est, line, now = Date.now() }) {
  const spent = spentSince(auditFile, now);
  const allowed = allowedSince(allowFile, now);
  const limit = Math.max(line, allowed);
  return { ...spent, allowed, limit, est, over: spent.usd + (est ?? 0) > limit };
}

export function recordAllowance(allowFile, usd, now = new Date(), note = '', base = 0) {
  mkdirSync(path.dirname(allowFile), { recursive: true, mode: 0o700 });
  appendFileSync(allowFile, JSON.stringify({ at: now.toISOString(), usd, base: Math.round(base * 100) / 100, note }) + '\n', { mode: 0o600 });
}
