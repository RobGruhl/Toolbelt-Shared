// safeguards-honesty.mjs — a manifest that claims a human gate must point at code that
// enforces one. An over-claimed safeguard is worse than an honest "this writes, no gate":
// it stops the next reader from looking (CLAUDE.md, "The manifest must not lie").
//
// Heuristic, deliberately narrow: only POSITIVE gate claims are matched, so prose that
// *denies* a gate ("cannot be TTY-gated", "no TTY confirmation to over-claim") passes.
// Emits one JSON result line per the doctor's `custom` check contract.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from '../../../doctor/lib/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// A safeguard sentence that positively claims a human/TTY gate.
const CLAIM = /(\/dev\/tty|isatty\(\)|confirmOnTty|confirm_on_tty|TTY[- ]confirm(?:ation)? gated|gated by an? (?:un-?bypassable )?(?:TTY|\/dev\/tty)|un-?bypassable (?:\/dev\/tty|TTY|human))/i;
// Code that implements one.
const GATE = /(isatty|\/dev\/tty|confirmOnTty|confirm_on_tty)/;

const CODE_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.sh', '.ts']);
const SKIP_DIRS = new Set(['.venv', 'node_modules', '.git', 'dist', 'data', '__pycache__', 'checks']);

function* codeFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* codeFiles(path.join(dir, e.name), depth + 1);
    } else if (CODE_EXT.has(path.extname(e.name))) {
      yield path.join(dir, e.name);
    }
  }
}

function hasGateInCode(dir) {
  for (const file of codeFiles(dir)) {
    try {
      if (statSync(file).size > 2_000_000) continue;
      if (GATE.test(readFileSync(file, 'utf8'))) return true;
    } catch {
      /* unreadable file — keep scanning */
    }
  }
  return false;
}

const { manifests } = discover(ROOT);
const offenders = [];
let claims = 0;

for (const m of manifests) {
  // Coerce rather than trust the shape. validate() rejects a non-array safeguards, but
  // this check must not be the thing that DIES on a malformed manifest: a crash here
  // reports as "custom check did not emit a JSON result" and silently stops contract
  // verification for every other tool in the repo.
  const sg = m.safeguards;
  const text = (Array.isArray(sg) ? sg : Object.values(sg ?? {}))
    .filter((s) => typeof s === 'string').join('\n');
  if (!CLAIM.test(text)) continue;
  claims++;
  if (!hasGateInCode(m._dir)) offenders.push(m.name);
}

if (offenders.length) {
  console.log(JSON.stringify({
    status: 'fail',
    detail: `gate claimed in safeguards[] but no isatty()//dev/tty found in code: ${offenders.join(', ')}`,
    fix: { description: 'Either implement the gate or rewrite the safeguard to say what the code actually enforces — an over-claimed safeguard is a failing review.' },
  }));
} else {
  console.log(JSON.stringify({
    status: 'pass',
    detail: `${claims} manifest(s) claim a human gate; all have a matching gate in code`,
  }));
}
