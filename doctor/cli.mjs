#!/usr/bin/env node
// toolbelt doctor — deterministic pre-flight for the Toolbelt.
// Zero npm dependencies; Node >=18. Launched via bin/toolbelt (sh) or bin/toolbelt.ps1.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, find, resolve } from './lib/manifest.mjs';
import { renderBlock, currentBlock, replaceBlock, diffSummary } from './lib/readme.mjs';
import { runManifest, runSmoke } from './lib/runner.mjs';
import { renderHuman, renderJson, renderList, renderSummaryLine, tally } from './lib/report.mjs';
import { runDerived } from './lib/derived.mjs';
import { SYSTEMS_MARKERS, SYSTEMS_PREAMBLE, renderSystems, systemsJson, RISK_MARKERS, RISK_PREAMBLE, renderRisk, CREDS_MARKERS, CREDS_PREAMBLE, renderCreds } from './lib/systems.mjs';
import { spawnShellInherit, shellQuote } from './lib/platform.mjs';

const TOOLBELT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `toolbelt — your vendored productivity tools, with a doctor

Usage:
  toolbelt list                       what's in the belt
  toolbelt doctor [tool] [--json] [--category <c>] [--smoke] [--core]
                                      pre-flight checks (all tools, or one; --core = the first-week profile)
  toolbelt auth [tool] [--best-effort] the once-a-day ritual: live-probe every credential, re-arm what needs
                                      no human, batch the sign-ins, report valid-through
  toolbelt setup <tool> [--yes]       guided install; every step is explained and TTY-confirmed. --yes asks once
                                      for all steps instead of per step — a terminal is still required.
                                      Start with: toolbelt setup toolbelt
  toolbelt approve <tool> <code>      confirm a write an agent staged (opens /dev/tty, shows the payload)
  toolbelt approve <tool> --list | --discard <code>   pending codes and their expiry; drop one unexecuted
  toolbelt ask <sketch>               draft an access request from the sketch's own access path (prints it and
                                      saves a 600-mode copy; file or post it through your belt's gated writer)
  toolbelt run <tool> -- <verb …>     run a tool's CLI from its directory and log tool+verb+date locally
  toolbelt usage [--days N]           what this machine actually ran (local log, never shared)
  toolbelt meter                      the per-session surface every agent pays for (tokens, ranked)
  toolbelt register <tool> [--write]  print (or write) the Claude Code MCP registration
  toolbelt readme  [--write|--check]  render README's belt table from the manifests
  toolbelt systems [--write|--check|--json] render SYSTEMS.md (system → tool → first read → doctor); --json for consumers
  toolbelt risk    [--write|--check]  render docs/RISK.md (principal, read-only, destructive, … per entry)
  toolbelt creds   [--write|--check]  render docs/CREDENTIALS.md (where each credential lives, how to set it)
                                      (default prints; --write updates the file; --check exits 1 on drift)
  toolbelt inspire <tool>             what the origin repo has done since we snapshotted it (read-only glance;
                                      Toolbelt stands alone — nothing is pushed or pulled)

Exit codes: 0 ok · 1 check(s) failed · 2 usage · 3 internal error · 4 inconclusive (a check has no implementation on this platform)
Docs: README.md · SENSIBILITIES.md · docs/MANIFEST.md`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      smoke: { type: 'boolean', default: false },
      category: { type: 'string' },
      core: { type: 'boolean', default: false },
      'best-effort': { type: 'boolean', default: false },
      days: { type: 'string' },
      write: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      discard: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, toolName] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return values.help || command ? 0 : 2;
  }

  switch (command) {
    case 'list':
      return cmdList();
    case 'doctor':
      return cmdDoctor(toolName, values);
    case 'setup':
      return cmdSetup(toolName, values);
    case 'register':
      return cmdRegister(toolName, values);
    case 'readme':
      return cmdReadme(values);
    case 'systems':
      if (values.json) {
        const { manifests, errors } = discover(TOOLBELT);
        if (errors.length) { for (const e of errors) console.error(`manifest error: ${e.file} — ${e.error}`); return 1; }
        console.log(JSON.stringify(systemsJson(manifests), null, 2));
        return 0;
      }
      return cmdDerived(values, {
        file: path.join(TOOLBELT, 'SYSTEMS.md'), m: SYSTEMS_MARKERS, render: renderSystems,
        preamble: SYSTEMS_PREAMBLE, what: 'SYSTEMS.md', regenerate: 'bin/toolbelt systems --write',
      });
    case 'risk':
      return cmdDerived(values, {
        file: path.join(TOOLBELT, 'docs', 'RISK.md'), m: RISK_MARKERS, render: renderRisk,
        preamble: RISK_PREAMBLE, what: 'docs/RISK.md', regenerate: 'bin/toolbelt risk --write',
      });
    case 'creds':
      return cmdDerived(values, {
        file: path.join(TOOLBELT, 'docs', 'CREDENTIALS.md'), m: CREDS_MARKERS, render: renderCreds,
        preamble: CREDS_PREAMBLE, what: 'docs/CREDENTIALS.md', regenerate: 'bin/toolbelt creds --write',
      });
    case 'auth':
      return cmdAuth(toolName, values);
    case 'approve':
      return cmdApprove(toolName, positionals[2], values);
    case 'run': {
      const { cmdRun } = await import('./lib/lifecycle.mjs');
      const dash = process.argv.indexOf('--');
      return cmdRun(TOOLBELT, toolName, dash === -1 ? positionals.slice(2) : process.argv.slice(dash + 1));
    }
    case 'usage': {
      const { cmdUsage } = await import('./lib/lifecycle.mjs');
      return cmdUsage(TOOLBELT, { days: values.days ? parseInt(values.days, 10) || 30 : 30 });
    }
    case 'meter': {
      const { cmdMeter } = await import('./lib/lifecycle.mjs');
      return cmdMeter(TOOLBELT);
    }
    case 'ask': {
      const { cmdAsk } = await import('./lib/ask.mjs');
      return cmdAsk(TOOLBELT, toolName);
    }
    case 'inspire':
      return cmdInspire(toolName);
    default:
      console.error(`toolbelt: unknown command "${command}"\n`);
      console.log(HELP);
      return 2;
  }
}

