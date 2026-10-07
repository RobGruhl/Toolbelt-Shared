// token-cache.mjs — doctor `custom` check for gmh's OAuth token cache.
//
// Reports, per ~/.config/toolbelt/gmail-harvest/<account>.json: file mode, whether the granted
// scope is exactly gmail.readonly, access-token expiry, and refresh-token presence — never a
// value. A loose mode or a wrong scope is a fail, because gmh refuses to use that file; no
// token at all is a warn (never authorized on this machine). The account is masked: a doctor
// run is pasted into chats. Prints exactly one JSON result line: {status, detail, fix?}.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const dir = path.join(homedir(), '.config', 'toolbelt', 'gmail-harvest');
const shown = dir.replace(homedir(), '~');
const mask = (name) => name.replace(/^([^@])[^@]*(@.*)$/, '$1***$2');
const result = (r) => console.log(JSON.stringify(r));

const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
if (!files.length) {
  result({
    status: 'warn',
    detail: `no token in ${shown} — gmh has not been authorized on this machine`,
    fix: { description: 'Run the browser consent (read-only scope)', command: `node ${path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gmh.mjs')} auth --account <you@example.com>` },
  });
  process.exit(0);
}

let worst = 'pass';
const bump = (s) => { if (s === 'fail' || (s === 'warn' && worst === 'pass')) worst = s; };
const lines = [];
let fix;
const dirMode = statSync(dir).mode & 0o777;
if (dirMode & 0o077) { bump('warn'); lines.push(`${shown} is mode ${dirMode.toString(8)} (want 700)`); fix ??= { description: 'Tighten the token dir', command: `chmod 700 ${shown}` }; }

for (const f of files) {
  const p = path.join(dir, f);
  const mode = statSync(p).mode & 0o777;
  if (mode & 0o077) {
    bump('fail');
    lines.push(`${mask(f)}: mode ${mode.toString(8)} — gmh refuses a group/world-readable token file`);
    fix ??= { description: 'Tighten the token file (it holds a refresh token)', command: `chmod 600 ${shown}/*.json` };
    continue;
  }
  let tok;
  try { tok = JSON.parse(readFileSync(p, 'utf8')); } catch { bump('fail'); lines.push(`${mask(f)}: not valid JSON — delete it and re-run gmh auth`); continue; }
  const scopes = String(tok.scope ?? '').split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== SCOPE) {
    bump('fail');
    lines.push(`${mask(f)}: scope is not exactly gmail.readonly — gmh refuses it`);
    fix ??= { description: 'Re-run the consent', command: 'gmh auth --account <you@example.com>' };
    continue;
  }
  const left = (Date.parse(tok.expiry ?? '') - Date.now()) / 60_000;
  const access = Number.isFinite(left)
    ? (left > 5 ? `access token valid ${Math.round(left)}m more` : 'access token spent — renewed by the refresh grant on the next call')
    : 'no readable expiry';
  if (!tok.refresh_token) { bump('fail'); lines.push(`${mask(f)}: mode 600, gmail.readonly, no refresh token — re-run gmh auth`); continue; }
  const consent = tok.consented_at ? `, consented ${Math.round((Date.now() - Date.parse(tok.consented_at)) / 86_400_000)}d ago (Testing-status consent screens expire the refresh token at 7d)` : '';
  lines.push(`${mask(f)}: mode 600, gmail.readonly only, ${access}${consent}`);
}

result({ status: worst, detail: lines.join('; '), ...(fix ? { fix } : {}) });
