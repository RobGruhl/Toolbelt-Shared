#!/usr/bin/env node
// hp — token-cheap browser automation over @playwright/cli, with the belt's gates.
//
// Every verb shells out to the locally installed playwright-cli (node_modules/.bin), always
// from this directory so the config and the session registry are the tool's own. What this
// file adds on top of the upstream CLI:
//
//   containment   the default browser is an isolated, in-memory profile that holds no logins.
//                 Attaching to a browser that carries the operator's real sessions is a
//                 separate verb (`connect`) behind a /dev/tty typed-echo gate, staged for
//                 `toolbelt approve playwright <code>` when no terminal is present.
//   attached writes   once a session is attached to a real profile, every verb that acts on a
//                 page (click/fill/eval/…) is an authenticated action on a third-party system;
//                 it runs only with the loud, always-honored --attached-writes flag. Whether the
//                 session is attached is asked of playwright-cli itself (`list --json`, the same
//                 registry the action will use) right before the action. Attached is attached:
//                 a Chrome launch-debug opened counts too, because upstream records no endpoint
//                 and hp's own records are writable by the caller, so nothing hp stores can
//                 narrow the gate. sessions.json only supplies the endpoint label for status and
//                 audit lines. If playwright-cli cannot answer, the action is refused.
//   output dir    screenshot/pdf/snapshot/state-save land only under OUTPUT_DIR; an absolute
//                 path or a `..` segment is a usage error.
//   loopback only a CDP endpoint that is not loopback is refused unless --remote-ok.
//   one config   playwright-cli honors --config, --persistent, --profile and PLAYWRIGHT_MCP_*
//                 env vars, any of which can point a "read" verb at a real user-data-dir or a CDP
//                 endpoint. hp refuses those flags on every verb that would forward them, strips
//                 PLAYWRIGHT_MCP_*/PLAYWRIGHT_CLI_* from the child, and pins --config to its own
//                 .playwright/cli.config.json, so the only way to a real profile is `connect`.
//   audit         connect/detach/launch-debug/close and every attached write leave a line on
//                 stderr and in $HP_HOME/audit.log.
//   launch-debug  spawns Chrome with a debugging port on a profile dir the tool owns, never the
//                 default user-data-dir (Chrome >= 136 ignores the port there, and it is the
//                 real profile).
//
// Why /dev/tty and not stdin: whoever spawns this process owns its stdin and can pipe a "yes"
// into it. The controlling terminal cannot be forged from a child process; either a human is at
// it or it does not open.

import { spawnSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  writeFileSync, unlinkSync, chmodSync, appendFileSync, constants as FS } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const VERSION = '1.0.0';
export const TOOL = 'playwright';
export const CLI = 'hp';
export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- ceilings (SENSIBILITIES #3: code constants, raising one is a diff) ----
export const EXEC_TIMEOUT_MS = 60_000;      // one playwright-cli invocation
export const LAUNCH_WAIT_MS = 15_000;       // launch-debug waits this long for /json/version
export const PENDING_TTL_S = 15 * 60;       // a staged connect expires after this
export const DEFAULT_DEBUG_PORT = 9222;

// ---- verb tiers: the contract the manifest's verbs[] mirrors (the test asserts it) ----
// read:        free. Acts on nothing outside this machine, or only reads the page.
// interact:    acts on the page, navigation included. Free on an isolated profile; on an
//              attached session it needs --attached-writes (gate: containment). `open` on an
//              attached session is refused outright: upstream would stop (detach) that session
//              to start a fresh browser, and `close` is the verb for detaching.
// connect:     typed-echo on /dev/tty, staged headless, except for an endpoint hp launched.
export const VERBS = {
  read: ['snapshot', 'screenshot', 'pdf',
    'console', 'network', 'tab-list', 'cookie-list', 'cookie-get', 'localstorage-list',
    'localstorage-get', 'sessionstorage-list', 'sessionstorage-get', 'route-list',
    'state-save', 'list', 'status', 'launch-debug', 'close'],
  // Navigation is an action too: on an attached browser a GET under the operator's cookies
  // (logout, unsubscribe, OAuth consent, an admin URL) is as authenticated as a click.
  interact: ['open', 'goto', 'go-back', 'go-forward', 'reload',
    'click', 'dblclick', 'fill', 'type', 'press', 'keydown', 'keyup', 'select',
    'check', 'uncheck', 'hover', 'drag', 'upload', 'eval', 'run-code', 'mousemove',
    'mousedown', 'mouseup', 'mousewheel', 'dialog-accept', 'dialog-dismiss', 'tab-new',
    'tab-close', 'tab-select', 'resize', 'state-load', 'route', 'unroute', 'cookie-set',
    'cookie-delete', 'cookie-clear', 'localstorage-set', 'localstorage-delete',
    'localstorage-clear', 'sessionstorage-set', 'sessionstorage-delete', 'sessionstorage-clear'],
  connect: ['connect'],
  approve: ['approve'],
};
export const ALL_VERBS = Object.values(VERBS).flat();

// Verbs that take a --filename which must stay inside OUTPUT_DIR.
const FILE_VERBS = new Set(['screenshot', 'pdf', 'snapshot', 'state-save']);

// The tool's own playwright-cli config: isolated in-memory profile, no cdpEndpoint, no userDataDir.
export const CONFIG_FILE = path.join(TOOL_DIR, '.playwright', 'cli.config.json');
// Verbs whose upstream form accepts --config; hp pins it to CONFIG_FILE on these.
const CONFIG_VERBS = new Set(['open', 'attach']);

// Upstream options that re-point a call at another profile, browser or session. None is ever
// forwarded: a real profile is reachable only through `connect`, and the session only through -s.
// Exceptions are the two verbs that consume one of them themselves and never pass it on.
export const REFUSED_FLAGS = ['config', 'persistent', 'profile', 'user-data-dir', 'storage-state',
  'cdp', 'endpoint', 'extension', 'session', 's'];
const FLAG_EXCEPTIONS = { connect: new Set(['cdp', 'endpoint', 'extension']), 'launch-debug': new Set(['profile']) };

/**
 * The first refused option on this call: a refused long flag, any single-character flag key
 * (upstream aliases s/g/h/v, so `--s=real` is `--session=real` there), or any positional that
 * upstream's parser would read as an option. hp forwards positionals verbatim (including
 * everything after `--`, which upstream does not treat as a terminator), so every leading-dash
 * token there is refused — `-s=real` after `--` would otherwise re-point the action at an
 * attached session, and upstream reads `-1` as an option too, so there is no exemption.
 */
export function findRefusedFlag(verb, flags, args = []) {
  const allowed = FLAG_EXCEPTIONS[verb] ?? new Set();
  for (const k of Object.keys(flags)) if ((REFUSED_FLAGS.includes(k) || k.length === 1) && !allowed.has(k)) return k;
  for (const a of args) {
    if (typeof a !== 'string' || !a.startsWith('-')) continue;
    const m = /^--([^=]+)/.exec(a);
    if (m && allowed.has(m[1])) continue;
    return m ? m[1] : a.replace(/=.*$/, '');
  }
  return null;
}

// ---- environment ----
export function makeEnv(overrides = {}) {
  const home = overrides.home ?? process.env.HP_HOME ?? path.join(homedir(), '.cache', 'hello-playwright');
  const out = overrides.outputDir ?? process.env.PLAYWRIGHT_OUTPUT_DIR ?? path.join(TOOL_DIR, 'output');
  return {
    home,
    outputDir: out,
    sessionsFile: path.join(home, 'sessions.json'),
    auditFile: path.join(home, 'audit.log'),
    pending: path.join(home, 'pending'),
    launched: path.join(home, 'launched'),
    profiles: path.join(home, 'profiles'),
    bin: overrides.bin ?? path.join(TOOL_DIR, 'node_modules', '.bin', 'playwright-cli'),
    platform: overrides.platform ?? process.platform,
    out: overrides.out ?? ((s) => process.stdout.write(s + '\n')),
    err: overrides.err ?? ((s) => process.stderr.write(s + '\n')),
    tty: overrides.tty ?? ttyGate(overrides.platform ?? process.platform),
    now: overrides.now ?? (() => new Date()),
    spawn: overrides.spawn ?? spawnSync,
    ...overrides,
  };
}

function ensureHome(env) {
  for (const d of [env.home, env.pending, env.launched, env.profiles]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try { chmodSync(d, 0o700); } catch { /* not fatal */ }
  }
}

// ---- /dev/tty gate ----
export function ttyGate(platform) {
  if (platform === 'win32') return { has: () => false, readLine: () => null, why: 'Windows has no /dev/tty' };
  return {
    has() { try { closeSync(openSync('/dev/tty', 'r')); return true; } catch { return false; } },
    readLine() {
      let fd;
      try { fd = openSync('/dev/tty', 'r'); } catch { return null; }
      const buf = Buffer.alloc(1); let line = '';
      try {
        for (;;) {
          const n = readSync(fd, buf, 0, 1, null);
          if (n === 0) break;
          const ch = buf.toString('utf8');
          if (ch === '\n') break;
          line += ch;
        }
      } finally { closeSync(fd); }
      return line.replace(/\r$/, '');
    },
    why: 'no controlling terminal here',
  };
}

// ---- pure helpers (tested) ----

/** A --filename for screenshot/pdf/snapshot/state-save: relative, no `..`, lands under outputDir. */
export function containFilename(filename, outputDir) {
  if (typeof filename !== 'string' || !filename.trim()) return { ok: false, why: 'empty filename' };
  if (path.isAbsolute(filename)) return { ok: false, why: 'absolute paths are refused; files land under the output dir' };
  if (filename.split(/[\\/]/).includes('..')) return { ok: false, why: '".." segments are refused; files land under the output dir' };
  const resolved = path.resolve(outputDir, filename);
  const rel = path.relative(outputDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, why: 'path escapes the output dir' };
  return { ok: true, resolved, relative: rel };
}

/**
 * Classify a --cdp value. A channel name ("chrome", "msedge") means "attach to the running
 * daily-driver browser" — the real profile. A URL must be loopback unless remoteOk.
 */
export function classifyEndpoint(value, { remoteOk = false } = {}) {
  if (value === 'chrome' || value === 'msedge') return { ok: true, kind: 'channel', channel: value, profileClass: 'real', display: value };
  let u;
  try { u = new URL(value); } catch { return { ok: false, why: `not a channel (chrome|msedge) or a URL: ${value}` }; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return { ok: false, why: `unsupported scheme ${u.protocol}` };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^127\./.test(host);
  if (!loopback && !remoteOk) return { ok: false, why: `${host} is not loopback; a remote CDP endpoint is refused without --remote-ok` };
  const port = Number(u.port || (u.protocol.startsWith('ws') ? 80 : 80));
  return { ok: true, kind: 'url', url: value, host, port, loopback, profileClass: 'real', display: value };
}

/** A launch-debug profile name: one path segment, so it can only live under $HP_HOME/profiles. */
export function validProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== '.' && name !== '..';
}

export function validSessionName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

/** Parse argv: positional args, flags (--k=v / --k v / --k), and -s=name. Minimal and strict. */
export function parseArgs(argv) {
  const args = []; const flags = {}; let session;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-s=')) { session = a.slice(3); continue; }
    if (a === '-s') { session = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      // value-taking flags in the upstream CLI; everything else is boolean
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('-')) { flags[key] = next; i++; }
      else flags[key] = true;
      continue;
    }
    args.push(a);
  }
  return { args, flags, session };
}
const VALUE_FLAGS = new Set(['filename', 'type', 'browser', 'device', 'profile', 'cdp', 'endpoint',
  'extension', 'port', 'body', 'status', 'content-type', 'timeout', 'domain', 'path', 'level']);