function cmdList() {
  const { manifests, errors } = discover(TOOLBELT);
  if (!manifests.length && !errors.length) {
    console.log('the belt is empty — add a tool at tools/<name>/toolbelt.json (docs/MANIFEST.md), then: bin/toolbelt doctor <name>');
    return 0;
  }
  console.log(renderList(manifests));
  for (const e of errors) console.error(`manifest error: ${e.file} — ${e.error}`);
  return errors.length ? 1 : 0;
}

async function cmdDoctor(toolName, values) {
  const { manifests, errors } = discover(TOOLBELT);
  let targets = manifests;
  if (toolName) {
    const m = resolve(manifests, toolName);
    if (!m) {
      console.error(`toolbelt: no such tool "${toolName}". Try: toolbelt list`);
      return 2;
    }
    targets = [m];
  } else if (values.core) {
    // The first-week profile: finite, so "fix the reds" has an end. Membership is the manifests'
    // `core: true`, never a list in this file. A tool named `repo-integrity` — the belt's own
    // contract check, if your belt carries one — rides along; it costs nothing.
    targets = manifests.filter((m) => m.core === true || m.name === 'repo-integrity');
  }

  const results = [];
  for (const m of targets) {
    results.push(await runManifest(TOOLBELT, m, { category: values.category ?? null }));
  }

  let smoke = [];
  if (values.smoke) {
    for (const m of targets) smoke.push(await runSmoke(TOOLBELT, m));
  }

  const payload = { toolbelt: TOOLBELT, results, errors, smoke, profile: values.core ? 'core' : toolName ? 'one' : 'all' };
  console.log(values.json ? renderJson(payload) : renderHuman(payload));
  const counts = tally(results, errors, smoke);
  // One paste-able line for your team channel: what a teammate reports instead of a 100-line PR.
  // Platform, node, the profile, the counts — never a path, never a secret.
  if (!values.json) console.log(`\n${renderSummaryLine(payload)}`);
  if (counts.fail > 0) return 1;
  // Nothing failed, but checks with no implementation for this platform were skipped, so the
  // run is inconclusive rather than clean. CONTRIBUTING makes `doctor` the acceptance gate
  // ("go green"), and a gate that cannot fail is not a gate. 4 keeps this distinguishable from
  // a real failure (1), a usage error (2), and a crash (3).
  if (counts.unimplemented > 0) return 4;
  return 0;
}

