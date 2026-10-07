// systems.mjs — render SYSTEMS.md and docs/RISK.md from the manifests. SYSTEMS.md is the
// front door for an agent that knows which system it needs: one row per system name your organization uses →
// the preferred headless tool → its first read verb → the doctor id. RISK.md is the same data
// in a reviewer's vocabulary. Both are derived; neither is edited by hand.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { markers } from './derived.mjs';

export const SYSTEMS_MARKERS = markers('systems-table', 'edit systems[] there, then bin/toolbelt systems --write');
export const RISK_MARKERS = markers('risk-table', 'edit risk/verbs/auth.principal there, then bin/toolbelt risk --write');

const DIR = { tool: 'tools', connector: 'connectors', skill: 'skills' };

function writeSummary(m) {
  const verbs = Array.isArray(m.verbs) ? m.verbs : [];
  const writes = verbs.filter((v) => v.tier === 'write-gated' || v.tier === 'write');
  if (!verbs.length) return m.risk?.read_only === false ? 'writes (verbs undeclared)' : 'read-only';
  if (!writes.length) return 'read-only';
  const byGate = {};
  for (const w of writes) (byGate[w.tier === 'write' ? '**ungated**' : w.gate] ??= []).push(w.name);
  return Object.entries(byGate).map(([g, names]) => `${g}: ${names.join(', ')}`).join('; ');
}

/** The contract link: CLAUDE.md when the entry has one, else its README, else the directory. Never a dead link. */
function contractPath(m) {
  const base = `${DIR[m.kind]}/${m.name}`;
  if (!m._dir) return `${base}/CLAUDE.md`;
  for (const f of ['CLAUDE.md', 'README.md']) if (existsSync(path.join(m._dir, f))) return `${base}/${f}`;
  return `${base}/`;
}

/**
 * One row per (system, entry). When two entries name the same system, the `preferred: true`
 * one leads and the other is listed under "also"; with no preference declared both rows stay,
 * which is the ambiguity the field exists to remove — so `--check` flags it.
 */
export function systemsRows(manifests) {
  const bySystem = new Map();
  for (const m of manifests) {
    for (const s of m.systems ?? []) {
      const key = s.name.trim();
      (bySystem.get(key) ?? bySystem.set(key, []).get(key)).push({ m, s });
    }
  }
  const rows = [];
  const ambiguous = [];
  for (const [name, entries] of [...bySystem.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }))) {
    const preferred = entries.filter((e) => e.s.preferred);
    let lead;
    let rest;
    if (entries.length === 1) {
      [lead] = entries;
      rest = [];
    } else if (preferred.length === 1) {
      [lead] = preferred;
      rest = entries.filter((e) => e !== lead);
    } else {
      ambiguous.push(`${name}: ${entries.map((e) => e.m.name).join(', ')}`);
      [lead, ...rest] = entries;
    }
    rows.push({ name, lead, rest });
  }
  return { rows, ambiguous };
}

export function renderSystems(manifests) {
  const { rows, ambiguous } = systemsRows(manifests);
  if (ambiguous.length) {
    throw new Error(`systems[] names a system from more than one entry with no \`preferred: true\`: ${ambiguous.join('; ')}`);
  }
  const out = ['| System | Tool | First read (from the tool dir) | Doctor | Writes | Contract |', '|---|---|---|---|---|---|'];
  for (const { name, lead, rest } of rows) {
    // A tool and a connector may share a name; label by path when they do.
    const dup = rest.some((e) => e.m.name === lead.m.name);
    const label = (e) => (dup ? `${DIR[e.m.kind]}/${e.m.name}` : e.m.name);
    const also = rest.length ? ` — also \`${rest.map(label).join('`, `')}\`` : '';
    out.push(
      `| ${name} | \`${label(lead)}\`${also} | \`${lead.s.read.replace(/\|/g, '\\|')}\` | \`toolbelt doctor ${lead.m.name} --json\` | ${writeSummary(lead.m)} | [${contractPath(lead.m)}](${contractPath(lead.m)}) |`,
    );
  }
  return out.join('\n');
}

export const SYSTEMS_PREAMBLE = `# Systems → tools

The front door for an agent that already knows which system it needs. One row per system, as
your organization names it: the one preferred headless read path, its first read verb, and the doctor that
says whether it is live on this machine. \`bin/toolbelt doctor <tool> --json\` answers "is it live
here"; the contract column is the tool's own \`CLAUDE.md\` — read it before the first call.

A configured tool whose auth fails is a **stop-and-tell**, not a workaround: say which tool, what
the doctor said, and the fix line it printed — unless the user has said "best effort" this session.

`;

const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : '—');

export function renderRisk(manifests) {
  const out = [
    '| Entry | Principal | Read-only | Destructive | Idempotent | Open-world | Write verbs (gate) | Worst case |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const m of manifests.filter((x) => x.kind !== 'skill')) {
    const r = m.risk ?? {};
    const principal = m.auth ? (m.auth.principal === 'service' ? `**service** — ${m.auth.principal_exception ?? ''}` : m.auth.principal ?? '—') : 'none (no auth block)';
    out.push(
      `| \`${DIR[m.kind]}/${m.name}\` | ${principal} | ${yn(r.read_only)} | ${yn(r.destructive)} | ${yn(r.idempotent)} | ${yn(r.open_world)} | ${writeSummary(m)} | ${(r.worst_case ?? '—').replace(/\|/g, '\\|')} |`,
    );
  }
  return out.join('\n');
}

