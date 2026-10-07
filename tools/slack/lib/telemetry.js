/**
 * Process-local health counters for the current Node invocation.
 *
 * Auth's retry loop in auth.js increments these so callers can inspect
 * Slack health after a batch of calls. Counters are best-effort and reset
 * per process — there is no persistence.
 *
 * Typical usage:
 *   import { getTelemetry, resetTelemetry } from './lib/telemetry.js';
 *   // ... make a bunch of API calls ...
 *   console.error(JSON.stringify(getTelemetry()));
 *
 * Bulk-pull scripts (scripts/example-bulk-pull.sh is the pattern) use this to detect degraded
 * Slack health and decide whether to keep going or abort.
 */

const counters = {
  rateLimitHits: 0,   // 429s or { ok: false, error: 'ratelimited' }
  retries: 0,         // any retry attempt (429 or transient 5xx/network)
  failedCalls: 0,     // calls that exhausted retries and threw
  okCalls: 0,         // calls that returned ok
};

export function incrementCounter(name, by = 1) {
  if (name in counters) counters[name] += by;
}

export function getTelemetry() {
  return { ...counters };
}

export function resetTelemetry() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}

/**
 * Format telemetry as a compact one-line string suitable for stderr.
 */
export function formatTelemetry() {
  const t = getTelemetry();
  return `rateLimitHits=${t.rateLimitHits} retries=${t.retries} failedCalls=${t.failedCalls} okCalls=${t.okCalls}`;
}