async function cmdSetup(toolName, values) {
  if (!toolName) {
    console.error('usage: toolbelt setup <tool>');
    return 2;
  }
  const m = find(TOOLBELT, toolName);
  if (!m) {
    console.error(`toolbelt: no such tool "${toolName}"`);
    return 2;
  }
  const { cmdSetup: impl } = await import('./lib/setup.mjs');
  return impl(TOOLBELT, m, values);
}

async function cmdRegister(toolName, values) {
  if (!toolName) {
    console.error('usage: toolbelt register <tool> [--write]');
    return 2;
  }
  const m = find(TOOLBELT, toolName);
  if (!m) {
    console.error(`toolbelt: no such tool "${toolName}"`);
    return 2;
  }
  const { cmdRegister: impl } = await import('./lib/registry.mjs');
  return impl(TOOLBELT, m, values);
}

function cmdDerived(values, spec) {
  const { manifests, errors } = discover(TOOLBELT);
  if (errors.length) {
    for (const e of errors) console.error(`manifest error: ${e.file} — ${e.error}`);
    return 1;
  }
  try {
    return runDerived({ ...spec, values, render: () => spec.render(manifests) });
  } catch (e) {
    console.error(`toolbelt ${spec.what}: ${e.message}`);
    return 1;
  }
}

async function cmdAuth(toolName, values) {
  const { cmdAuth: impl } = await import('./lib/authcmd.mjs');
  return impl(TOOLBELT, toolName ?? null, { bestEffort: values['best-effort'] });
}

/**
 * `toolbelt approve <tool> <code>` — the human half of a staged write. The agent composed the
 * payload and could not open /dev/tty; this runs the tool's own approve entrypoint, which can.
 * The belt adds nothing to the gate here: it only finds the command, so the human types one
 * short line instead of a whole script invocation (SENSIBILITIES #2, staging).
 */
async function cmdApprove(toolName, code, values = {}) {
  if (!toolName) {
    console.error('usage: toolbelt approve <tool> <code>   (or: toolbelt approve <tool> --list | --discard <code>)');
    return 2;
  }
  const m = find(TOOLBELT, toolName);
  if (!m) {
    console.error(`toolbelt: no such tool "${toolName}". Try: toolbelt list`);
    return 2;
  }
  const cmd = m.entrypoints?.approve;
  if (!cmd) {
    console.error(`toolbelt: "${m.name}" stages no writes (no entrypoints.approve in its manifest).`);
    return 2;
  }
  // --list reads the pending queue and --discard drops an entry unexecuted; neither performs the
  // write, so neither needs the human gate — only confirming a code does.
  let args;
  if (values.discard) args = ['--discard', values.discard];
  else if (values.list || !code) args = ['--list'];
  else {
    if (!process.stdin.isTTY) {
      console.error('toolbelt approve needs an interactive terminal — the whole point is that a human, not a pipeline, confirms (SENSIBILITIES #2).');
      return 1;
    }
    args = [code];
  }
  return spawnShellInherit(`${cmd} ${args.map(shellQuote).join(' ')}`, { cwd: m._dir });
}

