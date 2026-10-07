// cups.mjs — thin, pure-ish wrappers over the macOS CUPS command line (lp, lpstat, lpoptions,
// cancel, cupsenable) and ipptool against the printer's own IPP endpoint. Every call is a
// spawned binary with a timeout; nothing here decides to print — that is print.mjs's job.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
export const IPP_TIMEOUT_S = 8;          // ipptool -T: a sleeping/wedged printer must not hang us
export const CMD_TIMEOUT_MS = 30_000;    // lp/lpstat/cancel
export const IPPTOOL_TESTS = '/usr/share/cups/ipptool';

export async function run(bin, args, { timeout = CMD_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await execFileP(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message), code: err.code ?? 1, killed: !!err.killed };
  }
}

// ---- lpstat parsers (pure) --------------------------------------------------

/** `lpstat -p -d` → [{name, state, reason, since}], default name */
export function parseLpstatPrinters(text) {
  const printers = [];
  let dflt = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^printer (\S+) (is idle|now printing \S+|disabled since .*?)\.\s*(?:enabled since (.*))?$/.exec(line))) {
      const status = m[2].startsWith('is idle') ? 'idle' : m[2].startsWith('now printing') ? 'printing' : 'disabled';
      printers.push({ name: m[1], state: status, since: m[3] ?? null, reason: null });
    } else if ((m = /^printer (\S+) disabled since (.*?) -$/.exec(line))) {
      printers.push({ name: m[1], state: 'disabled', since: m[2], reason: null });
    } else if ((m = /^\s+(.+)$/.exec(line)) && printers.length) {
      const p = printers[printers.length - 1];
      if (!p.reason) p.reason = m[1].trim();
    } else if ((m = /^system default destination: (\S+)/.exec(line))) {
      dflt = m[1];
    }
  }
  return { printers, default: dflt };
}

/** `lpstat -v` → {name: deviceUri} */
export function parseLpstatDevices(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^device for (\S+): (.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** `lpstat -o` → [{id, printer, seq, user, bytes, submitted}] */
export function parseLpstatJobs(text) {
  const jobs = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line.trim());
    if (m) jobs.push({ id: `${m[1]}-${m[2]}`, printer: m[1], seq: Number(m[2]), user: m[3], bytes: Number(m[4]), submitted: m[5].trim() });
  }
  return jobs;
}

/** `ipptool -tv … .test` output → {attrs, groups, passed}. `attrs` merges every attribute
 *  (repeats become arrays); `groups` keeps each attribute set separate — a get-jobs response
 *  is one group per job, and a name that repeats inside a group starts the next one. */
export function parseIpptool(text) {
  const attrs = {};
  const groups = [];
  let cur = null;
  let passed = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^\s+([A-Za-z0-9-]+) \(([^)]*)\) = (.*)$/.exec(line))) {
      const [, name, type, value] = m;
      const v = type.startsWith('1setOf') ? value.split(',').map((x) => x.trim()) : value;
      if (name in attrs) attrs[name] = [].concat(attrs[name], v); else attrs[name] = v;
      if (!cur || name in cur) { cur = {}; groups.push(cur); }
      cur[name] = v;
    } else if (/\[PASS\]/.test(line)) passed = passed ?? true;
    else if (/\[FAIL\]/.test(line)) passed = false;
  }
  return { attrs, groups, passed };
}

/** The IPP URI to talk to the printer directly, from a CUPS device URI. ipp/ipps are used as
 *  is; dnssd:// carries only the Bonjour service name and must be resolved (resolveUri). */
export function directIppUri(deviceUri) {
  if (!deviceUri) return null;
  const m = /^(ipps?):\/\/([^/]+)(\/.*)?$/.exec(deviceUri);
  if (!m) return null;
  const host = m[2].replace(/\.(?=:\d+$|$)/, '');   // 'BRW1.local.:631' → 'BRW1.local:631'
  return `${m[1]}://${host}${m[3] ?? '/ipp/print'}`;
}

/** dnssd://Brother%20MFC-L2750DW%20series._ipp._tcp.local./?uuid=… → the ippfind service name */
export function dnssdService(deviceUri) {
  const m = /^dnssd:\/\/([^/?]+)/.exec(deviceUri ?? '');
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/\.?$/, '.');   // "Name._ipp._tcp.local."
}

export const RESOLVE_TIMEOUT_S = 3;

/** Resolve a queue's device URI to a direct IPP URI, via ippfind for dnssd queues. A resolver
 *  cache (`cache` = {get(name), set(name, uri)}) avoids the 3s Bonjour wait on every call;
 *  a cached URI that stops answering is dropped by the caller. Returns null when there is no
 *  IPP path (usb://, socket://) or the printer is not on the network right now. */
export async function resolveUri(name, deviceUri, cache = null) {
  const direct = directIppUri(deviceUri);
  if (direct) return direct;
  const service = dnssdService(deviceUri);
  if (!service) return null;
  const cached = cache?.get(name);
  if (cached) return cached;
  const r = await run('ippfind', [service, '-T', String(RESOLVE_TIMEOUT_S)], { timeout: (RESOLVE_TIMEOUT_S + 3) * 1000 });
  const uri = r.stdout.split('\n').map((l) => l.trim()).find((l) => /^ipps?:\/\//.test(l)) ?? null;
  if (uri && cache) cache.set(name, uri);
  return uri;
}

// ---- live calls --------------------------------------------------------------

export async function lpstatPrinters() {
  const r = await run('lpstat', ['-p', '-d']);
  return parseLpstatPrinters(r.stdout);
}
export async function lpstatDevices() {
  const r = await run('lpstat', ['-v']);
  return parseLpstatDevices(r.stdout);
}
export async function lpstatJobs() {
  const r = await run('lpstat', ['-o']);
  return parseLpstatJobs(r.stdout);
}

/** Run one bundled ipptool test against a URI; `defs` become -d name=value. */
export async function ipp(uri, testName, defs = {}) {
  const args = ['-T', String(IPP_TIMEOUT_S), '-tv'];
  for (const [k, v] of Object.entries(defs)) args.push('-d', `${k}=${v}`);
  args.push(uri, `${IPPTOOL_TESTS}/${testName}`);
  const r = await run('ipptool', args, { timeout: (IPP_TIMEOUT_S + 4) * 1000 });
  const parsed = parseIpptool(r.stdout + '\n' + r.stderr);
  return { ...parsed, ok: r.ok || parsed.attrs['printer-state'] !== undefined || parsed.attrs['job-id'] !== undefined, raw: r };
}

/** Jobs the printer itself holds: the get-jobs groups that carry a job-id. */
export function groupJobs(groups) {
  return (groups ?? []).filter((g) => g['job-id'] !== undefined).map((g) => ({
    id: Number(g['job-id']),
    state: g['job-state'] ?? null,
    reasons: [].concat(g['job-state-reasons'] ?? []).join(','),
    name: String(g['job-name'] ?? '').replace(/\[en-us\]$/i, ''),
    progress: g['job-impressions-completed'] ?? null,
  }));
}
