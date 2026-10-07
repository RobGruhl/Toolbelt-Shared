#!/usr/bin/env node
// Doctor check: is the belt's `transcribe` CLI reachable the way video-rename looks for it?
// Order mirrors src/video_analysis/transcribe.py: {TOOLBELT}/tools/transcription/.venv/bin/transcribe,
// then PATH. Missing is a warn (the manifest downgrades it): --transcribe degrades to visual-only.
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.TOOLBELT ? path.resolve(process.env.TOOLBELT) : path.dirname(path.dirname(toolDir));
const belt = path.join(root, 'tools', 'transcription', '.venv', 'bin', 'transcribe');

function executable(p) {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

let found = null;
if (existsSync(belt) && executable(belt)) found = belt;
else {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, 'transcribe');
    if (dir && existsSync(p) && executable(p)) { found = p; break; }
  }
}

const out = found
  ? { status: 'pass', detail: `transcribe → ${found}` }
  : {
      status: 'fail',
      detail: `transcribe not at ${belt} and not on PATH — --transcribe runs visual-only`,
      fix: { description: 'Set up the belt transcription tool', command: `${path.join(root, 'bin', 'toolbelt')} setup transcription` },
    };
process.stdout.write(JSON.stringify(out) + '\n');
