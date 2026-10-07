// Doctor check: is an OpenAI key present in any of the three places the tool reads it
// from — $OPENAI_API_KEY, the macOS Keychain item OPENAI_API_KEY, or a 600-mode
// ~/.config/toolbelt/transcription.key. Presence only; the value is never read into this
// process (no `security -w`) and never printed. Absence is a warn: the default backend is
// local and needs no key.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const out = (status, detail, fix) => console.log(JSON.stringify(fix ? { status, detail, fix } : { status, detail }));

const env = process.env.OPENAI_API_KEY;
if (env !== undefined && env.trim() !== '') {
  out('pass', 'OPENAI_API_KEY is set in the environment');
} else {
  const kc = spawnSync('security', ['find-generic-password', '-s', 'OPENAI_API_KEY'], { encoding: 'utf8' });
  if (kc.status === 0) {
    out('pass', 'Keychain item OPENAI_API_KEY present');
  } else {
    const kf = path.join(homedir(), '.config', 'toolbelt', 'transcription.key');
    if (existsSync(kf)) {
      if (statSync(kf).mode & 0o077) out('fail', `${kf} is group/world readable — the tool refuses it`, { description: 'chmod 600 the key file', command: `chmod 600 ${kf}` });
      else if (readFileSync(kf, 'utf8').trim() === '') out('fail', `${kf} exists but is empty`);
      else out('pass', `${kf} present (mode 600)`);
    } else {
      out('warn', 'no OpenAI key (env, Keychain, or key file) — local whisper.cpp works without one; --backend openai will refuse', {
        description: 'Optional: store the key in the Keychain',
        command: 'security add-generic-password -s OPENAI_API_KEY -a "$USER" -w   # prompts for the secret',
      });
    }
  }
}
