// authcmd.mjs — `toolbelt auth`: the once-a-day ritual.
//
// One idempotent verb: (1) probe every credential with a LIVE read, never a proxy; (2) re-arm
// what needs no human; (3) batch the human part; (4) let federation do its work — one lender's
// re-auth re-arms its borrowers; (5) report valid-through for every clock.
//
// Three states, not two. ABSENT (never set up here) is a quiet skip. EXPIRED (configured, was
// working, now dead) is LOUD — a registration check reads "present" over a dead credential, so
// presence must never stand in for liveness. LIVE is the answer the rest of the day relies on.
//
// Attribution rules: the identity is snapshotted BEFORE any prompt and re-read AFTER, and the
// diff is what gets reported — "your login minted a token valid through 17:14" or "nothing
// changed — the pre-check was wrong". A login whose effect is not measured gets misattributed
// ("the creds were already here") and the human stops trusting the ritual. The human
// authenticates; the belt verifies.
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { discover, resolve } from './manifest.mjs';
import { registry, makeContext, runManifest } from './runner.mjs';
import { execShell, spawnShellInherit, PLATFORM } from './platform.mjs';
import { maskTokenish } from './checks/auth.mjs';

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s), yellow = (s) => c('33', s), red = (s) => c('31', s), gray = (s) => c('90', s), bold = (s) => c('1', s);

/** The checks that constitute a credential probe: everything in the auth category, plus the two outside it that also answer "does the credential work / exist". */
const isProbe = (entry, def) => def.category === 'auth' || entry.use === 'mcp.stdio_read' || entry.use === 'files.env_set';
/** Presence-only checks: they say a credential is *there*, not that it works. */
const PRESENCE = new Set(['auth.file_cache', 'files.env_set']);

/** Does this manifest carry a credential the ritual should care about? */
export function credentialed(m) {
  if (!m.auth || m.auth.principal === 'none') return false;
  return (m.checks ?? []).some((e) => { const d = registry[e.use]; return d && isProbe(e, d); }) || (m.auth.caches ?? []).some((k) => k.path);
}

/**
 * Classify one manifest's probe results. Exported for tests: the three-state rule is the part
 * that must not drift, and it is pure.
 *   absent  — nothing present: no cache on disk, every presence check failed, no live check passed
 *   live    — every probe passed (warn counts: a loose file mode is not a dead credential)
 *   expired — something is present, and a probe failed
 */
export function classify(checks, cachesPresent) {
  const probes = checks.filter((k) => k.status !== 'skip');
  if (!probes.length) return cachesPresent ? 'live' : 'absent';
  const failed = probes.filter((k) => k.status === 'fail');
  if (!failed.length) return 'live';
  const presence = probes.filter((k) => PRESENCE.has(k.id));
  const anythingPresent = cachesPresent || presence.some((k) => k.status !== 'fail') || probes.some((k) => !PRESENCE.has(k.id) && k.status !== 'fail');
  return anythingPresent ? 'expired' : 'absent';
}

async function probe(toolbelt, m) {
  const ctx = makeContext(toolbelt, m);
  const cachesPresent = (m.auth?.caches ?? []).some((k) => k.path && existsSync(ctx.expand(k.path)));
  const r = await runManifest(toolbelt, m, { only: isProbe });
  return { checks: r.checks, state: classify(r.checks, cachesPresent) };
}

/** Snapshot who the credential is, without ever reading a secret. Only manifests that declare a safe `auth.identity` command get one. */
async function identity(toolbelt, m) {
  if (!m.auth?.identity) return null;
  const r = await execShell(m.auth.identity, { cwd: m._dir, timeout: 30_000 });
  const line = (r.stdout || '').trim().split('\n')[0] ?? '';
  return r.code === 0 && line ? maskTokenish(line).slice(0, 120) : null;
}

function runInherit(command, cwd) {
  return spawnShellInherit(command, { cwd });
}

/** The clocks: every probe detail that carries a "valid"/"expires" phrase, verbatim — the checks already redact. */
function clocks(checks) {
  return checks
    .filter((k) => /valid|expire|minted|age /i.test(k.detail ?? ''))
    .map((k) => `${k.title}: ${k.detail}`);
}