export const RISK_PREAMBLE = `# Risk, per entry

Every tool and connector answers the same five questions once, in its manifest, and this table is
rendered from those answers (\`bin/toolbelt risk --write\`; \`bin/toolbelt risk --check\` fails on drift).
**Principal** is the no-escalation thesis ([SENSIBILITIES #13](../SENSIBILITIES.md#13-no-escalation)):
\`user\` means the operator's own credential; a \`service\` exception is printed in full here and
warned on every doctor run. **Write verbs** names each gated mutation and the gate the code enforces
(\`tty\` = /dev/tty with no bypass · \`typed-echo\` = /dev/tty plus typing the target back; a --force that skips the word is honored only where /dev/tty opens ·
\`flag\` = a loud --yes/--force, always honored, for reversible or paid-but-private actions ·
\`containment\` = throwaway profile or named destination). An **ungated** write is a private,
free, reversible one that runs at once, prints its undo, and is named here so it stays visible. **Open-world** marks entries that reach hosts the operator names rather than
one fixed service.

`;

/**
 * Machine-readable rows for consumers outside the belt (read this instead of scraping
 * README.md): one object per system, the preferred entry first.
 */
export function systemsJson(manifests) {
  const { rows, ambiguous } = systemsRows(manifests);
  return {
    generated_at: new Date().toISOString(),
    ambiguous,
    systems: rows.map(({ name, lead, rest }) => ({
      system: name,
      tool: `${DIR[lead.m.kind]}/${lead.m.name}`,
      first_read: lead.s.read,
      doctor: `bin/toolbelt doctor ${lead.m.name} --json`,
      contract: contractPath(lead.m),
      principal: lead.m.auth?.principal ?? 'none',
      writes: writeSummary(lead.m),
      read_only: lead.m.risk?.read_only ?? null,
      also: rest.map((e) => `${DIR[e.m.kind]}/${e.m.name}`),
    })),
  };
}


// -- docs/CREDENTIALS.md: where each entry's credential lives and how to put it there ----------

export const CREDS_MARKERS = markers('creds-table', 'edit env[]/auth there, then bin/toolbelt creds --write');

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderCreds(manifests) {
  const out = [
    '| Entry | Secret env var(s) | Stored in (first found wins) | Put it there | Prove it works |',
    '|---|---|---|---|---|',
  ];
  for (const m of manifests.filter((x) => x.kind !== 'skill')) {
    const secrets = (m.env ?? []).filter((e) => e.secret).map((e) => `\`${e.name}\``);
    const caches = (m.auth?.caches ?? []).map((c) => `\`${c.path}\` (${c.store}${c.class ? `, ${c.class}` : ''})`);
    if (!secrets.length && !caches.length && !m.auth?.login) continue;
    out.push(
      `| \`${DIR[m.kind]}/${m.name}\` | ${secrets.join(', ') || '—'} | ${cell(caches.join('; ') || (secrets.length ? 'env only' : '—'))} | ${cell(m.auth?.login ?? '—')} | \`${cell(m.auth?.identity ?? `bin/toolbelt doctor ${m.name}`)}\` |`,
    );
  }
  return out.join('\n');
}

export const CREDS_PREAMBLE = `# Credentials, per entry

Every credential in the belt is the operator's own and lives **outside the tree** (SENSIBILITIES #11).
The table below is rendered from each manifest's \`env[]\` and \`auth\` block
(\`bin/toolbelt creds --write\`; \`--check\` fails on drift). A tool's own \`CLAUDE.md\` holds the quirks.

## Where a key goes

Tools resolve a key in this order and stop at the first hit; set exactly one.

1. **The environment variable** the table names — for a shell session or CI.
2. **The macOS Keychain**, where the tool supports it: a generic password whose *service* is the
   env var name, account \`$USER\`. \`security add-generic-password -s NAME -a "$USER" -w\` prompts for
   the value so it never lands in shell history.
3. **\`~/.config/toolbelt/<tool>.key\` or \`<tool>.env\`**, mode 600 — the portable default. Tools
   refuse a group- or world-readable file rather than read it.
4. **\`tools/<tool>/.env\`**, only where the table lists it: gitignored, mode 600, a fallback the
   operator chose. \`.env.example\` beside it is the template; the real \`.env\` is never committed.

## Before asking the operator for a key

Look for one they already have, and report where it is — never its value:

- \`bin/toolbelt doctor <tool>\` names the store it found, or each one it tried.
- \`security dump-keychain | grep -i '"svce"' | grep -i <vendor>\` lists Keychain item *names*;
  a key saved by an older project may sit under a different service name (the lowercase
  \`elevenlabs-api-key\` is one the elevenlabs tool also accepts).
- \`grep -rlI <ENV_VAR> ~/Projects --include='.env*'\` finds project \`.env\` files by name only.

A key found somewhere the tool does not read is moved by the operator, or the tool learns the
extra location in code and in its manifest — never by pasting the value into a chat or a command
line.

`;
