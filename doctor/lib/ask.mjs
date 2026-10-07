// ask.mjs — `toolbelt ask <sketch>`: draft-before-you-ask, applied to credentials.
//
// Every sketch under sketches/<name>/README.md carries the access path (who to ask, through
// which channel or ticket queue) and the open questions a human must settle. This renders that
// into one request the operator can read, saves it to a 600-mode temp file, and stops. Filing
// or posting it goes through whichever gated writer your belt has for that system (a
// preview-then---yes send, a typed-echo ticket); the belt adds no gate of its own here and
// claims none.
//
// Section titles the sketch template must use (matched case-insensitively as `## <title>`):
//   What it is · Who needs it · The surface · Access path · Open questions
// The optional sketches/README.md index row is `| rank | [name](name/) | demand | verdict | one-liner |`.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function section(text, title) {
  const re = new RegExp(`^## [^\\n]*${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'mi');
  const m = re.exec(text);
  return m ? m[1].trim() : '';
}

function verdictRow(indexText, name) {
  const line = indexText.split('\n').find((l) => l.includes(`[${name}](${name}/)`));
  if (!line) return null;
  const cells = line.split('|').map((c) => c.trim());
  return { rank: cells[1], demand: cells[3], verdict: cells[4], summary: cells[5] };
}

/** Pull "#channel" mentions out of the access-path prose, so the draft can say where it goes. */
function addresses(accessPath) {
  return { channels: [...new Set(accessPath.match(/#[a-z0-9_-]{3,}/gi) ?? [])] };
}

export function renderAsk(toolbelt, name, operator = os.userInfo().username) {
  const file = path.join(toolbelt, 'sketches', name, 'README.md');
  if (!existsSync(file)) throw new Error(`no sketch at sketches/${name}/README.md — \`ls sketches/\` lists them`);
  const text = readFileSync(file, 'utf8');
  const indexFile = path.join(toolbelt, 'sketches', 'README.md');
  const index = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '';
  const what = section(text, 'What it is').split('\n\n')[0];
  const who = section(text, 'Who needs it').split('\n\n')[0];
  const surface = section(text, 'The surface');
  const access = section(text, 'Access path');
  const questions = section(text, 'Open questions');
  const row = verdictRow(index, name);
  const addr = addresses(access);
  const title = `Read-only agent access to ${name} for ${operator} (Toolbelt)`;
  const body = `${title}
${'='.repeat(title.length)}

WHAT I AM ASKING FOR
A read-only, user-bound credential (or confirmation that my existing SSO session may be used) so
that tooling running under my own identity can READ ${name}. No write path is being built; no
service account is wanted. Every credential in this toolkit is the requester's own and dies with
their account (Toolbelt SENSIBILITIES #13 — no escalation).

WHY
${row ? `Witnessed demand: ${row.demand}; verdict ${row.verdict} — ${row.summary}` : who}

${what}

THE SURFACE I WOULD USE (as documented)
${surface.split('\n').slice(0, 12).join('\n')}

WHAT BOUNDS IT
Read-only by construction; ceilings on page counts and bytes in code; every call emits a
metadata-only audit line (never a token); the credential lives in the OS keychain or a 600-mode
file outside any repository; revocation is yours at any time.

QUESTIONS I NEED SETTLED BEFORE ANYTHING IS BUILT
${questions || '(none recorded)'}

WHO THE DOSSIER SAYS TO ASK
${access || '(the sketch names no access path yet)'}

Drafted from sketches/${name}/README.md in this Toolbelt.
`;
  return { title, body, addr, row };
}

export async function cmdAsk(toolbelt, name) {
  if (!name) {
    console.error('usage: toolbelt ask <sketch>');
    return 2;
  }
  let draft;
  try {
    draft = renderAsk(toolbelt, name);
  } catch (e) {
    console.error(`toolbelt ask: ${e.message}`);
    return 2;
  }
  const tmpDir = path.join(os.tmpdir(), 'toolbelt-ask');
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(tmpDir, `${name}.txt`);
  writeFileSync(tmp, draft.body, { mode: 0o600 });
  console.log(draft.body);
  console.log(`\n(draft saved to ${tmp} — file or post it through the gated writer your belt has for that system${draft.addr.channels.length ? `; the sketch names ${draft.addr.channels.join(', ')}` : ''})`);
  return 0;
}