export async function cmdAuth(toolbelt, toolName, { bestEffort = false } = {}) {
  const { manifests, errors } = discover(toolbelt);
  for (const e of errors) console.error(`manifest error: ${e.file} — ${e.error}`);
  let targets = manifests.filter((m) => m.platforms.includes(PLATFORM) && credentialed(m));
  if (toolName) {
    const m = resolve(manifests, toolName);
    if (!m) { console.error(`toolbelt: no such tool "${toolName}"`); return 2; }
    if (!credentialed(m)) { console.log(`${m.name} holds no credential — nothing to authenticate.`); return 0; }
    targets = [m];
  }

  console.log(bold('toolbelt auth') + gray(` — live probe of ${targets.length} credentialed ${targets.length === 1 ? 'entry' : 'entries'}; absent = quiet, expired = loud\n`));

  // 1. Probe everything, in parallel — these are reads.
  const state = new Map();
  await Promise.all(targets.map(async (m) => state.set(m.name, await probe(toolbelt, m))));

  // 2. Re-arm what needs no human, then re-probe just those.
  const rearmed = [];
  for (const m of targets) {
    if (state.get(m.name).state !== 'expired' || !m.auth.rearm) continue;
    const r = await execShell(m.auth.rearm, { cwd: m._dir, timeout: 90_000 });
    const after = await probe(toolbelt, m);
    state.set(m.name, after);
    rearmed.push(`${m.name}: ${after.state === 'live' ? green('re-armed with no human') : yellow(`re-arm ran (exit ${r.code}) but the probe still fails`)}`);
  }
  if (rearmed.length) console.log(`${bold('re-armed')}\n  ${rearmed.join('\n  ')}\n`);

  // 3. The human part. Lenders first, so federation can re-arm their borrowers for free.
  const expired = targets.filter((m) => state.get(m.name).state === 'expired');
  const lenders = new Set(targets.map((m) => m.auth.federates_from).filter(Boolean));
  const needHuman = expired.filter((m) => m.auth.login && !(m.auth.federates_from && expired.some((x) => x.name === m.auth.federates_from)));
  needHuman.sort((a, b) => Number(lenders.has(b.name)) - Number(lenders.has(a.name)));

  if (needHuman.length) {
    console.log(bold(red(`${needHuman.length} configured ${needHuman.length === 1 ? 'credential has' : 'credentials have'} expired`)) + ' — these were working; they need you:\n');
    for (const m of needHuman) {
      const borrowers = targets.filter((x) => x.auth.federates_from === m.name).map((x) => x.name);
      console.log(`  ${red('✗')} ${bold(m.name)}${borrowers.length ? gray(`  (re-arms ${borrowers.join(', ')} too)`) : ''}\n      ${gray('run:')} ${m.auth.login}`);
    }
    console.log('');
    let go = 'n';
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(yellow('No interactive terminal, so nothing was opened. A configured tool\'s auth failure is a stop-and-tell: hand the human the lines above and wait.\n'));
    } else {
      console.log(`  yes →  each \`run:\` line above executes in turn, in this terminal; browser windows will open for SSO, and each`);
      console.log(`         tool's own token cache (600-mode, outside the repo) is rewritten with the new grant. The identity is read`);
      console.log(`         before and after, and what changed is reported. Nothing is written anywhere else.`);
      console.log(`  no  →  nothing runs; the lines above are yours to run one at a time.\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { go = (await rl.question(`Run ${needHuman.length === 1 ? 'it' : 'them all'} now, one after another? [y/N] `)).trim().toLowerCase(); } finally { rl.close(); }
    }
    if (go === 'y' || go === 'yes') {
      for (const m of needHuman) {
        const before = await identity(toolbelt, m);
        console.log(`\n${bold(m.name)} — ${m.auth.login}${before ? gray(`  (before: ${before})`) : ''}`);
        await runInherit(m.auth.login, m._dir);
        const after = await probe(toolbelt, m);
        state.set(m.name, after);
        const ident = await identity(toolbelt, m);
        // The attribution line: what the human's action changed, by re-reading the store the tool reads.
        const what = after.state === 'live'
          ? green(`live — your sign-in ${ident && ident !== before ? `put ${ident} in place` : 'minted a working credential'}`)
          : red('still failing — the sign-in finished but the probe does not pass; the login path and the store the tool reads may differ');
        console.log(`  ${what}`);
        for (const b of targets.filter((x) => x.auth.federates_from === m.name)) {
          const again = await probe(toolbelt, b);
          state.set(b.name, again);
          console.log(`  ${again.state === 'live' ? green('✓') : red('✗')} ${b.name} (federated): ${again.state}`);
        }
      }
      console.log('');
    }
  }

  // 4. Report: valid-through for every clock.
  const rows = { live: [], expired: [], absent: [] };
  for (const m of targets) rows[state.get(m.name).state].push(m);
  if (rows.live.length) {
    console.log(bold(green(`live (${rows.live.length})`)));
    for (const m of rows.live) {
      const cl = clocks(state.get(m.name).checks);
      console.log(`  ${green('✓')} ${m.name}${cl.length ? `\n      ${gray(cl.join('\n      '))}` : ''}`);
    }
  }
  if (rows.expired.length) {
    console.log(bold(red(`\nexpired (${rows.expired.length}) — configured and dead; stop-and-tell`)));
    for (const m of rows.expired) {
      const failing = state.get(m.name).checks.filter((k) => k.status === 'fail');
      console.log(`  ${red('✗')} ${m.name}: ${failing.map((k) => k.detail).join(' · ')}${m.auth.login ? `\n      ${gray('run:')} ${m.auth.login}` : ''}${failing.find((k) => k.fix) ? `\n      ${gray('fix:')} ${failing.find((k) => k.fix).fix.description ?? failing.find((k) => k.fix).fix.command}` : ''}`);
    }
  }
  if (rows.absent.length) console.log(gray(`\nabsent (${rows.absent.length}), never set up here — skipped: ${rows.absent.map((m) => m.name).join(', ')}`));
  console.log(gray(`\nrule: a configured tool's auth failure is a stop-and-tell, not a workaround — unless the user has said "best effort" this session.`));
  return rows.expired.length && !bestEffort ? 1 : 0;
}
