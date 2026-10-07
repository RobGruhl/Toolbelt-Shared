/**
 * Off-hours gating for CLI bulk operations.
 *
 * Slack is a production system shared with your whole company. Bulk API
 * sweeps (a year of messages, every page of a channel) should run outside
 * business hours so they never compete with the people using it. The window
 * is configuration (SLACK_BUSINESS_HOURS "HH-HH", SLACK_BUSINESS_TZ an IANA
 * zone; Monday-Friday fixed) and `--force` always overrides, loudly.
 */

import { callSlackApi } from '../auth.js';
import { getBusinessHours } from './config.js';

/**
 * search.messages is paged at this size (lib/queries.js `count: 100`). A
 * request that cannot exceed one page makes exactly one API call.
 */
export const SINGLE_PAGE_SIZE = 100;

function pad(h) {
  return String(h).padStart(2, '0');
}

/** "Mon-Fri 06:00-18:00 America/Los_Angeles" for banners and errors. */
export function describeBusinessHours(window = getBusinessHours()) {
  return `Mon-Fri ${pad(window.startHour)}:00-${pad(window.endHour)}:00 ${window.timeZone}`;
}

/**
 * Warning text for the CLI banner and scripts. Resolved lazily so `--help`
 * works before any configuration exists; a bad window setting is reported
 * inline instead of crashing the banner.
 */
export function bulkWarning() {
  let window;
  try {
    window = describeBusinessHours();
  } catch (e) {
    window = `(business-hours config invalid: ${e.message})`;
  }
  return (
    'WARNING: Slack is a production system shared with your whole company.\n' +
    `Bulk operations should be run outside business hours (${window})\n` +
    'to minimize API impact. Use --force to override during business hours.'
  );
}

/**
 * Weekday (0=Sun..6=Sat) and hour (0-23) of `now` in `timeZone`, read from
 * Intl parts rather than re-parsing a locale string, so the answer does not
 * depend on how the host formats dates.
 */
function localParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  return { day, hour: hour === 24 ? 0 : hour };
}

/**
 * Check if the current time is within business hours.
 *
 * @param {Date} [now] - injectable for tests
 * @param {{startHour:number,endHour:number,timeZone:string}} [window] - injectable for tests
 * @returns {{ isBusinessHours: boolean, currentTime: string, timezone: string, window: string }}
 */
export function checkBusinessHours(now = new Date(), window = getBusinessHours()) {
  const { day, hour } = localParts(now, window.timeZone);

  const isWeekday = day >= 1 && day <= 5;
  const isDuringHours = hour >= window.startHour && hour < window.endHour;
  const isBusinessHours = isWeekday && isDuringHours;

  const currentTime = now.toLocaleString('en-US', {
    timeZone: window.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return {
    isBusinessHours,
    currentTime,
    timezone: window.timeZone,
    window: describeBusinessHours(window),
  };
}

/**
 * Enforce off-hours for bulk CLI operations.
 * Exits with error during business hours unless --force is used.
 *
 * @param {boolean} force - If true, allow during business hours with warning
 */
export function enforceOffHours(force = false) {
  const { isBusinessHours, currentTime, window } = checkBusinessHours();

  if (!isBusinessHours) {
    return; // Outside business hours, proceed normally
  }

  if (force) {
    console.error(`[safeguard] WARNING: Running during business hours (${currentTime})`);
    console.error('[safeguard] Slack is a shared production system - proceeding because --force was used');
    console.error('');
    return;
  }

  console.error(`[safeguard] BLOCKED: Current time is ${currentTime} (business hours)`);
  console.error('[safeguard] Slack is a production system shared with your whole company.');
  console.error(`[safeguard] Bulk operations should run outside ${window}.`);
  console.error('[safeguard] Use --force to override this check, or change the window with');
  console.error('[safeguard] SLACK_BUSINESS_HOURS / SLACK_BUSINESS_TZ.');
  process.exit(1);
}

/**
 * True when a `channel` read is bounded to a single search page — either
 * `--max-pages 1` or `--max-results` at or under the page size. Pure function
 * of the options, so the decision is testable and the CLI cannot drift from it.
 */
export function isSinglePageRead({ maxPages, maxResults } = {}) {
  if (maxPages === 1) return true;
  return Number.isFinite(maxResults) && maxResults > 0 && maxResults <= SINGLE_PAGE_SIZE;
}

/**
 * Does the off-hours gate apply to this channel read?
 *
 * One page of a private channel the caller is a member of is not a bulk
 * operation — it is the same single targeted read `thread` and `download`
 * already make ungated, against a room the caller is already in. So it is
 * exempt. Everything else keeps the gate: multi-page reads (a sweep, whatever
 * the room), and any public channel (where a one-page read is the first step
 * of the catalog-style pulls the gate exists for).
 *
 * Fails CLOSED: if conversations.info cannot be read, or the channel is not
 * private, or membership is not affirmatively true, the gate applies.
 * `api` is injectable so the decision is testable without a network.
 *
 * @returns {Promise<{exempt: boolean, reason: string}>}
 */
export async function channelReadExemption(opts, channelId, cookies, token, api = callSlackApi) {
  if (!isSinglePageRead(opts)) return { exempt: false, reason: 'multi-page read' };
  try {
    const info = await api('conversations.info', { channel: channelId }, cookies, token);
    if (!info?.ok) return { exempt: false, reason: `conversations.info: ${info?.error || 'not ok'}` };
    const c = info.channel || {};
    if (!c.is_private) return { exempt: false, reason: 'public channel' };
    if (c.is_member !== true) return { exempt: false, reason: 'not a member' };
    return { exempt: true, reason: 'single page of a private channel you are a member of' };
  } catch (e) {
    return { exempt: false, reason: `conversations.info failed: ${e.message}` };
  }
}
