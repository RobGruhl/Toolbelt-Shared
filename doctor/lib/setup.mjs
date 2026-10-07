// setup.mjs — TTY-gated guided install. SENSIBILITIES #2: every mutation passes a TTY
// confirmation an agent cannot bypass; --yes pre-confirms steps but still requires a TTY.
import { createInterface } from 'node:readline/promises';
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { makeContext, runManifest } from './runner.mjs';
import { spawnShellInherit } from './platform.mjs';
import { renderHuman } from './report.mjs';

function isTTY() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * A y/N you cannot evaluate is a ritual, not a gate. Every step is introduced with what it
 * does, why it exists, and what each answer means — from the manifest's `why` / `yes` / `no`
 * when the author wrote them, otherwise from a generic but truthful default. The default is
 * "no": declining never breaks anything that was working; it leaves the doctor reporting the gap.
 */
export function explainStep(s, ctx, i, n) {
  const dir = path.relative(process.cwd(), ctx.toolDir) || '.';
  const what = describeStep(s, ctx);
  const generic = {
    yes: s.run ? `runs \`${s.run}\` in ${dir}; nothing outside that directory changes` : `applies the change above and nothing else`,
    no: `skipped; nothing changes, and \`toolbelt doctor ${ctx.manifest.name}\` keeps reporting what is missing`,
  };
  const lines = [
    `Step ${i} of ${n} — ${s.description ?? what}`,
    `  what:  ${what}`,
  ];
  if (s.why) lines.push(`  why:   ${s.why}`);
  lines.push(`  yes →  ${s.yes ?? generic.yes}`);
  lines.push(`  no  →  ${s.no ?? generic.no}`);
  return lines.join('\n');
}

/** Run a shell step with live output. */
function runStep(command, cwd) {
  return spawnShellInherit(command, { cwd });
}

function describeStep(s, ctx) {
  if (s.run) return `run: ${s.run}`;
  if (s.action === 'symlink') return `symlink: ${s.from} -> ${ctx.expand(s.to)}`;
  if (s.action === 'ensure_dir') return `mkdir -p ${s.path}`;
  if (s.action === 'git_config') return `git config ${s.key} ${s.value}   (this clone only)`;
  if (s.action === 'pipx_ensure') return `pipx install ${s.package}   (skipped if already installed)`;
  if (s.action === 'permissions_offer') return 'offer the read-tier permission profile for ~/.claude/settings.json (shown first; merged only on yes)';
  return JSON.stringify(s);
}

