// permissions.mjs — the OFFERED read-tier permission profile.
//
// Derived from the manifests, never hand-listed: every MCP tool whose verb tier is `read` on an
// MCP-registered entry becomes an `allow` rule; every `never` verb on one becomes a `deny`. The
// belt's own read verbs (`toolbelt list|doctor|systems|risk`) are allowed as Bash prefixes. Nothing
// else — per-tool CLIs run from their own directories, and a prefix rule that matched `cd … &&`
// would match too much.
//
// It is written to the operator's OWN settings file, merged into permissions.allow/deny without
// removing anything, only after they have read the rules and typed yes at a TTY. Never a committed
// settings.json; never a posture changed out from under someone.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function profileFor(manifests, toolbeltRoot) {
  const allow = new Set();
  const deny = new Set();
  const why = [];
  for (const cmd of ['list', 'doctor', 'systems', 'risk', 'auth --best-effort']) {
    allow.add(`Bash(${path.join(toolbeltRoot, 'bin', 'toolbelt')} ${cmd}:*)`);
    allow.add(`Bash(bin/toolbelt ${cmd}:*)`);
  }
  why.push('the belt\'s own read verbs (list, doctor, systems, risk, auth --best-effort)');
  for (const m of manifests) {
    const server = m.mcp?.server_name;
    if (!server) continue;
    const verbs = Array.isArray(m.verbs) ? m.verbs : [];
    const onMcp = verbs.filter((v) => v.surface === 'mcp' || v.surface === 'both');
    const reads = onMcp.filter((v) => v.tier === 'read');
    const nevers = onMcp.filter((v) => v.tier === 'never');
    for (const v of reads) allow.add(`mcp__${server}__${v.name}`);
    for (const v of nevers) deny.add(`mcp__${server}__${v.name}`);
    if (reads.length || nevers.length) why.push(`${m.name} (${server}): ${reads.length} read tool(s) allowed${nevers.length ? `, ${nevers.length} denied: ${nevers.map((v) => v.name).join(', ')}` : ''}`);
  }
  return { allow: [...allow].sort(), deny: [...deny].sort(), why };
}

export function settingsPath() {
  return path.join(homedir(), '.claude', 'settings.json');
}

/** Merge without removing: existing allow/deny entries stay; ours are added once. Returns what changed. */
export function merge(settings, profile) {
  const s = settings && typeof settings === 'object' ? settings : {};
  s.permissions = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
  const added = { allow: [], deny: [] };
  for (const key of ['allow', 'deny']) {
    const have = new Set(Array.isArray(s.permissions[key]) ? s.permissions[key] : []);
    for (const rule of profile[key]) if (!have.has(rule)) { have.add(rule); added[key].push(rule); }
    s.permissions[key] = [...have];
  }
  return { settings: s, added };
}

export function applyProfile(profile) {
  const file = settingsPath();
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
  const { settings, added } = merge(JSON.parse(before), profile);
  if (!added.allow.length && !added.deny.length) return { file, added, backup: null };
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `${file}.toolbelt-bak-${stamp}`;
  if (existsSync(file)) copyFileSync(file, backup);
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, added, backup: existsSync(file) ? backup : null };
}
