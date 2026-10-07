// dependabot-coverage.mjs — every directory in the tree that carries a lockfile or
// requirements file must be listed in .github/dependabot.yml, or named in the exclusion
// list below with its reason. A directory in neither gets security alerts but no routine
// bumps and drifts silently. Emits one JSON result line per the doctor's `custom` check
// contract; exits 1 on a gap.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const YML = path.join(ROOT, '.github', 'dependabot.yml');

// Deliberate exclusions: the directory is yours, but a version-update PR would do harm (an
// exact pin that is load-bearing, a vendored dependency bumped by hand per its contract).
// Add a line here only with a reason a reviewer can check:
//   'tools/<name>': 'why a routine bump here would break something, and where the by-hand procedure lives',
const EXCLUDED = {};

const LOCK_MARKERS = ['package-lock.json', 'poetry.lock', 'requirements.txt', 'yarn.lock', 'pnpm-lock.yaml', 'Pipfile.lock', 'uv.lock'];
const SKIP_DIRS = new Set(['node_modules', '.venv', '.git', 'dist', 'build', '__pycache__']);

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (LOCK_MARKERS.includes(name)) out.add(path.relative(ROOT, dir));
  }
  return out;
}

let verdict;
try {
  const lockDirs = [...walk(path.join(ROOT, 'tools'), new Set()), ...walk(path.join(ROOT, 'connectors'), new Set()), ...walk(path.join(ROOT, 'skills'), new Set())].sort();
  if (!existsSync(YML)) {
    if (!lockDirs.length) {
      verdict = { status: 'skip', detail: 'no lockfile directories and no .github/dependabot.yml yet — nothing to cover; add the file with the first tool that carries a lockfile' };
    } else {
      verdict = {
        status: 'fail',
        detail: `.github/dependabot.yml is missing but ${lockDirs.length} lockfile dir(s) exist: ${lockDirs.join(', ')}`,
        fix: { description: 'Create .github/dependabot.yml listing every lockfile directory (one `- /tools/<x>` line each under its ecosystem).', command: '$EDITOR .github/dependabot.yml' },
      };
    }
  } else {
    const yml = readFileSync(YML, 'utf8');
    // directories appear as "      - /tools/<x>" lines; normalise to repo-relative without the leading slash
    const listed = new Set([...yml.matchAll(/^\s*-\s+\/(\S+)\s*$/gm)].map((m) => m[1].replace(/\/$/, '')));
    const missing = lockDirs.filter((d) => !listed.has(d) && !EXCLUDED[d]);
    const stale = [...listed].filter((d) => !lockDirs.includes(d));
    const excludedButAbsent = Object.keys(EXCLUDED).filter((d) => !lockDirs.includes(d));
    if (missing.length) {
      verdict = {
        status: 'fail',
        detail: `lockfile dir(s) absent from dependabot.yml: ${missing.join(', ')} — add them, or add an exclusion with a reason in checks/dependabot-coverage.mjs`,
        fix: { description: 'List every lockfile directory in .github/dependabot.yml (or exclude it with a reason).', command: `$EDITOR .github/dependabot.yml   # add: ${missing.map((d) => '/' + d).join(' ')}` },
      };
    } else if (stale.length || excludedButAbsent.length) {
      verdict = {
        status: 'warn',
        detail: [stale.length ? `listed but no lockfile found: ${stale.join(', ')}` : '', excludedButAbsent.length ? `excluded but no lockfile found: ${excludedButAbsent.join(', ')}` : ''].filter(Boolean).join('; '),
      };
    } else {
      verdict = { status: 'pass', detail: `${lockDirs.length} lockfile dir(s): ${lockDirs.length - Object.keys(EXCLUDED).length} covered, ${Object.keys(EXCLUDED).length} excluded with reason` };
    }
  }
} catch (e) {
  verdict = { status: 'fail', detail: e.message };
}

console.log(JSON.stringify(verdict));
if (verdict.status === 'fail') process.exitCode = 1;
