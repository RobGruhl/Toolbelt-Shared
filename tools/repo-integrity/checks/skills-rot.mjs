// skills-rot.mjs — a skill is prose nothing executes, so it rots silently. This is the static
// check that keeps it honest: every repo path a SKILL.md names must exist, every `toolbelt <verb>`
// it names must be a verb the CLI has, and every skill directory must carry a manifest (a skill
// with no manifest is invisible to `toolbelt list`, the doctor, and the README).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'doctor', 'cli.mjs');
// The CLI's verbs are its `case '<verb>':` arms. With no CLI to read, verb checks are skipped
// and only paths and manifests are tested.
const VERBS = new Set(existsSync(CLI) ? [...readFileSync(CLI, 'utf8').matchAll(/case '([a-z]+)':/g)].map((m) => m[1]) : []);
// Verbs every belt is expected to have; not re-flagged even when the CLI is absent.
const KNOWN = new Set(['doctor', 'list', 'setup', 'register', 'readme', 'inspire', 'auth', 'approve', 'systems', 'risk', 'run']);
// Verbs that name the retired sync model; a skill that still says them is routing into a wall.
const RETIRED = /^(sync|publish|pull|push|update|upgrade)$/;

const skillsDir = path.join(ROOT, 'skills');
if (!existsSync(skillsDir)) {
  console.log(JSON.stringify({ status: 'skip', detail: 'no skills/ directory — nothing to check' }));
  process.exit(0);
}

const problems = [];
let files = 0;
for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(skillsDir, d.name);
  if (!existsSync(path.join(dir, 'toolbelt.json'))) problems.push(`skills/${d.name}: no toolbelt.json — invisible to list/doctor/README`);
  const mdFiles = readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const f of mdFiles) {
    files++;
    const text = readFileSync(path.join(dir, f), 'utf8');
    // Repo-relative paths, bare or as a relative link ("../../tools/x/CLAUDE.md" resolves from
    // the repo root once the leading ./ and ../ are stripped). Angle-bracket placeholders
    // (<tool>) and glob stars are templates, not paths.
    for (const m of text.matchAll(/(?<![\w])((?:\.\.?\/)*(?:tools|connectors|skills|docs|bin|doctor|sketches|evals)\/[A-Za-z0-9_./-]+)/g)) {
      const p = m[1].replace(/^(\.\.?\/)+/, '').replace(/[).,:;`'"]+$/, '');
      if (/[<>*{}$]/.test(p)) continue;
      if (!existsSync(path.join(ROOT, p))) problems.push(`skills/${d.name}/${f}: names ${p}, which does not exist`);
    }
    // `toolbelt <verb>` must be a case the CLI has. A leading / or word character means it is a
    // slash-command or a path (/toolbelt exr), not the CLI.
    for (const m of text.matchAll(/(?<![\w/])toolbelt"?[ \t]+([a-z]+)\b/g)) {
      const verb = m[1];
      if (VERBS.size ? VERBS.has(verb) : KNOWN.has(verb)) continue;
      if (VERBS.size || RETIRED.test(verb)) problems.push(`skills/${d.name}/${f}: names \`toolbelt ${verb}\`, which is not a verb the CLI has`);
    }
  }
}

const unique = [...new Set(problems)];
console.log(JSON.stringify(unique.length
  ? { status: 'fail', detail: unique.slice(0, 8).join('; ') + (unique.length > 8 ? ` … +${unique.length - 8}` : ''), fix: { description: 'Fix the reference or the skill; a skill that names a path that is gone is routing agents into a wall.' } }
  : { status: 'pass', detail: `${files} skill document(s) name only paths and verbs that exist; every skill has a manifest` }));
