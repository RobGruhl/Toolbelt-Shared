/**
 * Playwright CLI wrapper — the library face of hp.mjs.
 *
 * Every function spawns one hp verb as a child process (`node hp.mjs …`, argv array, stdin
 * inherited so the /dev/tty gate behaves exactly as on the command line). The same containment
 * rules therefore apply: the isolated profile by default, files only under the output dir, page
 * actions on an attached real profile refused without `attachedWrites: true`, re-pointing flags
 * (--config/--persistent/--profile/--session) refused, and the audit line on every attach/detach.
 * There is no path from here to playwright-cli that skips those checks. `main` is re-exported
 * for callers that want the in-process form; it runs the identical code.
 *
 * Design rules:
 *   - No console.log (callers decide logging)
 *   - Throws on non-zero exit (callers decide error handling)
 *   - Returns stdout string (callers parse as needed)
 *   - Session name flows through all calls for isolation
 */

import { main } from '../hp.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hp.mjs');

/**
 * Run one hp verb and return stdout.
 * @param {string} cmd - The verb (e.g. "open", "click", "snapshot")
 * @param {string[]} [args=[]] - Positional arguments
 * @param {object} [opts={}]
 * @param {string} [opts.session] - Named session (-s=name)
 * @param {Record<string,string|boolean>} [opts.flags] - CLI flags (--key=value)
 * @param {boolean} [opts.attachedWrites] - acknowledge a page action on an attached real profile
 * @returns {string} stdout
 */
export function exec(cmd, args = [], opts = {}) {
  const argv = [];
  const session = opts.session || process.env.PLAYWRIGHT_CLI_SESSION;
  if (session) argv.push(`-s=${session}`);
  argv.push(cmd, ...args);
  for (const [k, v] of Object.entries(opts.flags ?? {})) {
    if (v === true) argv.push(`--${k}`);
    else if (v !== false && v != null) argv.push(`--${k}=${v}`);
  }
  if (opts.attachedWrites) argv.push('--attached-writes');
  // A separate process so hp's /dev/tty gate and exit codes behave exactly as on the CLI.
  const r = spawnSync(process.execPath, [HP, ...argv], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const err = new Error(`hp ${cmd} exited ${r.status}: ${(r.stderr || '').trim()}`);
    err.status = r.status; err.stdout = r.stdout; err.stderr = r.stderr;
    throw err;
  }
  return (r.stdout ?? '').trim();
}
export { main };

// -- Core commands --

export function open(url, opts = {}) {
  const flags = { ...opts.flags };
  if (opts.headed) flags.headed = true;
  if (opts.browser) flags.browser = opts.browser;
  return exec('open', url ? [url] : [], { ...opts, flags });
}
export function goto(url, opts = {}) { return exec('goto', [url], opts); }
export function snapshot(opts = {}) {
  const flags = { ...opts.flags };
  if (opts.filename) flags.filename = opts.filename;
  return exec('snapshot', [], { ...opts, flags });
}
export function screenshot(ref, opts = {}) {
  const flags = { ...opts.flags };
  if (opts.filename) flags.filename = opts.filename;
  return exec('screenshot', ref ? [ref] : [], { ...opts, flags });
}
export function click(ref, opts = {}) { return exec('click', [ref], opts); }
export function fill(ref, value, opts = {}) { return exec('fill', [ref, value], opts); }
export function type(text, opts = {}) { return exec('type', [text], opts); }
export function press(key, opts = {}) { return exec('press', [key], opts); }
export function select(ref, value, opts = {}) { return exec('select', [ref, value], opts); }
export function check(ref, opts = {}) { return exec('check', [ref], opts); }
export function uncheck(ref, opts = {}) { return exec('uncheck', [ref], opts); }
export function hover(ref, opts = {}) { return exec('hover', [ref], opts); }
export function evaluate(expression, ref, opts = {}) { return exec('eval', ref ? [expression, ref] : [expression], opts); }

// -- Navigation --
export function goBack(opts = {}) { return exec('go-back', [], opts); }
export function goForward(opts = {}) { return exec('go-forward', [], opts); }
export function reload(opts = {}) { return exec('reload', [], opts); }

// -- Tabs --
export function tabList(opts = {}) { return exec('tab-list', [], opts); }
export function tabNew(url, opts = {}) { return exec('tab-new', url ? [url] : [], opts); }
export function tabClose(index, opts = {}) { return exec('tab-close', index != null ? [String(index)] : [], opts); }
export function tabSelect(index, opts = {}) { return exec('tab-select', [String(index)], opts); }

// -- Save as --
export function pdf(opts = {}) {
  const flags = { ...opts.flags };
  if (opts.filename) flags.filename = opts.filename;
  return exec('pdf', [], { ...opts, flags });
}

// -- Network --
export function route(pattern, routeOpts = {}, opts = {}) {
  const flags = { ...opts.flags };
  if (routeOpts.body) flags.body = routeOpts.body;
  if (routeOpts.status) flags.status = String(routeOpts.status);
  if (routeOpts.contentType) flags['content-type'] = routeOpts.contentType;
  return exec('route', [pattern], { ...opts, flags });
}
export function routeList(opts = {}) { return exec('route-list', [], opts); }
export function unroute(pattern, opts = {}) { return exec('unroute', pattern ? [pattern] : [], opts); }

// -- Storage (files land under the output dir) --
export function stateSave(filename, opts = {}) { return exec('state-save', filename ? [filename] : [], opts); }
export function stateLoad(filename, opts = {}) { return exec('state-load', [filename], opts); }

// -- Sessions and CDP --
export function list(opts = {}) { return exec('list', [], opts); }
export function status(opts = {}) { return exec('status', [], opts); }
export function close(opts = {}) { return exec('close', [], opts); }
/** Chrome on a debugging port, on a tool-owned profile; returns the JSON line hp prints. */
export function launchDebug(opts = {}) {
  const flags = { ...opts.flags };
  if (opts.port) flags.port = String(opts.port);
  if (opts.profile) flags.profile = opts.profile;
  return JSON.parse(exec('launch-debug', [], { ...opts, flags }));
}
/**
 * Attach a named session. To an endpoint launchDebug() opened: runs at once. To a real
 * profile (`cdp: 'chrome'`, a foreign endpoint, the extension): the /dev/tty typed-echo gate
 * fires, or the request is staged for `toolbelt approve playwright <code>` (exit 3 → throws).
 */
export function connect(opts = {}) {
  const flags = { ...opts.flags };
  if (opts.cdp) flags.cdp = opts.cdp;
  if (opts.extension) flags.extension = opts.extension === true ? true : opts.extension;
  if (opts.endpoint) flags.endpoint = opts.endpoint;
  if (opts.remoteOk) flags['remote-ok'] = true;
  return exec('connect', [], { ...opts, flags });
}

// -- Console & Network logs --
export function consoleLogs(minLevel, opts = {}) { return exec('console', minLevel ? [minLevel] : [], opts); }
export function networkLogs(opts = {}) { return exec('network', [], opts); }

// -- Convenience --
export function openAndSnapshot(url, opts = {}) { open(url, opts); return snapshot(opts); }
export function openAndScreenshot(url, opts = {}) { open(url, opts); return screenshot(undefined, opts); }
