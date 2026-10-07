#!/usr/bin/env node
// Doctor check: the system binaries hot-bag shells out to. pmset/caffeinate/ioreg/
// dseditgroup ship with macOS (fail if missing — the machine is not a Mac we know);
// smctemp is the only third-party dependency and is optional (warn: temperatures log
// as NA and the thermal state reads UNKNOWN without it); swiftc is needed only to
// build the optional menu-bar indicator (warn).
import { execFileSync } from 'node:child_process';
const has = (b) => { try { execFileSync('/usr/bin/which', [b], { stdio: 'pipe' }); return true; } catch { return false; } };
const required = ['pmset', 'caffeinate', 'ioreg', 'dseditgroup', 'netstat', 'networksetup', 'afplay', 'perl'];
const missing = required.filter((b) => !has(b));
if (missing.length) {
  console.log(JSON.stringify({ status: 'fail', detail: `missing macOS binaries: ${missing.join(', ')}` }));
  process.exit(0);
}
const warns = [];
if (!has('smctemp')) warns.push('smctemp missing — temps log as NA, thermal state UNKNOWN (brew tap narugit/tap && brew install smctemp)');
if (!has('swiftc')) warns.push('swiftc missing — the optional menu-bar indicator cannot be built (xcode-select --install)');
console.log(JSON.stringify(warns.length
  ? { status: 'warn', detail: warns.join('; '), fix: { description: 'optional dependencies', command: 'brew tap narugit/tap && brew install smctemp' } }
  : { status: 'pass', detail: 'pmset, caffeinate, ioreg, dseditgroup, smctemp, swiftc all present' }));
