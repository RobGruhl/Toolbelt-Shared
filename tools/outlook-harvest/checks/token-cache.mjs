// token-cache.mjs — doctor `custom` check for omh's token cache and client id.
// Per ~/.config/toolbelt/outlook-harvest/<account>.json: mode, Graph scopes exactly {Mail.Read},
// refresh-token presence — never a value; accounts masked. One JSON line: {status, detail, fix?}.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const dir = path.join(homedir(), '.config', 'toolbelt', 'outlook-harvest');
const shown = dir.replace(homedir(), '~');
const mask = (name) => name.replace(/^([^@])[^@]*(@.*)$/, '$1***$2');
const out = (r) => { console.log(JSON.stringify(r)); process.exit(0); };
const OIDC = new Set(['openid', 'profile', 'email', 'offline_access']);
const graph = (s) => String(s ?? '').split(/\s+/).filter(Boolean).map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()).filter((x) => !OIDC.has(x));

const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'client.json') : [];
if (!files.length) {
  out({ status: 'warn', detail: `no token in ${shown} — omh has not been authorized on this machine`, fix: { description: 'Register the app once (see CLAUDE.md), then sign in with a device code', command: 'node omh.mjs auth --client-id <Application (client) ID>' } });
}
let worst = 'pass';
const lines = [];
for (const f of files) {
  const p = path.join(dir, f);
  const mode = statSync(p).mode & 0o777;
  let t = {};
  try { t = JSON.parse(readFileSync(p, 'utf8')); } catch { worst = 'fail'; lines.push(`${mask(f)} unreadable`); continue; }
  const g = graph(t.scope);
  const scopeOk = g.length === 1 && g[0] === 'mail.read';
  if (mode & 0o077 || !scopeOk) worst = 'fail';
  else if (!t.refresh_token && worst === 'pass') worst = 'warn';
  lines.push(`${mask(f.slice(0, -5))}: mode ${mode.toString(8)}, graph scopes {${g.join(', ')}}${scopeOk ? '' : ' (want exactly mail.read)'}, refresh ${t.refresh_token ? 'present' : 'MISSING'}`);
}
out({ status: worst, detail: lines.join('; ') });
