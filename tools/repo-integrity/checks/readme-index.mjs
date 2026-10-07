// readme-index.mjs — README.md's belt table is DERIVED from the toolbelt.json manifests
// (`bin/toolbelt readme --write`); this check fails when it drifts. A hand-edited index falls
// behind the first time a tool lands without a README edit, so the table is generated and this
// check is the freshness gate. Emits one JSON result line per the doctor's `custom` check
// contract; exits 1 on drift.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from '../../../doctor/lib/manifest.mjs';
import { renderBlock, currentBlock, diffSummary } from '../../../doctor/lib/readme.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGEN = 'regenerate: bin/toolbelt readme --write';
const README = path.join(ROOT, 'README.md');

let verdict;
if (!existsSync(README)) {
  verdict = {
    status: 'fail',
    detail: `README.md is missing at the repo root — ${REGEN}`,
    fix: { description: 'Create README.md with the belt-table marker pair, then render the table into it.', command: 'bin/toolbelt readme --write' },
  };
} else {
  const readme = readFileSync(README, 'utf8');
  const { manifests } = discover(ROOT);
  try {
    const { drifted, summary } = diffSummary(currentBlock(readme), renderBlock(manifests));
    verdict = drifted
      ? {
          status: 'fail',
          detail: `${summary.split('\n')[0]} — ${REGEN}`,
          fix: { description: 'README.md is stale against the manifests.', command: 'bin/toolbelt readme --write' },
        }
      : { status: 'pass', detail: `belt table matches all ${manifests.length} manifests` };
  } catch (e) {
    // A manifest missing hits/surface (or a corrupt marker pair) is drift's louder cousin.
    verdict = {
      status: 'fail',
      detail: `${e.message} — then ${REGEN}`,
      fix: { description: 'Fix the named manifest (docs/MANIFEST.md), then regenerate.', command: 'bin/toolbelt readme --write' },
    };
  }
}

console.log(JSON.stringify(verdict));
if (verdict.status === 'fail') process.exitCode = 1;