async function applyAction(s, ctx) {
  if (s.action === 'git_config') {
    const code = await runStep(`git config ${s.key} ${JSON.stringify(s.value)}`, ctx.toolbelt);
    if (code === 0) console.log(`  git config ${s.key} = ${s.value}`);
    return code;
  }
  if (s.action === 'pipx_ensure') {
    // brew / pipx / poetry / npm-local, never pip (SENSIBILITIES #10). Presence first, so re-running setup is free.
    const { execShell } = await import('./platform.mjs');
    const have = await execShell(`command -v ${s.binary ?? s.package}`);
    if (have.code === 0) { console.log(`  ${s.binary ?? s.package} already on PATH (${have.stdout.trim()})`); return 0; }
    const pipx = await execShell('command -v pipx');
    if (pipx.code !== 0) { console.error('  pipx is not installed. Fix: brew install pipx && pipx ensurepath'); return 1; }
    return runStep(`pipx install ${s.package}`, ctx.toolbelt);
  }
  if (s.action === 'permissions_offer') {
    const { discover } = await import('./manifest.mjs');
    const { profileFor, applyProfile, settingsPath } = await import('./permissions.mjs');
    const { manifests } = discover(ctx.toolbelt);
    const profile = profileFor(manifests, ctx.toolbelt);
    console.log(`\n  What a permission profile is: Claude Code asks you before each tool call unless a rule in your`);
    console.log(`  settings says otherwise. An "allow" rule means it stops asking for that call; a "deny" rule means the`);
    console.log(`  call is refused even if you would have said yes. This profile is computed from the manifests —`);
    console.log(`  allow = the belt's own read verbs and every MCP tool whose tier is read; deny = every MCP tool whose`);
    console.log(`  tier is never. No write tool is ever allowed by it. Nothing is hand-picked:`);
    for (const w of profile.why) console.log(`    • ${w}`);
    console.log(`\n  allow (${profile.allow.length}) — these stop prompting:`);
    for (const r of profile.allow) console.log(`    ${r}`);
    if (profile.deny.length) { console.log(`  deny (${profile.deny.length}) — these are refused outright:`); for (const r of profile.deny) console.log(`    ${r}`); }
    console.log(`\n  yes →  the rules above are ADDED to ${settingsPath()} (your own file; nothing is removed or`);
    console.log(`         rewritten; a timestamped backup is written first). Fewer prompts on reads; writes still ask.`);
    console.log(`         Undo: restore the backup, or delete the rules by hand.`);
    console.log(`  no  →  nothing changes. Claude Code keeps asking before every call — a fine posture too.`);
    if (!(await confirm('  Apply the profile?'))) { console.log('  left as is'); return 0; }
    const { file, added, backup } = applyProfile(profile);
    console.log(added.allow.length || added.deny.length
      ? `  ${added.allow.length} allow + ${added.deny.length} deny rule(s) added to ${file}${backup ? ` (backup: ${backup})` : ''}. Restart Claude Code to pick them up.`
      : `  ${file} already carried every rule — nothing written.`);
    return 0;
  }
  if (s.action === 'ensure_dir') {
    const p = ctx.expand(s.path);
    mkdirSync(p, { recursive: true });
    console.log(`  created ${p}`);
    return 0;
  }
  if (s.action === 'symlink') {
    const from = ctx.expand(s.from);
    const to = ctx.expand(s.to);
    if (existsSync(from) || isSymlink(from)) {
      if (isSymlink(from)) {
        const { readlinkSync, unlinkSync } = await import('node:fs');
        if (readlinkSync(from) === to) {
          console.log(`  ${from} already points at ${to}`);
          return 0;
        }
        unlinkSync(from); // stale symlink — replace
      } else {
        // real file/dir in the way: additive-first — rename, never delete
        const backup = `${from}.pre-toolbelt`;
        if (existsSync(backup)) {
          console.error(`  ${from} exists and backup ${backup} already exists — resolve manually`);
          return 1;
        }
        renameSync(from, backup);
        console.log(`  moved existing ${from} -> ${backup} (delete after a week of clean use)`);
      }
    }
    mkdirSync(path.dirname(from), { recursive: true });
    symlinkSync(to, from);
    console.log(`  ${from} -> ${to}`);
    return 0;
  }
  console.error(`  unknown action: ${s.action}`);
  return 1;
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function cmdSetup(toolbeltRoot, manifest, values) {
  const ctx = makeContext(toolbeltRoot, manifest);
  const steps = manifest.install ?? [];
  if (!steps.length) {
    console.log(`${manifest.name}: nothing to install.`);
    return 0;
  }

  if (!isTTY()) {
    console.error('toolbelt setup mutates your machine and requires an interactive terminal (SENSIBILITIES.md #2).');
    console.error('Run it yourself in a terminal:');
    for (const s of steps) console.error(`  - ${describeStep(s, ctx)}`);
    return 1;
  }

  console.log(`Setting up ${manifest.name} — ${manifest.description}\n`);
  console.log(`${steps.length} step(s). Each is explained, then asked; the default answer is no, and no never breaks`);
  console.log(`anything that already works. Nothing runs until you answer.\n`);
  for (const [i, s] of steps.entries()) console.log(`  ${i + 1}. ${s.description ?? describeStep(s, ctx)}`);
  console.log('');

  if (values.yes) {
    for (const [i, s] of steps.entries()) console.log(`${explainStep(s, ctx, i + 1, steps.length)}\n`);
    if (!(await confirm(`Run all ${steps.length} step(s) as described?`))) return 1;
  }

  for (const [i, s] of steps.entries()) {
    if (!values.yes) {
      console.log(`\n${explainStep(s, ctx, i + 1, steps.length)}`);
      if (!(await confirm(`  Run step ${i + 1}?`))) {
        console.log('  skipped');
        continue;
      }
    }
    const code = s.run ? await runStep(s.run, manifest._dir) : await applyAction(s, ctx);
    if (code !== 0) {
      console.error(`\nStep failed (exit ${code}). Stopping.`);
      return 1;
    }
  }

  console.log('\nRe-checking…');
  const result = await runManifest(toolbeltRoot, manifest);
  console.log(renderHuman({ toolbelt: toolbeltRoot, results: [result], errors: [] }));
  return result.status === 'fail' ? 1 : 0;
}