// ---- session registry ----
export function readSessions(env) {
  try { return JSON.parse(readFileSync(env.sessionsFile, 'utf8')); } catch { return {}; }
}
export function writeSessions(env, sessions) {
  ensureHome(env);
  writeFileSync(env.sessionsFile, JSON.stringify(sessions, null, 2) + '\n', { mode: 0o600 });
}
export function sessionRecord(env, name) { return readSessions(env)[name] ?? { mode: 'isolated', profileClass: 'isolated' }; }

/**
 * Ask playwright-cli whether a session is attached. This is the registry the action itself will
 * run against (keyed by TOOL_DIR, under the OS cache dir), so no hp setting can separate the
 * gate's state from the state it guards. `ok: false` means the answer is unknown, and callers
 * refuse.
 */
export function cliAttached(env, name) {
  const r = runCli(env, ['list', '--json']);
  if (r.status !== 0) return { ok: false, why: r.stderr || r.error?.message || `playwright-cli list exited ${r.status}` };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { ok: false, why: 'playwright-cli list did not return JSON' }; }
  if (!Array.isArray(data?.browsers)) return { ok: false, why: 'playwright-cli list returned no browsers[]' };
  const entry = data.browsers.find((b) => b && b.name === name) ?? null;
  return { ok: true, attached: !!entry?.attached, open: !!entry, entry };
}

/**
 * What the gate sees for a session: attached (per playwright-cli) or not. Every attached session
 * is gated as the real profile — upstream records no endpoint, and hp's own records live in a
 * directory the caller can write, so they never narrow the gate. The record supplies only the
 * endpoint label.
 */
export function attachedProfile(env, name, cli) {
  const rec = readSessions(env)[name];
  if (!cli.attached) return { attached: false, profileClass: 'isolated', endpoint: rec?.endpoint };
  return { attached: true, profileClass: 'real', endpoint: rec?.endpoint ?? '<attached per playwright-cli; no hp record>' };
}

