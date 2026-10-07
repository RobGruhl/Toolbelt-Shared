#!/usr/bin/env node
// Doctor check: NordVPN service credentials are resolvable from one of the stores the tool
// reads — presence only, no value is read past "non-empty", nothing is printed but the store.
// Order mirrors nordvpn/utils/credentials.py: env → ~/.config/toolbelt/nordvpn.env (600) →
// Keychain (toolbelt-nordvpn / NORD_USER + NORD_PASS) → in-tree .env (deprecated).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const FILE = path.join(homedir(), '.config', 'toolbelt', 'nordvpn.env');
const LEGACY = path.resolve(process.cwd(), '.env');
const SERVICE = 'toolbelt-nordvpn';
const FIX = `printf 'NORD_USER=<user>\\nNORD_PASS=<pass>\\n' > ${FILE} && chmod 600 ${FILE}  — or: security add-generic-password -s ${SERVICE} -a NORD_USER -w <user> (and NORD_PASS). Service credentials: https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/`;

function out(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

function dotenvHasBoth(p) {
  const kv = Object.fromEntries(readFileSync(p, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  return Boolean(kv.NORD_USER && kv.NORD_PASS);
}

if (process.env.NORD_USER?.trim() && process.env.NORD_PASS?.trim()) {
  out({ status: 'pass', detail: 'NORD_USER + NORD_PASS set in the environment' });
  process.exit(0);
}
for (const [p, legacy] of [[FILE, false], [LEGACY, true]]) {
  if (!existsSync(p)) continue;
  const loose = statSync(p).mode & 0o077;
  if (loose) { out({ status: 'fail', detail: `${p} is group/world readable; the tool refuses it`, fix: { description: 'tighten it', command: `chmod 600 ${p}` } }); process.exit(0); }
  if (dotenvHasBoth(p)) {
    out(legacy
      ? { status: 'warn', detail: `${p} (deprecated in-tree fallback — move it to ${FILE})`, fix: { description: 'move it out of the tree', command: `mv ${p} ${FILE}` } }
      : { status: 'pass', detail: `${p} (mode 600)` });
    process.exit(0);
  }
}
if (process.platform === 'darwin') {
  const have = ['NORD_USER', 'NORD_PASS'].every((a) => spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', a], { stdio: 'ignore' }).status === 0);
  if (have) { out({ status: 'pass', detail: `Keychain items ${SERVICE}/NORD_USER + NORD_PASS present` }); process.exit(0); }
}
out({ status: 'warn', detail: 'no service credentials found (env, ~/.config/toolbelt/nordvpn.env, Keychain, or .env); reads work, connect needs them', fix: { description: 'store the service credentials', command: FIX } });
