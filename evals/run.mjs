#!/usr/bin/env node
// evals/run.mjs — the net under any edit to the belt's contracts.
//
// Each case is a task a teammate would actually type, run through `claude -p` in PLAN mode from
// the repo root: the agent reads the contracts and says what it would do, and we grade the
// *intent* — did the gate fire, did it refuse to print a token, did it stop-and-tell on dead auth —
// with no side effects on any live system. Grading is regex on the final answer: crude, stable,
// and enough to catch a contract that stopped carrying its rule.
//
//   node evals/run.mjs [--model <model>] [--case <name>] [--turns 25] | --list | --help
//
// Results land in evals/results/<date>-<model>.json (gitignored): model, case, pass/fail, the
// failing patterns, and the answer — the evidence for LEDGER.md's "what was cut" lines.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const USAGE = `usage: node evals/run.mjs [--model <model>] [--case <name>] [--turns N]
       node evals/run.mjs --list      the cases and their rules; runs nothing
       node evals/run.mjs --help
A bare run calls \`claude -p\` once per case — real model calls. Results: evals/results/<date>-<model>.json`;
const FLAGS = { '--model': true, '--case': true, '--turns': true, '--list': false, '--help': false, '-h': false };
for (let i = 0; i < args.length; i++) {
  if (!(args[i] in FLAGS)) { console.error(`evals: unknown argument "${args[i]}"\n${USAGE}`); process.exit(2); }
  if (FLAGS[args[i]]) { if (args[i + 1] === undefined) { console.error(`evals: ${args[i]} needs a value\n${USAGE}`); process.exit(2); } i++; }
}
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const MODEL = opt('model', process.env.TOOLBELT_EVAL_MODEL ?? 'claude-opus-5'); // the model your belt targets; set TOOLBELT_EVAL_MODEL or pass --model
const ONLY = opt('case', null);
const TURNS = parseInt(opt('turns', '25'), 10); // plan mode reads contracts before answering; a low cap ends the run with no answer at all

const cases = readdirSync(path.join(HERE, 'cases')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(HERE, 'cases', f), 'utf8'))).filter((c) => !ONLY || c.name === ONLY);
if (!cases.length) { console.error('no cases'); process.exit(2); }
if (args.includes('--list')) {
  for (const c of cases) console.log(`${c.name.padEnd(32)} ${c.rule}`);
  process.exit(0);
}

const results = [];
for (const c of cases) {
  process.stdout.write(`${c.name.padEnd(32)} `);
  const r = spawnSync('claude', ['-p', c.prompt, '--permission-mode', 'plan', '--output-format', 'json', '--model', MODEL, '--max-turns', String(TURNS)], { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? 'medium' } });
  let answer = '';
  let capped = false;
  try { const j = JSON.parse(r.stdout); answer = j.result ?? ''; capped = j.is_error && !answer && j.stop_reason === 'tool_use'; } catch { answer = r.stdout || r.stderr || ''; }
  if (capped) { console.log(`○  hit --max-turns ${TURNS} before answering — inconclusive, not a fail; raise --turns`); results.push({ case: c.name, rule: c.rule, pass: false, inconclusive: true, failed: ['max-turns'], exit: r.status, answer: '' }); continue; }
  const failed = [];
  for (const p of c.must ?? []) if (!new RegExp(p, 'im').test(answer)) failed.push(`must: ${p}`);
  for (const p of c.must_not ?? []) if (new RegExp(p, 'im').test(answer)) failed.push(`must_not: ${p}`);
  const pass = failed.length === 0 && r.status === 0;
  console.log(pass ? '✓' : `✗  ${failed.join(' · ') || `exit ${r.status}`}`);
  results.push({ case: c.name, rule: c.rule, pass, failed, exit: r.status, answer });
}
const date = new Date().toISOString().slice(0, 10);
mkdirSync(path.join(HERE, 'results'), { recursive: true });
const out = path.join(HERE, 'results', `${date}-${MODEL}.json`);
writeFileSync(out, JSON.stringify({ date, model: MODEL, turns: TURNS, pass: results.filter((x) => x.pass).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((x) => x.pass).length}/${results.length} pass · ${MODEL} · ${out}`);
process.exit(results.every((x) => x.pass) ? 0 : 1);
