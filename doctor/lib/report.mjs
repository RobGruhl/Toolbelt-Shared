// report.mjs — render doctor results for humans (TTY) and machines (--json).
import { PLATFORM } from './platform.mjs';

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const gray = (s) => c('90', s);
const bold = (s) => c('1', s);

const GLYPH = { pass: green('✓'), warn: yellow('⚠'), fail: red('✗'), skip: gray('○') };

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** VERSION at the repo root; "0.0.0" if absent so a broken checkout is visible, not fatal. */
function readVersion(toolbelt) {
  try { return readFileSync(join(toolbelt, 'VERSION'), 'utf8').trim() || '0.0.0'; } catch { return '0.0.0'; }
}

/**
 * This belt's state directory outside the tree: ~/.cache/toolbelt/<hash of the repo path>/.
 * Keyed by path so two belts on one machine (a clone and a fork, the kit and a real belt) keep
 * separate last-version and usage state instead of flipping each other's. Holds no secret.
 */
export function cacheDir(toolbelt) {
  const key = createHash('sha256').update(toolbelt).digest('hex').slice(0, 12);
  return join(homedir(), '.cache', 'toolbelt', key);
}

/**
 * Per-belt memory of the last version the doctor ran as, so a clone that `git pull`s across a
 * release boundary gets told once. Returns the previous version when it differs, else null.
 */
function noteUpgrade(toolbelt, version) {
  try {
    const dir = cacheDir(toolbelt);
    const file = join(dir, 'last-version');
    const prev = existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    if (prev !== version) { mkdirSync(dir, { recursive: true }); writeFileSync(file, version + '\n'); }
    return prev && prev !== version ? prev : null;
  } catch { return null; }
}

export function renderHuman({ toolbelt, results, errors, smoke }) {
  const lines = [];
  const version = readVersion(toolbelt);
  lines.push(bold(`toolbelt doctor`) + gray(` — ${toolbelt} · v${version} · ${PLATFORM} · node ${process.versions.node}`));
  const upgraded = noteUpgrade(toolbelt, version);
  if (upgraded) lines.push(yellow(`  upgraded ${upgraded} → ${version} since this machine last ran the doctor — read the release notes for what changed and what to re-run`));
  lines.push('');

  for (const r of results) {
    lines.push(`${GLYPH[r.status]} ${bold(r.tool)} ${gray(`(${r.kind})`)}`);
    for (const ck of r.checks) {
      // pass lines stay terse; problems get full detail + fix
      if (ck.status === 'pass') {
        lines.push(gray(`    ✓ ${ck.title}: ${ck.detail}`));
      } else {
        lines.push(`    ${GLYPH[ck.status]} ${ck.title}: ${ck.detail}`);
        if (ck.fix) {
          lines.push(`        ${gray('fix:')} ${ck.fix.description ?? ''}${ck.fix.command ? `\n        ${gray('run:')} ${ck.fix.command}` : ''}`);
        }
      }
    }
  }

  if (smoke?.length) {
    lines.push('');
    lines.push(bold('smoke tests'));
    for (const s of smoke) lines.push(`${GLYPH[s.status]} ${s.tool}: ${s.detail}`);
  }

  for (const e of errors ?? []) {
    lines.push(`${GLYPH.fail} manifest error: ${e.file} — ${e.error}`);
  }

  const counts = tally(results, errors, smoke);
  lines.push('');
  lines.push(
    `${bold('summary')}  ${green(`${counts.pass} pass`)} · ${counts.warn ? yellow(`${counts.warn} warn`) : `${counts.warn} warn`} · ${counts.fail ? red(`${counts.fail} fail`) : `${counts.fail} fail`} · ${gray(`${counts.skip} skip`)}`,
  );
  // Without this line a win32 run looks like a clean sweep: no failures, and the skip count
  // reads as "not applicable" rather than "not checked".
  if (counts.unimplemented) {
    lines.push(
      yellow(
        `         ${counts.unimplemented} of those skips ${counts.unimplemented === 1 ? 'is a check' : 'are checks'} with no ${PLATFORM} implementation — ` +
          `this run proves nothing about ${counts.unimplemented === 1 ? 'it' : 'them'}`,
      ),
    );
  }
  return lines.join('\n');
}

/**
 * The line a teammate pastes into your team channel. Everything a maintainer needs to triage and
 * nothing that identifies the machine: version, platform, node, profile, counts, and the names of
 * the failing tools (tool names are public; check details and paths are not).
 */
export function renderSummaryLine({ toolbelt, results, errors, smoke, profile = 'all' }) {
  const counts = tally(results, errors, smoke);
  const failing = results.filter((r) => r.status === 'fail').map((r) => r.tool);
  const bits = [
    `toolbelt v${readVersion(toolbelt)}`, PLATFORM, `node ${process.versions.node}`, `doctor --${profile}`,
    `${counts.pass} pass / ${counts.warn} warn / ${counts.fail} fail`,
  ];
  if (failing.length) bits.push(`failing: ${failing.join(', ')}`);
  if (counts.unimplemented) bits.push(`${counts.unimplemented} unimplemented here`);
  return `paste to your team channel → ${bits.join(' · ')}`;
}

export function renderJson({ toolbelt, results, errors, smoke, profile = 'all' }) {
  const counts = tally(results, errors, smoke);
  return JSON.stringify(
    {
      toolbelt,
      platform: PLATFORM,
      node: process.versions.node,
      profile,
      generated_at: new Date().toISOString(),
      summary_line: renderSummaryLine({ toolbelt, results, errors, smoke, profile }),
      results,
      ...(smoke?.length ? { smoke } : {}),
      manifest_errors: errors ?? [],
      summary: counts,
      // ok requires zero failures AND zero unimplemented checks: a run in which nothing could be
      // checked (every check unimplemented on this platform) is not a clean bill of health.
      // Absence of failure is not evidence of health.
      ok: counts.fail === 0 && counts.unimplemented === 0,
      // Distinguishes "verified broken" from "not verified" for machine consumers.
      inconclusive: counts.fail === 0 && counts.unimplemented > 0,
    },
    null,
    2,
  );
}

export function tally(results, errors = [], smoke = []) {
  // `unimplemented` is a subset of `skip`, not a fifth status: it counts only checks the
  // doctor could not run on this platform. Skips that mean "this tool does not support this
  // platform" are excluded, because those are a correct answer rather than a blind spot.
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0, unimplemented: 0 };
  for (const r of results) {
    for (const ck of r.checks) {
      counts[ck.status] = (counts[ck.status] ?? 0) + 1;
      if (ck.unimplemented) counts.unimplemented += 1;
    }
  }
  for (const s of smoke ?? []) if (s.status !== 'skip') counts[s.status] += 1;
  counts.fail += (errors ?? []).length;
  return counts;
}

export function renderList(manifests) {
  const lines = [];
  const w = Math.max(...manifests.map((m) => m.name.length), 4);
  for (const kind of ['tool', 'connector', 'skill']) {
    const group = manifests.filter((m) => m.kind === kind);
    if (!group.length) continue;
    lines.push(bold(`${kind}s`));
    for (const m of group) {
      lines.push(`  ${m.name.padEnd(w + 2)}${m.description}`);
      if (m.aliases?.length) lines.push(gray(`  ${''.padEnd(w + 2)}↳ also: ${m.aliases.join(', ')}`));
      if (m.safeguards?.length) lines.push(gray(`  ${''.padEnd(w + 2)}↳ ${m.safeguards[0]}`));
    }
    lines.push('');
  }
  return lines.join('\n');
}
