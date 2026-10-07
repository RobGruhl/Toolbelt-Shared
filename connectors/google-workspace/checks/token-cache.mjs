// token-cache.mjs — doctor `custom` check for the workspace-mcp OAuth token cache.
//
// Reports presence, file mode and the recorded expiry of ~/.google_workspace_mcp/credentials/
// <account>.json — never a value. The file holds the refresh token AND the OAuth client secret,
// which is why a group/world-readable mode is a warn rather than a footnote (SENSIBILITIES #6,
// #11). The account name is masked in the report: a doctor run is pasted into chats.
//
// Prints exactly one JSON result line: {status, detail, fix?}.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const dir = process.env.WORKSPACE_MCP_CREDENTIALS_DIR
  || process.env.GOOGLE_MCP_CREDENTIALS_DIR
  || path.join(homedir(), '.google_workspace_mcp', 'credentials');

const REFRESH_BUFFER_S = 5 * 60;

function mask(name) {
  // alice@example.com.json -> a***@example.com.json
  return name.replace(/^([^@])[^@]*(@.*)$/, '$1***$2');
}

function humanAge(seconds) {
  const s = Math.abs(seconds);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

function result(r) {
  console.log(JSON.stringify(r));
}

if (!existsSync(dir)) {
  result({
    status: 'fail',
    detail: `${dir} missing — no account has completed the OAuth consent on this machine`,
    fix: { description: 'Call any mcp__google-workspace__* read in a session (list_calendars is cheapest); the browser consent opens. Tick every scope box.' },
  });
  process.exit(0);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'oauth_states.json');
if (!files.length) {
  result({
    status: 'fail',
    detail: `${dir} has no <account>.json — consent never completed`,
    fix: { description: 'Call any mcp__google-workspace__* read in a session; the browser consent opens. Tick every scope box.' },
  });
  process.exit(0);
}

const lines = [];
let worst = 'pass';
const bump = (s) => { if (s === 'fail' || (s === 'warn' && worst === 'pass')) worst = s; };
const fixes = [];

for (const f of files) {
  const p = path.join(dir, f);
  const st = statSync(p);
  const mode = (st.mode & 0o777).toString(8);
  const loose = (st.mode & 0o077) !== 0;
  let expiry;
  let hasRefresh = false;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    expiry = j.expiry ? new Date(j.expiry) : undefined;
    hasRefresh = typeof j.refresh_token === 'string' && j.refresh_token.length > 0;
  } catch {
    expiry = undefined;
  }
  let state;
  if (!expiry || Number.isNaN(expiry.getTime())) {
    state = 'no readable "expiry" field';
    bump('warn');
  } else {
    const left = (expiry.getTime() - Date.now()) / 1000;
    state = left > REFRESH_BUFFER_S
      ? `access token valid ${humanAge(left)} more`
      : hasRefresh
        ? `access token expired ${humanAge(left)} ago — renewed by the refresh grant on the next call`
        : `access token expired ${humanAge(left)} ago and no refresh_token recorded`;
    if (left <= REFRESH_BUFFER_S && !hasRefresh) bump('fail');
  }
  if (loose) {
    bump('warn');
    fixes.push(`chmod 600 "${dir.replace(process.env.HOME ?? '', '~')}"/*.json`);
  }
  lines.push(`${mask(f)}: mode ${mode}${loose ? ' (group/world readable — it holds the refresh token and the client secret)' : ''}, ${state}`);
}

result({
  status: worst,
  detail: lines.join('; '),
  ...(fixes.length ? { fix: { description: 'Tighten the vendor cache; workspace-mcp writes it 644', command: fixes[0] } } : {}),
});
