#!/usr/bin/env node
// Doctor check: is an OpenAI key reachable the way the tool resolves it — $OPENAI_API_KEY in
// the environment, else a Keychain generic password with service OPENAI_API_KEY? Presence
// only: the value is never read here (the Keychain probe omits -w) and never printed.
import { execFileSync } from 'node:child_process';

function keychainHas(service) {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const VAR = 'OPENAI_API_KEY';
const fix = {
  description: 'Export the key in this shell, or store it once in the Keychain (the tool reads it on the first paid call)',
  command: `security add-generic-password -s ${VAR} -a "$USER" -w`,
};

let result;
if (process.env[VAR] && process.env[VAR].trim()) {
  result = { status: 'pass', detail: `$${VAR} is exported (value not read)` };
} else if (keychainHas(VAR)) {
  result = { status: 'pass', detail: `Keychain item "${VAR}" present (value not read)` };
} else {
  result = { status: 'warn', detail: `no $${VAR} and no Keychain item "${VAR}" — estimate/list/cleanup work; submit/status/retrieve will not`, fix };
}
console.log(JSON.stringify(result));
