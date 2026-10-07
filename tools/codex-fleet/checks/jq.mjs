// jq.mjs — the rollup (summary.json, pass/fail verdicts) is computed with jq.
import { execFileSync } from 'node:child_process';
try {
  const v = execFileSync('jq', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  console.log(JSON.stringify({ status: 'pass', detail: v }));
} catch {
  console.log(JSON.stringify({ status: 'fail', detail: 'jq not on PATH — a fleet runs but produces no summary.json', fix: { description: 'Install jq', command: 'brew install jq' } }));
}
