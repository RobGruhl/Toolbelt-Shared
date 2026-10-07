#!/usr/bin/env node
// Doctor check: the CUPS command line this tool shells out to. lp/lpstat/lpoptions/cancel/
// cupsenable/ipptool/ippfind all ship with macOS (fail if missing); at least one queue must be
// configured (warn: every verb but --help fails until System Settings adds a printer).
import { execFileSync } from 'node:child_process';
const has = (b) => { try { execFileSync('/usr/bin/which', [b], { stdio: 'pipe' }); return true; } catch { return false; } };
const required = ['lp', 'lpstat', 'lpoptions', 'cancel', 'cupsenable', 'ipptool', 'ippfind'];
const missing = required.filter((b) => !has(b));
if (missing.length) {
  console.log(JSON.stringify({ status: 'fail', detail: `missing CUPS binaries: ${missing.join(', ')} — this is not a macOS with CUPS` }));
  process.exit(0);
}
let queues = [];
try {
  queues = execFileSync('lpstat', ['-p'], { stdio: 'pipe', timeout: 10_000 }).toString().split('\n').filter((l) => l.startsWith('printer ')).map((l) => l.split(' ')[1]);
} catch { /* lpstat exits 1 with no printers */ }
console.log(JSON.stringify(queues.length
  ? { status: 'pass', detail: `CUPS tools present; queues: ${queues.join(', ')}` }
  : { status: 'warn', detail: 'CUPS tools present but no printer queue is configured', fix: { description: 'add a printer', command: 'open "x-apple.systempreferences:com.apple.Print-Scan-Settings.extension"' } }));