function cmdReadme(values) {
  const { manifests, errors } = discover(TOOLBELT);
  // A broken manifest means a silently missing row, which is exactly the drift this
  // command exists to prevent — refuse rather than render a table with a hole in it.
  if (errors.length) {
    for (const e of errors) console.error(`manifest error: ${e.file} — ${e.error}`);
    return 1;
  }
  let block;
  try {
    block = renderBlock(manifests);
  } catch (e) {
    console.error(`toolbelt readme: ${e.message}`);
    return 1;
  }
  const readmePath = path.join(TOOLBELT, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  if (values.check) {
    const { drifted, summary } = diffSummary(currentBlock(readme), block);
    console.log(`README.md: ${summary}`);
    if (drifted) console.log('regenerate: bin/toolbelt readme --write');
    return drifted ? 1 : 0;
  }
  if (values.write) {
    const next = replaceBlock(readme, block);
    if (next === readme) {
      console.log(`README.md belt table already current (${manifests.length} rows).`);
    } else {
      writeFileSync(readmePath, next);
      console.log(`README.md belt table rewritten from ${manifests.length} manifests.`);
    }
    return 0;
  }
  console.log(block);
  return 0;
}

function cmdInspire(toolName) {
  if (!toolName) {
    console.log(`toolbelt inspire <tool> — a read-only glance at the origin repo.

  Toolbelt owns every file in its tree; there is no sync in either direction. A tool's
  origin.repo is where the code came from — worth a look now and then for ideas worth
  hand-porting. This prints what that repo has committed since origin.vendored_commit.`);
    return 0;
  }
  const m = find(TOOLBELT, toolName);
  if (!m) {
    console.error(`toolbelt: no such tool "${toolName}". Try: toolbelt list`);
    return 2;
  }
  const { repo, vendored_commit, vendored_at, note } = m.origin ?? {};
  if (!repo) {
    console.log(`toolbelt inspire — "${m.name}" was authored in this repo; there is no origin to glance at.`);
    return 0;
  }
  const isGit = /^(https?:\/\/|git@|ssh:\/\/)/.test(repo) || /\.git$/.test(repo);
  console.log(`toolbelt inspire — "${m.name}"\n    origin: ${repo}\n    snapshot: ${vendored_commit ?? '(commit unrecorded)'}${vendored_at ? ` on ${vendored_at}` : ''}${note ? `\n    note: ${note}` : ''}\n`);
  if (!isGit) {
    console.log('  Not a git URL — open it by hand. Nothing to compare automatically.');
    return 0;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbelt-inspire-'));
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--bare', '--filter=blob:none', repo, tmp], { encoding: 'utf8' });
    if (clone.status !== 0) {
      console.log(`  Could not read the origin (${(clone.stderr || '').trim().split('\n').pop()}). It may be archived, private, or gone — which is fine; nothing here depends on it.`);
      return 0;
    }
    const git = (args) => spawnSync('git', ['--git-dir', tmp, ...args], { encoding: 'utf8' });
    const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
    if (!vendored_commit) {
      const recent = git(['log', '--oneline', '-15']).stdout.trimEnd();
      console.log(`  origin HEAD is ${head}. No snapshot commit recorded, so here are its 15 most recent commits:\n\n${recent}\n`);
    } else {
      const range = git(['log', '--oneline', `${vendored_commit}..HEAD`]);
      if (range.status !== 0) {
        console.log(`  origin HEAD is ${head}; the recorded snapshot ${vendored_commit} is not in its history (rewritten or wrong). Recent commits:\n\n${git(['log', '--oneline', '-15']).stdout.trimEnd()}\n`);
      } else {
        const lines = range.stdout.trimEnd();
        const n = lines ? lines.split('\n').length : 0;
        console.log(n ? `  ${n} commit(s) since our snapshot (${vendored_commit} → ${head}):\n\n${lines}\n` : `  Nothing new since our snapshot (${vendored_commit}).\n`);
      }
    }
    console.log(`  To look closer: git clone ${repo} /tmp/${m.name}-origin && diff -r /tmp/${m.name}-origin ${path.relative(process.cwd(), path.join(TOOLBELT, m.kind === 'connector' ? 'connectors' : m.kind === 'skill' ? 'skills' : 'tools', m.name))}
  Port ideas by hand, commit here, re-run: bin/toolbelt doctor ${m.name} --smoke`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(`toolbelt: internal error: ${e?.stack ?? e}`);
    process.exit(3);
  },
);
