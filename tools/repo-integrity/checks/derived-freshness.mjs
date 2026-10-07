// derived-freshness.mjs — SYSTEMS.md, docs/RISK.md and docs/CREDENTIALS.md are rendered from the manifests and must
// match them. Same discipline as readme-index.mjs: a stale derived table is the drift this repo
// exists to prevent, and an agent that knows which system it needs reads SYSTEMS.md first.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from '../../../doctor/lib/manifest.mjs';
import { current, wrap, diff } from '../../../doctor/lib/derived.mjs';
import { SYSTEMS_MARKERS, renderSystems, RISK_MARKERS, renderRisk, CREDS_MARKERS, renderCreds } from '../../../doctor/lib/systems.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { manifests, errors } = discover(ROOT);
if (errors.length) {
  console.log(JSON.stringify({ status: 'fail', detail: `cannot render: ${errors.length} manifest error(s) — ${errors[0].error}` }));
  process.exit(0);
}
const targets = [
  { file: 'SYSTEMS.md', m: SYSTEMS_MARKERS, render: renderSystems, cmd: 'bin/toolbelt systems --write' },
  { file: 'docs/RISK.md', m: RISK_MARKERS, render: renderRisk, cmd: 'bin/toolbelt risk --write' },
  { file: 'docs/CREDENTIALS.md', m: CREDS_MARKERS, render: renderCreds, cmd: 'bin/toolbelt creds --write' },
];
const problems = [];
for (const t of targets) {
  try {
    const want = wrap(t.render(manifests), t.m);
    const have = existsSync(path.join(ROOT, t.file)) ? current(readFileSync(path.join(ROOT, t.file), 'utf8'), t.m) : null;
    const d = diff(have, want, t.file);
    if (d.drifted) problems.push(`${d.summary.split('\n')[0]} (regenerate: ${t.cmd})`);
  } catch (e) {
    problems.push(`${t.file}: ${e.message}`);
  }
}
console.log(JSON.stringify(problems.length
  ? { status: 'fail', detail: problems.join('; '), fix: { description: 'bin/toolbelt systems --write && bin/toolbelt risk --write && bin/toolbelt creds --write' } }
  : { status: 'pass', detail: 'SYSTEMS.md, docs/RISK.md and docs/CREDENTIALS.md match the manifests' }));
