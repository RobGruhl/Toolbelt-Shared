// platform.mjs — OS detection, path expansion, process execution. Zero dependencies.
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const PLATFORM = process.platform; // 'darwin' | 'win32' | 'linux'

/** Expand {TOOLBELT} and a leading ~ in a path. */
export function expandPath(p, { toolbelt, home = homedir() } = {}) {
  if (typeof p !== 'string') return p;
  let out = p.replaceAll('{TOOLBELT}', toolbelt ?? '');
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = path.join(home, out.slice(2));
  return out;
}

/**
 * Run an executable (no shell). Never throws.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, error?:string}>}
 */
export function exec(cmd, args = [], { cwd, env, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env: env ? { ...process.env, ...env } : process.env, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error.code === undefined || typeof error.code === 'string' ? null : error.code) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error && { error: error.killed ? 'timeout' : String(error.message ?? error) }),
        });
      },
    );
  });
}

/** Run a command line through the user's shell. Never throws. */
export function execShell(command, { cwd, env, timeout = 30_000 } = {}) {
  const shell = PLATFORM === 'win32' ? 'cmd' : '/bin/sh';
  const flag = PLATFORM === 'win32' ? '/c' : '-c';
  return exec(shell, [flag, command], { cwd, env, timeout });
}

/** Find the first existing executable among candidates (names looked up on PATH, absolute paths checked directly). */
export async function findExecutable(candidates) {
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (existsSync(c)) return c;
      continue;
    }
    const probe = PLATFORM === 'win32' ? await exec('where', [c]) : await exec('/bin/sh', ['-c', `command -v ${c}`]);
    if (probe.code === 0 && probe.stdout.trim()) return probe.stdout.trim().split('\n')[0];
  }
  return null;
}

/** Compare dotted versions: cmpVersions('22.22.0','18') > 0. */
export function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Quote one argument for the platform shell. */
export function shellQuote(a) {
  if (PLATFORM === 'win32') return /[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
  return /[^A-Za-z0-9_./:=@,-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a;
}

/**
 * Run a shell-shaped command line with the terminal attached (stdio inherited) and resolve its
 * exit code. Never throws: a shell that cannot be spawned resolves 1 after printing why, so the
 * human sees the reason instead of a bare exit. On win32 the shell is `cmd /c`; elsewhere
 * `/bin/sh -c`. Every belt verb that hands the terminal to a tool — approve, run, setup, auth —
 * goes through here, so "the gate works on Windows" is one code path, not four.
 */
export function spawnShellInherit(command, { cwd, env } = {}) {
  const shell = PLATFORM === 'win32' ? 'cmd' : '/bin/sh';
  const flag = PLATFORM === 'win32' ? '/c' : '-c';
  return new Promise((resolve) => {
    const child = spawn(shell, [flag, command], { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (e) => { console.error(`toolbelt: could not start ${shell}: ${e.message}`); resolve(1); });
  });
}

/** Spawn a long-lived child (for MCP handshakes). Caller manages lifecycle. */
export function spawnChild(cmd, args = [], { cwd, env } = {}) {
  return spawn(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
