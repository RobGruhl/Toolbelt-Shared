// principal-honesty.mjs — the no-escalation thesis (SENSIBILITIES #13) and the verb tiers, as a
// check. A reviewer verifies "every credential is the operator's own" by running this, not by
// reading prose. Three verdicts, none silent:
//   fail — a manifest says `principal: none` while declaring secret env vars or credential caches
//          (a credential it won't own up to), or a tty/typed-echo verb with no gate in the code
//   warn — a `service` principal (named, with its written exception) or an ungated `write` verb
//          (named, with its note): admissible facts that must stay visible on every run
//   pass — otherwise
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from '../../../doctor/lib/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GATE = /(isatty|\/dev\/tty|confirmOnTty|confirm_on_tty)/;
const CODE_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.sh', '.ts']);
const SKIP_DIRS = new Set(['.venv', 'node_modules', '.git', 'dist', 'data', '__pycache__', 'checks', 'tests', 'test']);

function* codeFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* codeFiles(path.join(dir, e.name), depth + 1); }
    else if (CODE_EXT.has(path.extname(e.name))) yield path.join(dir, e.name);
  }
}
function hasGateInCode(dir) {
  for (const f of codeFiles(dir)) {
    try { if (statSync(f).size < 2_000_000 && GATE.test(readFileSync(f, 'utf8'))) return true; } catch { /* keep scanning */ }
  }
  return false;
}

const { manifests } = discover(ROOT);
const fails = [];
const warns = [];
let credentialed = 0;

for (const m of manifests) {
  const a = m.auth;
  const secretEnv = (m.env ?? []).filter((e) => e.secret).map((e) => e.name);
  const caches = (a?.caches ?? []).filter((c) => c.path);
  if (a) {
    if (a.principal !== 'none') credentialed++;
    if (a.principal === 'none' && (secretEnv.length || caches.length)) {
      fails.push(`${m.name}: principal "none" but declares ${[secretEnv.length && `secret env ${secretEnv.join('/')}`, caches.length && `${caches.length} credential cache(s)`].filter(Boolean).join(' and ')}`);
    }
    if (a.principal === 'service') warns.push(`${m.name}: service principal — ${a.principal_exception}`);
  }
  const verbs = Array.isArray(m.verbs) ? m.verbs : [];
  const ungated = verbs.filter((v) => v.tier === 'write');
  if (ungated.length) warns.push(`${m.name}: ungated write verb(s) ${ungated.map((v) => v.name).join(', ')}`);
  // A tier that names a terminal gate is a claim about code in that directory. Connectors have
  // no code, so they cannot truthfully claim one.
  const ttyClaims = verbs.filter((v) => v.tier === 'write-gated' && (v.gate === 'tty' || v.gate === 'typed-echo'));
  if (ttyClaims.length && !hasGateInCode(m._dir)) {
    fails.push(`${m.name}: verbs ${ttyClaims.map((v) => v.name).join(', ')} claim a ${[...new Set(ttyClaims.map((v) => v.gate))].join('/')} gate but no isatty()//dev/tty exists in the code`);
  }
}

if (fails.length) {
  console.log(JSON.stringify({ status: 'fail', detail: fails.join('; '), fix: { description: 'Make the manifest say what the code does: declare the principal the credential really has, or implement the gate the verb claims (docs/MANIFEST.md, SENSIBILITIES #13).' } }));
} else if (warns.length) {
  console.log(JSON.stringify({ status: 'warn', detail: `${credentialed} credentialed entries run as the operator; exceptions on record — ${warns.join('; ')}`, fix: { description: 'These are admitted facts, not bugs: a service principal needs a user-scoped alternative or stays named here; an ungated write wants a gate matched to its blast radius (SENSIBILITIES #2).' } }));
} else {
  console.log(JSON.stringify({ status: 'pass', detail: `${credentialed} credentialed entries, all on the operator's own principal; every write verb names an enforced gate` }));
}
