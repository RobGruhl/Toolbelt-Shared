// hook-installed.mjs — is the Claude Code Stop hook this tool ships actually installed?
// Passes only when ~/.claude/settings.json names ~/.claude/hooks/agent-voice-hook.sh AND that
// file is byte-identical to scripts/agent-voice-hook.sh here (a stale copy silently keeps
// old behaviour). Emits one JSON result per the doctor's `custom` contract.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const settingsPath = path.join(home, '.claude', 'settings.json');
const hookDest = path.join(home, '.claude', 'hooks', 'agent-voice-hook.sh');
const hookSrc = path.join(toolDir, 'scripts', 'agent-voice-hook.sh');
const fix = {
  description: 'Install the Stop hook (previews first; --yes writes ~/.claude/hooks + settings.json)',
  command: `cd ${toolDir} && poetry run agent-voice setup --yes   (or: toolbelt setup elevenlabs)`,
};

function out(o) { console.log(JSON.stringify(o)); }

let settings = {};
try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* absent = not installed */ }
const stop = settings?.hooks?.Stop ?? [];
const named = stop.some((e) => (e.hooks ?? []).some((h) => String(h.command ?? '').includes('agent-voice-hook.sh')));

if (!named) {
  out({ status: 'warn', detail: `no agent-voice Stop hook in ${settingsPath} (voice narration is off; optional)`, fix });
} else if (!existsSync(hookDest)) {
  out({ status: 'fail', detail: `settings.json names ${hookDest} but the file is missing — every Stop fires a dead command`, fix });
} else if (readFileSync(hookDest, 'utf8') !== readFileSync(hookSrc, 'utf8')) {
  out({ status: 'warn', detail: `${hookDest} differs from scripts/agent-voice-hook.sh (stale copy)`, fix });
} else {
  out({ status: 'pass', detail: `Stop hook installed at ${hookDest}, identical to the source` });
}
