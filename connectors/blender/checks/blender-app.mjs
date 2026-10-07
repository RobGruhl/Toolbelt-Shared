// blender-app.mjs — check if Blender application is installed on macOS/Linux.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const candidates = [
  '/Applications/Blender.app',
  path.join(homedir(), 'Applications', 'Blender.app'),
];

let found = candidates.find((c) => existsSync(c));
let version = '';

if (!found) {
  try {
    const bin = execSync('which blender', { encoding: 'utf8' }).trim();
    if (bin) found = bin;
  } catch {
    // not on PATH
  }
}

if (found) {
  try {
    version = execSync('blender --version', { encoding: 'utf8', timeout: 5000 }).split('\n')[0].trim();
  } catch {
    version = found;
  }
  console.log(JSON.stringify({ status: 'pass', detail: version || found }));
} else {
  console.log(JSON.stringify({
    status: 'fail',
    detail: 'Blender.app not found in /Applications or PATH',
    fix: { description: 'Install Blender via Homebrew Cask', command: 'brew install --cask blender' },
  }));
}