export function launchedRecord(env, port) {
  try { return JSON.parse(readFileSync(path.join(env.launched, `${port}.json`), 'utf8')); } catch { return null; }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ---- audit (SENSIBILITIES #7) ----
export function audit(env, fields) {
  const line = `[hp audit] ${env.now().toISOString()} ` + Object.entries(fields)
    .map(([k, v]) => `${k}=${/[\s"]/.test(String(v)) ? JSON.stringify(String(v)) : v}`).join(' ');
  env.err(line);
  try { ensureHome(env); appendFileSync(env.auditFile, line + '\n', { mode: 0o600 }); } catch { /* stderr still has it */ }
}

// ---- the one place playwright-cli is invoked ----
export function runCli(env, cliArgs, { session, timeout = EXEC_TIMEOUT_MS } = {}) {
  if (!existsSync(env.bin)) {
    return { status: 127, stdout: '', stderr: `${CLI}: ${env.bin} not found — run \`npm install\` in ${TOOL_DIR} (or: toolbelt setup ${TOOL})` };
  }
  const full = [];
  if (session) full.push(`-s=${session}`);
  full.push(...cliArgs);
  if (CONFIG_VERBS.has(cliArgs[0])) full.push(`--config=${CONFIG_FILE}`);
  // The session is always explicit, never inherited, and no PLAYWRIGHT_MCP_* variable (cdp
  // endpoint, user-data-dir, isolated, config, extension, ...) reaches playwright-cli: the
  // caller's environment is not a config surface. PWTEST_* (PWTEST_DAEMON_SESSION_DIR relocates
  // the session registry the gate reads) is stripped for the same reason.
  const childEnv = { ...process.env, NO_UPDATE_NOTIFIER: '1' };
  for (const k of Object.keys(childEnv)) if (/^PLAYWRIGHT_(MCP|CLI)_|^PWTEST_/.test(k)) delete childEnv[k];
  const r = env.spawn(env.bin, full, { cwd: TOOL_DIR, encoding: 'utf8', timeout, env: childEnv });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error };
}

function passThrough(env, verb, args, flags, session) {
  const cliArgs = [verb, ...args];
  for (const [k, v] of Object.entries(flags)) {
    if (v === true) cliArgs.push(`--${k}`);
    else if (v !== false && v != null) cliArgs.push(`--${k}=${v}`);
  }
  const r = runCli(env, cliArgs, { session });
  if (r.stdout) env.out(r.stdout);
  if (r.stderr) env.err(r.stderr);
  if (r.error) env.err(`${CLI}: ${r.error.message}`);
  return r.status === 0 ? 0 : 1;
}

// ---- verbs ----

function cmdStatus(env) {
  const sessions = readSessions(env);
  env.out(`hp ${VERSION} — playwright-cli at ${env.bin}${existsSync(env.bin) ? '' : ' (MISSING: npm install)'}`);
  env.out(`output dir: ${env.outputDir}`);
  env.out(`state dir:  ${env.home}`);
  const names = Object.keys(sessions);
  if (!names.length) env.out('attached sessions (hp records): none');
  for (const n of names) {
    const s = sessions[n];
    env.out(`session ${n}: mode=${s.mode} profile=${s.profileClass} endpoint=${s.endpoint ?? '-'} since=${s.since ?? '-'}`);
  }
  if (existsSync(env.bin)) {
    const r = runCli(env, ['list', '--json']);
    let browsers = null;
    try { browsers = JSON.parse(r.stdout).browsers; } catch { /* reported below */ }
    if (r.status !== 0 || !Array.isArray(browsers)) env.out('playwright-cli sessions: unknown (list failed) — page actions are refused until it answers');
    else if (!browsers.length) env.out('playwright-cli sessions: none open');
    else for (const b of browsers) env.out(`playwright-cli session ${b.name}: attached=${!!b.attached} (${b.attached ? 'page actions need --attached-writes' : 'isolated, page actions free'})`);
  }
  let launched = [];
  try { launched = readdirSync(env.launched).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of launched) {
    const rec = launchedRecord(env, f.replace(/\.json$/, ''));
    if (rec) env.out(`launched chrome: port=${rec.port} pid=${rec.pid} alive=${pidAlive(rec.pid)} profile=${rec.profileDir}`);
  }
  return 0;
}

/** launch-debug — Chrome on a debugging port, on a profile dir this tool owns. */
function findChrome() {
  const candidates = [process.env.CHROME_PATH,
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

async function cmdLaunchDebug(env, flags) {
  const port = Number(flags.port ?? DEFAULT_DEBUG_PORT);
  const profile = flags.profile ?? 'default';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { env.err(`${CLI}: --port must be 1024-65535`); return 2; }
  if (!validProfileName(profile)) { env.err(`${CLI}: --profile is a name (one path segment, [A-Za-z0-9._-]), not a path: profiles live only under ${env.profiles}. The default Chrome user-data-dir is never accepted — it is the real profile, and Chrome ignores the port there anyway.`); return 2; }
  const profileDir = path.join(env.profiles, profile);
  const chrome = findChrome();
  const endpoint = `http://127.0.0.1:${port}`;
  if (flags.explain) {
    env.out(`would launch ${chrome ?? '<chrome not found>'} --remote-debugging-port=${port} --user-data-dir=${profileDir} about:blank`);
    env.out(`then wait up to ${LAUNCH_WAIT_MS / 1000}s for ${endpoint}/json/version and print the endpoint (tier: read — isolated profile under ${env.profiles}; the loopback port is unauthenticated to local processes while open; \`${CLI} close -s <name>\` quits it)`);
    return 0;
  }
  if (!chrome) { env.err(`${CLI}: no Chrome found (CHROME_PATH, Google Chrome, Chrome for Testing, Edge). Fix: brew install --cask google-chrome`); return 1; }
  const existing = launchedRecord(env, port);
  if (existing && pidAlive(existing.pid)) { env.out(JSON.stringify({ ok: true, endpoint, port, pid: existing.pid, profileDir: existing.profileDir, reused: true })); return 0; }
  ensureHome(env);
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) { version = await res.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!version) {
    try { process.kill(child.pid); } catch { /* already gone */ }
    env.err(`${CLI}: Chrome did not answer on ${endpoint}/json/version within ${LAUNCH_WAIT_MS / 1000}s; killed pid ${child.pid}`);
    audit(env, { verb: 'launch-debug', port, profile: 'isolated', result: 'timeout' });
    return 1;
  }
  writeFileSync(path.join(env.launched, `${port}.json`), JSON.stringify({ port, pid: child.pid, profileDir, endpoint, since: env.now().toISOString() }) + '\n', { mode: 0o600 });
  audit(env, { verb: 'launch-debug', port, pid: child.pid, profile: 'isolated', result: 'ok' });
  env.out(JSON.stringify({ ok: true, endpoint, webSocketDebuggerUrl: version.webSocketDebuggerUrl, browser: version.Browser, port, pid: child.pid, profileDir, next: `${CLI} connect --cdp=${endpoint} -s <name>` }));
  return 0;
}

/** connect — attach a named session to a running browser. */
let approvedInProcess = null; // one-shot, set only by cmdApprove

function connectPlan(env, flags, session) {
  if (!session) return { error: 'connect needs -s <name>: an attached session is always named, so the contract can tell it from the isolated default' };
  if (!validSessionName(session)) return { error: `bad session name ${JSON.stringify(session)}` };
  const modes = ['cdp', 'extension', 'endpoint'].filter((k) => flags[k] !== undefined);
  if (modes.length !== 1) return { error: 'connect takes exactly one of --cdp=<chrome|msedge|url>, --extension[=chrome], --endpoint=<ws url>' };
  const mode = modes[0];
  let target, profileClass = 'real', cliFlag, launched = null, display;
  if (mode === 'cdp') {
    const c = classifyEndpoint(String(flags.cdp), { remoteOk: !!flags['remote-ok'] });
    if (!c.ok) return { error: c.why };
    target = c; display = c.display; cliFlag = `--cdp=${flags.cdp}`;
    if (c.kind === 'url' && c.loopback) {
      const rec = launchedRecord(env, c.port);
      if (rec && pidAlive(rec.pid)) { launched = rec; profileClass = 'isolated'; }
    }
  } else if (mode === 'extension') {
    display = `extension:${flags.extension === true ? 'chrome' : flags.extension}`;
    cliFlag = flags.extension === true ? '--extension' : `--extension=${flags.extension}`;
    target = { kind: 'extension' };
  } else {
    const c = classifyEndpoint(String(flags.endpoint), { remoteOk: !!flags['remote-ok'] });
    if (!c.ok) return { error: c.why };
    target = c; display = c.display; cliFlag = `--endpoint=${flags.endpoint}`;
  }
  const existing = readSessions(env)[session];
  if (existing && existing.mode === 'attached') return { error: `session ${session} is already attached to ${existing.endpoint}; \`${CLI} close -s ${session}\` first` };
  return { mode, target, profileClass, cliFlag, display, launched, session, echoWord: display };
}

function describeConnect(env, plan) {
  const lines = [];
  if (plan.profileClass === 'isolated') {
    lines.push(`attach session ${plan.session} to ${plan.display} — a Chrome ${CLI} launched (pid ${plan.launched.pid}) on its own profile ${plan.launched.profileDir}: no logged-in sessions of yours are in it (tier: read, no gate on the attach; page actions on any attached session still need --attached-writes)`);
  } else {
    lines.push(`attach session ${plan.session} to ${plan.display} — the REAL browser profile (tier: write-gated, gate: typed-echo on /dev/tty)`);
    lines.push('what it does:  every site you are signed into in that browser (mail, code hosting, banking, work SSO) becomes reachable to this tool and to any agent driving it, all at once');
    lines.push('why the gate:  there is no per-site permission; a click, fill or eval there is an authenticated action under your name. Page contents are untrusted input that can steer an agent, so no flag an agent could pass can substitute for you typing the target back');
    lines.push(`yes (type ${JSON.stringify(plan.echoWord)}): the session attaches; reads (snapshot, screenshot, console, network) run free; page actions additionally need --attached-writes on every call; \`${CLI} close -s ${plan.session}\` detaches and leaves the browser running`);
    lines.push('no (anything else, or Enter): nothing attaches; nothing changes in the browser');
    if (plan.mode === 'cdp' && plan.target.kind === 'channel') lines.push('precondition: you enabled chrome://inspect/#remote-debugging in that browser yourself — Chrome offers no way for a CLI to do it');
    if (plan.mode === 'extension') lines.push('the Playwright MCP Bridge extension also asks per tab in its popup; that consent is additional, not a replacement for this one');
  }
  for (const l of lines) env.out(l);
}

function doConnect(env, plan) {
  const r = runCli(env, ['attach', plan.cliFlag], { session: plan.session });
  const ok = r.status === 0;
  if (r.stdout) env.out(r.stdout);
  if (r.stderr) env.err(r.stderr);
  audit(env, { verb: 'connect', session: plan.session, endpoint: plan.display, profile: plan.profileClass, result: ok ? 'ok' : `exit ${r.status}` });
  if (!ok) return 1;
  const sessions = readSessions(env);
  sessions[plan.session] = { mode: 'attached', profileClass: plan.profileClass, endpoint: plan.display, launchedPort: plan.launched?.port, since: env.now().toISOString() };
  writeSessions(env, sessions);
  env.out(JSON.stringify({ ok: true, session: plan.session, endpoint: plan.display, profile: plan.profileClass, attachedWrites: 'every page action needs --attached-writes' }));
  return 0;
}

function cmdConnect(env, flags, session) {
  const plan = connectPlan(env, flags, session);
  if (plan.error) { env.err(`${CLI}: ${plan.error}`); return 2; }
  if (flags.explain) { describeConnect(env, plan); env.out('(--explain: nothing attached)'); return 0; }
  if (plan.profileClass === 'isolated') return doConnect(env, plan);
  if (flags.yes || flags.force) { env.err(`${CLI}: connect to a real profile takes no --yes/--force — the gate is the target typed at /dev/tty, or \`toolbelt approve ${TOOL} <code>\` after staging`); return 2; }
  if (approvedInProcess === `${plan.session}|${plan.display}`) { approvedInProcess = null; return doConnect(env, plan); }
  if (!env.tty.has()) {
    const rec = stageConnect(env, { flags, session, summary: `connect -s ${session} ${plan.cliFlag}` });
    env.err(`staged — confirm with: toolbelt approve ${TOOL} ${rec.code}`);
    env.err(`(nothing attached; the staged request lives in ${env.pending}/${rec.code}.json until ${rec.expires} and runs only after a human types the target at a real terminal; ${env.tty.why})`);
    env.out(JSON.stringify({ ok: false, error: 'pending_confirmation', code: rec.code, approve: `toolbelt approve ${TOOL} ${rec.code}`, expires: rec.expires, summary: rec.summary }));
    return 3;
  }
  describeConnect(env, plan);
  env.out(`Type ${JSON.stringify(plan.echoWord)} to attach, anything else to abort: `);
  const typed = env.tty.readLine();
  if (typed !== plan.echoWord) { env.err(`${CLI}: aborted (typed ${JSON.stringify(typed ?? '')}); nothing attached`); audit(env, { verb: 'connect', session, endpoint: plan.display, profile: 'real', result: 'declined' }); return 1; }
  return doConnect(env, plan);
}

/** close — detach an attached session; quit a Chrome hp launched; else close the isolated browser. */
function cmdClose(env, flags, session) {
  const name = session ?? 'default';
  const sessions = readSessions(env);
  const rec = sessions[name];
  let rc = 0;
  const cli = existsSync(env.bin) ? cliAttached(env, name) : { ok: false };
  if ((cli.ok && cli.attached) || (!cli.ok && rec?.mode === 'attached')) {
    const prof = attachedProfile(env, name, { attached: true });
    const r = runCli(env, ['detach'], { session: name });
    if (r.stdout) env.out(r.stdout);
    if (r.stderr) env.err(r.stderr);
    rc = r.status === 0 ? 0 : 1;
    audit(env, { verb: 'detach', session: name, endpoint: prof.endpoint, profile: prof.profileClass, result: rc === 0 ? 'ok' : `exit ${r.status}` });
    delete sessions[name];
    writeSessions(env, sessions);
    if (rec?.launchedPort != null) {
      const l = launchedRecord(env, rec.launchedPort);
      if (l && pidAlive(l.pid)) { try { process.kill(l.pid); } catch { /* gone */ } }
      try { unlinkSync(path.join(env.launched, `${rec.launchedPort}.json`)); } catch { /* gone */ }
      audit(env, { verb: 'close', session: name, port: rec.launchedPort, pid: l?.pid ?? '-', profile: 'isolated', result: 'quit launched chrome' });
    }
    return rc;
  }
  if (rec) { delete sessions[name]; writeSessions(env, sessions); } // stale hp record: playwright-cli says not attached
  if (flags.port) {
    // close a launched Chrome nothing is attached to; the port is validated before it becomes a path
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { env.err(`${CLI}: --port must be 1024-65535`); return 2; }
    const l = launchedRecord(env, port);
    if (!l) { env.err(`${CLI}: no Chrome launched by ${CLI} on port ${flags.port}`); return 1; }
    if (pidAlive(l.pid)) { try { process.kill(l.pid); } catch { /* gone */ } }
    try { unlinkSync(path.join(env.launched, `${port}.json`)); } catch { /* gone */ }
    audit(env, { verb: 'close', port, pid: l.pid, profile: 'isolated', result: 'quit launched chrome' });
    return 0;
  }
  return passThrough(env, 'close', [], {}, session);
}

// ---- staging for headless callers (SENSIBILITIES #2) ----
function pruneExpired(env) {
  let n = 0;
  if (!existsSync(env.pending)) return 0;
  const now = env.now().getTime();
  for (const f of readdirSync(env.pending)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(env.pending, f);
    try { const r = JSON.parse(readFileSync(p, 'utf8')); if (Date.parse(r.expires) < now) { unlinkSync(p); n++; } } catch { unlinkSync(p); n++; }
  }
  return n;
}
export function stageConnect(env, { flags, session, summary }) {
  ensureHome(env); pruneExpired(env);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6).padEnd(6, 'x');
    const record = { tool: TOOL, verb: 'connect', code, session, flags: { cdp: flags.cdp, extension: flags.extension, endpoint: flags.endpoint, 'remote-ok': flags['remote-ok'] }, summary,
      staged: env.now().toISOString(), expires: new Date(env.now().getTime() + PENDING_TTL_S * 1000).toISOString() };
    try {
      const fd = openSync(path.join(env.pending, `${code}.json`), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
      writeFileSync(fd, JSON.stringify(record, null, 2) + '\n'); closeSync(fd);
      return record;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('could not allocate a staging code');
}
export function listPending(env) {
  pruneExpired(env);
  if (!existsSync(env.pending)) return [];
  return readdirSync(env.pending).filter((f) => f.endsWith('.json')).sort().map((f) => { try { return JSON.parse(readFileSync(path.join(env.pending, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

function cmdApprove(env, args, flags) {
  if (flags.list) {
    const p = listPending(env);
    if (!p.length) { env.out(`No staged connects pending under ${env.pending}.`); return 0; }
    for (const r of p) env.out(`${r.code}  expires ${r.expires}  ${r.summary}`);
    return 0;
  }
  const code = args[0] ?? (flags.discard !== true ? flags.discard : undefined);
  if (!code) { env.err(`${CLI}: approve <code> | --list | --discard <code>`); return 2; }
  if (!/^[a-z0-9]{6}$/.test(String(code))) { env.err(`${CLI}: a code is six [a-z0-9] characters; got: ${code}`); return 2; } // never a path
  const file = path.join(env.pending, `${code}.json`);
  if (flags.discard) { try { unlinkSync(file); env.out(`discarded ${code}`); return 0; } catch { env.err(`no such pending ${code}`); return 1; } }
  pruneExpired(env);
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { env.out(JSON.stringify({ ok: false, error: 'no_such_pending', message: `No staged connect ${JSON.stringify(code)} (staged requests live ${PENDING_TTL_S / 60} minutes). Ask the agent to compose it again.` })); return 1; }
  const plan = connectPlan(env, record.flags, record.session);
  if (plan.error) { unlinkSync(file); env.err(`${CLI}: staged request no longer valid: ${plan.error}`); return 1; }
  if (!env.tty.has()) { env.err(`${CLI}: approve needs /dev/tty to take the typed target (${env.tty.why}). Record kept. Run \`toolbelt approve ${TOOL} ${code}\` in a real terminal.`); return 4; }
  env.out(`staged ${record.staged} by a headless caller: ${record.summary}`);
  describeConnect(env, plan);
  env.out(`Type ${JSON.stringify(plan.echoWord)} to attach, anything else to abort: `);
  const typed = env.tty.readLine();
  try { unlinkSync(file); } catch { /* single use either way */ }
  if (typed !== plan.echoWord) { env.err(`${CLI}: aborted; nothing attached; record ${code} deleted`); audit(env, { verb: 'approve', code, session: record.session, endpoint: plan.display, result: 'declined' }); return 3; }
  approvedInProcess = `${plan.session}|${plan.display}`;
  return cmdConnect(env, { ...record.flags }, record.session);
}

// ---- dispatch ----
function usage(env) {
  env.out(`hp ${VERSION} — token-cheap browsing over playwright-cli, isolated profile by default

usage: node hp.mjs [-s <session>] <verb> [args] [--flags]

read (free):        snapshot · screenshot [ref] [--filename f] · pdf [--filename f]
                    console [level] · network · tab-list · cookie-list · list · status
                    state-save [--filename f]
page actions:       open [url] [--headed] · goto <url> · go-back · go-forward · reload
                    click fill type press select check uncheck hover drag upload eval run-code
                    tab-new tab-close tab-select state-load route unroute cookie-* localstorage-* …
                    free on the isolated profile; on an attached session each call needs the
                    bare --attached-writes (loud, always honored); open there is refused (close first)
launch-debug        [--port 9222] [--profile <name>]  Chrome on a debugging port, profile under
                    $HP_HOME/profiles/<name> — never the default user-data-dir; prints the endpoint
connect -s <name>   --cdp=<chrome|msedge|url> | --extension[=chrome] | --endpoint=<ws url>
                    real profile: type the target back at /dev/tty (headless: staged for
                    \`toolbelt approve ${TOOL} <code>\`); an endpoint launch-debug opened: no gate
close [-s <name>]   detaches an attached session (browser keeps running); quits a Chrome hp
                    launched; otherwise closes the isolated browser.  close --port N quits one
approve <code>      what \`toolbelt approve ${TOOL}\` runs; --list, --discard <code>
… --explain         the plan, nothing run (connect, launch-debug, page actions)

files land only under ${makeEnv().outputDir} (PLAYWRIGHT_OUTPUT_DIR); hp records under $HP_HOME
                    (attached-ness itself is read from playwright-cli's registry, not from $HP_HOME)
refused on every verb: --config --persistent --profile --cdp --endpoint --extension --session
                    (connect takes --cdp/--endpoint/--extension; launch-debug takes --profile <name>);
                    PLAYWRIGHT_MCP_* env vars never reach playwright-cli
ceilings: ${EXEC_TIMEOUT_MS / 1000}s per playwright-cli call · ${LAUNCH_WAIT_MS / 1000}s launch wait · staged connects expire in ${PENDING_TTL_S / 60} min
exit: 0 ok/previewed · 1 failed/declined · 2 usage · 3 staged · 4 a gate needed a terminal`);
}

export async function main(argv, envOverrides = {}) {
  const env = makeEnv(envOverrides);
  const { args, flags, session } = parseArgs(argv);
  const verb = args.shift();
  if (flags.help || verb === '-h') { usage(env); return 0; }
  if (!verb) { usage(env); return 2; }
  if (verb === '--version' || flags.version) { env.out(VERSION); return 0; }
  if (session !== undefined && !validSessionName(session)) { env.err(`${CLI}: bad session name`); return 2; }
  if (!ALL_VERBS.includes(verb)) { env.err(`${CLI}: unknown verb ${JSON.stringify(verb)} — this wrapper exposes only the verbs in its table; see --help`); return 2; }
  const refused = findRefusedFlag(verb, flags, args);
  if (refused) { env.err(`${CLI}: ${refused.startsWith('-') ? refused : '--' + refused} is not accepted on ${verb} (option-like positionals, including after \`--\`, are refused): it would re-point this call at another profile, browser or session. The config is ${CONFIG_FILE} (isolated); a real profile is reachable only through \`${CLI} connect\`, a session only through -s`); return 2; }

  if (verb === 'status') return cmdStatus(env);
  if (verb === 'launch-debug') return cmdLaunchDebug(env, flags);
  if (verb === 'connect') return cmdConnect(env, flags, session);
  if (verb === 'close') return cmdClose(env, flags, session);
  if (verb === 'approve') return cmdApprove(env, args, flags);

  // --filename containment
  if (FILE_VERBS.has(verb)) {
    const fn = flags.filename ?? (verb === 'state-save' ? args[0] : undefined);
    if (fn !== undefined) {
      const c = containFilename(String(fn), env.outputDir);
      if (!c.ok) { env.err(`${CLI}: --filename ${JSON.stringify(fn)}: ${c.why} (${env.outputDir})`); return 2; }
      // playwright-cli resolves an explicit filename against cwd and honors absolute paths, so
      // the contained absolute path is what gets passed.
      if (verb === 'state-save') args[0] = c.resolved; else flags.filename = c.resolved;
    }
    mkdirSync(env.outputDir, { recursive: true });
  }

  // containment gate on page actions against an attached real profile. The attached-ness comes
  // from playwright-cli's own registry (the one this action will use), asked right now; if it
  // cannot be read the action is refused. hp's sessions.json never decides in the permissive
  // direction.
  if ('attached-writes' in flags && flags['attached-writes'] !== true) {
    env.err(`${CLI}: --attached-writes is a bare flag; \`--attached-writes=${flags['attached-writes']}\` is not accepted`);
    return 2;
  }
  const attachedWrites = flags['attached-writes'] === true;
  delete flags['attached-writes'];
  if (VERBS.interact.includes(verb)) {
    const name = session ?? 'default';
    const cli = cliAttached(env, name);
    if (!cli.ok) {
      env.err(`${CLI}: cannot tell whether session ${name} is attached to a real browser (${cli.why}); ${verb} refused. \`${CLI} status\` shows what playwright-cli reports.`);
      return 2;
    }
    const prof = attachedProfile(env, name, cli);
    const attachedReal = prof.attached && prof.profileClass === 'real';
    if (flags.explain) {
      delete flags.explain;
      env.out(`would run playwright-cli ${session ? `-s=${session} ` : ''}${verb} ${args.join(' ')} on session ${name} (profile: ${prof.profileClass}${attachedReal ? (verb === 'open' ? ', ATTACHED to ' + prof.endpoint + ' — open is refused there; `close` detaches' : ', ATTACHED to ' + prof.endpoint + ' — needs --attached-writes') : ''}); nothing run`);
      return 0;
    }
    if (attachedReal && verb === 'open') {
      env.err(`${CLI}: session ${name} is attached to ${prof.endpoint}; open would silently stop (detach) that session to start a fresh browser. Run \`${CLI} close -s ${name}\` to detach on the record, or open under another -s name.`);
      return 2;
    }
    if (attachedReal && !attachedWrites) {
      env.err(`${CLI}: session ${name} is attached to ${prof.endpoint} (your real profile); ${verb} there is an authenticated action under your name. Re-run with --attached-writes once a human has approved this specific action, or use snapshot/screenshot/console/network, which stay free.`);
      return 2;
    }
    if (attachedReal) audit(env, { verb, session: name, endpoint: prof.endpoint, profile: 'real', target: args[0] ?? '-', flag: '--attached-writes' });
  } else if (flags.explain) {
    delete flags.explain;
    env.out(`would run playwright-cli ${session ? `-s=${session} ` : ''}${verb} ${args.join(' ')} (tier: read); nothing run`);
    return 0;
  }
  return passThrough(env, verb, args, flags, session);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc), (e) => { process.stderr.write(`${CLI}: ${e.message}\n`); process.exit(1); });
}
