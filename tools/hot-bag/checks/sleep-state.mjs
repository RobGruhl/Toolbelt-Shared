#!/usr/bin/env node
// Doctor check: the LIVE sleep-override state of this Mac against hot-bag's own
// records. This is the check that can see a wedged machine — disablesleep=1 with no
// watchdog — which is the one state this tool must never leave behind silently.
//   off                         → pass
//   on + hot-bag watchdog alive → pass (a run is live; say so)
//   on + no watchdog            → warn, with the restore command
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = process.env.HOTBAG_HOME || path.join(os.homedir(), '.local', 'state', 'hot-bag');
let ds = '0';
try {
  const out = execFileSync('pmset', ['-g'], { encoding: 'utf8' });
  const m = out.match(/SleepDisabled\s+(\d)/);
  if (m) ds = m[1];
} catch {
  console.log(JSON.stringify({ status: 'fail', detail: 'pmset -g failed' })); process.exit(0);
}
if (ds !== '1') { console.log(JSON.stringify({ status: 'pass', detail: 'SleepDisabled 0 — the Mac sleeps on lid close' })); process.exit(0); }
let alive = false;
const pidfile = path.join(home, 'watchdog.pid');
if (existsSync(pidfile)) {
  const pid = readFileSync(pidfile, 'utf8').trim();
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
    alive = /hot-bag _watch/.test(cmd);
  } catch { alive = false; }
}
const guard = existsSync(path.join(home, 'disablesleep.on'));
if (alive) {
  console.log(JSON.stringify({ status: 'pass', detail: `SleepDisabled 1 with a live hot-bag watchdog — a run is in progress (state in ${home}); hot-bag off ends it` }));
} else {
  console.log(JSON.stringify({
    status: 'warn',
    detail: `SleepDisabled 1 and no hot-bag watchdog — WEDGED${guard ? ' (hot-bag set it)' : ' (no hot-bag marker: set by something else)'}; this Mac will not sleep on lid close`,
    fix: { description: guard ? 'restore sleep and clean stale state' : 'hot-bag did not set this; restore by hand if you mean it', command: guard ? './hot-bag doctor' : 'sudo pmset -a disablesleep 0' },
  }));
}
