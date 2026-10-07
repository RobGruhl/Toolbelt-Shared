#!/usr/bin/env node
// Doctor check: the optional menu-bar indicator's LaunchAgent, if installed, must point
// at THIS tree's hot-bag and HotBagIndicator — a plist rendered from an earlier checkout
// polls a script the belt does not own, so the 🔥/⚠️ icon would report a different
// copy's truth. Absent plist → skip (the indicator is opt-in).
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.hot-bag.indicator.plist');
const toolDir = process.cwd();
if (!existsSync(plist)) {
  console.log(JSON.stringify({ status: 'skip', detail: 'indicator not installed (optional) — toolbelt setup hot-bag offers it' }));
  process.exit(0);
}
const text = readFileSync(plist, 'utf8');
const wantBin = path.join(toolDir, 'indicator', 'HotBagIndicator');
const wantScript = path.join(toolDir, 'hot-bag');
if (text.includes(wantBin) && text.includes(wantScript)) {
  const built = existsSync(wantBin);
  console.log(JSON.stringify(built
    ? { status: 'pass', detail: `${plist} points at this tree` }
    : { status: 'warn', detail: `${plist} points at this tree but indicator/HotBagIndicator is not built`, fix: { description: 'build + reload the indicator', command: './indicator/install.sh' } }));
} else {
  const m = text.match(/<string>([^<]*\/hot-bag)<\/string>/);
  console.log(JSON.stringify({
    status: 'warn',
    detail: `${plist} points at ${m ? m[1] : 'another path'}, not ${wantScript} — the menu-bar icon reports a different copy`,
    fix: { description: 're-render the LaunchAgent from this tree (builds with swiftc, bootstraps launchd)', command: './indicator/install.sh' },
  }));
}
