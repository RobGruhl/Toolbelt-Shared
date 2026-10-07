// manifest.mjs — discover and validate toolbelt.json manifests. Zero dependencies.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KINDS = ['tool', 'connector', 'skill'];
const SCAN_DIRS = ['tools', 'connectors', 'skills'];

/**
 * Discover all manifests under the toolbelt root.
 * @returns {{manifests: object[], errors: {file:string, error:string}[]}}
 */
export function discover(toolbeltRoot) {
  const manifests = [];
  const errors = [];
  for (const dir of SCAN_DIRS) {
    const base = path.join(toolbeltRoot, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(base, entry.name, 'toolbelt.json');
      if (!existsSync(file)) continue;
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        const problems = validate(manifest, entry.name);
        if (problems.length) {
          errors.push({ file, error: problems.join('; ') });
          continue;
        }
        manifest._dir = path.join(base, entry.name);
        manifest._file = file;
        manifests.push(manifest);
      } catch (e) {
        errors.push({ file, error: `JSON parse: ${e.message}` });
      }
    }
  }
  manifests.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)));
  // An alias must never shadow a real tool, or be claimed by two tools: the whole point is
  // that a name resolves to exactly one thing. Canonical names always win over aliases, so a
  // collision would silently make one manifest's alias unreachable rather than erroring.
  const canonical = new Set(manifests.map((m) => m.name));
  const claimed = new Map();
  for (const m of manifests) {
    for (const a of m.aliases ?? []) {
      if (canonical.has(a)) {
        errors.push({ file: m._file, error: `alias "${a}" collides with the tool named "${a}"` });
      } else if (claimed.has(a)) {
        errors.push({ file: m._file, error: `alias "${a}" already claimed by "${claimed.get(a)}" — aliases are unique across the belt; edit "aliases" in this manifest (a copied example keeps the original's)` });
      } else {
        claimed.set(a, m.name);
      }
    }
  }
  return { manifests, errors };
}

/**
 * Resolve a user-typed name to a manifest: canonical name first, then aliases.
 * Every command's name lookup goes through here so `doctor`, `setup`, `register` and
 * `approve` all accept the same spellings.
 */
export function resolve(manifests, name) {
  return (
    manifests.find((m) => m.name === name) ??
    manifests.find((m) => (m.aliases ?? []).includes(name)) ??
    null
  );
}

/** Validate a manifest. Returns a list of problems (empty = valid). */
export function validate(m, dirName = null) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (!m.name || typeof m.name !== 'string') problems.push('missing "name"');
  if (dirName && m.name && m.name !== dirName) problems.push(`name "${m.name}" != directory "${dirName}"`);
  if (!KINDS.includes(m.kind)) problems.push(`"kind" must be one of ${KINDS.join('|')}`);
  if (!m.description) problems.push('missing "description"');
  if (!Array.isArray(m.platforms) || m.platforms.length === 0) problems.push('missing "platforms" array');
  // origin: provenance only. Toolbelt owns everything in its tree; nothing syncs in either
  // direction. `repo` is where the code (or the service) came from — inspiration to glance at
  // with `toolbelt inspire`, never a push/pull target. See docs/MANIFEST.md.
  if (!m.origin || typeof m.origin !== 'object' || Array.isArray(m.origin)) {
    problems.push('missing "origin" provenance block (an empty object is valid for code authored here)');
  } else {
    const o = m.origin;
    for (const k of Object.keys(o)) {
      if (!['repo', 'vendored_commit', 'vendored_at', 'subdir', 'note'].includes(k)) {
        problems.push(`origin.${k} is not a recognised key (repo | vendored_commit | vendored_at | subdir | note)`);
      }
    }
    if (o.repo !== undefined && o.repo !== null && typeof o.repo !== 'string') problems.push('origin.repo must be a string URL/path or null');
    if (o.vendored_commit && !o.repo) problems.push('origin.vendored_commit without origin.repo — nothing to compare against');
    if (m.upstream !== undefined) problems.push('legacy "upstream" block present — Toolbelt stands alone; migrate to "origin" (docs/MANIFEST.md)');
  }
  if (m.aliases !== undefined) {
    if (!Array.isArray(m.aliases) || m.aliases.some((a) => typeof a !== 'string' || !a)) {
      problems.push('"aliases" must be an array of non-empty strings');
    } else if (m.name && m.aliases.includes(m.name)) {
      problems.push(`"aliases" must not repeat the canonical name "${m.name}"`);
    }
  }
  if (m.checks && !Array.isArray(m.checks)) problems.push('"checks" must be an array');
  for (const c of m.checks ?? []) {
    if (!c.use) problems.push('check entry missing "use"');
  }
  // A contract check joins safeguards[] to test gate claims against code, so a non-array
  // here is not a cosmetic schema slip: it throws inside that check and takes down
  // contract verification for the WHOLE repo, not just the offending tool. Catch it at
  // validate() time, where the message names the file.
  if (m.safeguards !== undefined
      && (!Array.isArray(m.safeguards) || m.safeguards.some((s) => typeof s !== 'string'))) {
    problems.push('"safeguards" must be an array of strings');
  }
  if (m.install) {
    for (const s of m.install) {
      if (!s.run && !s.action) problems.push('install step needs "run" or "action"');
    }
  }
  problems.push(...validateAuth(m), ...validateVerbs(m), ...validateRisk(m), ...validateSystems(m));
  if (m.core !== undefined && typeof m.core !== 'boolean') problems.push('"core" must be a boolean');
  return problems;
}

export const PRINCIPALS = ['user', 'none', 'service'];
export const TIERS = ['read', 'write-gated', 'write', 'never'];
export const GATES = ['tty', 'typed-echo', 'flag', 'containment'];
export const SURFACES = ['cli', 'mcp', 'both'];
export const CACHE_CLASSES = ['derived', 'static', 'borrowed', 'session'];
export const CACHE_STORES = ['file', 'keychain', 'vendor', 'env'];

/**
 * auth.principal is the no-escalation thesis as data (SENSIBILITIES #13): every credential the
 * belt touches is the operator's own. "user" is the rule; "none" says the tool holds no
 * credential at all; "service" is the exception and must carry a written principal_exception,
 * which the doctor surfaces on every run so it is never silently green.
 */
function validateAuth(m) {
  const problems = [];
  const a = m.auth;
  if (a === undefined) return problems;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['"auth" must be an object'];
  if (!PRINCIPALS.includes(a.principal)) {
    problems.push(`auth.principal must be one of ${PRINCIPALS.join('|')} — the no-escalation thesis (SENSIBILITIES #13) is checked, not assumed`);
  }
  if (a.principal === 'service' && (typeof a.principal_exception !== 'string' || !a.principal_exception.trim())) {
    problems.push('auth.principal "service" needs auth.principal_exception: why this credential is not the operator\'s own and what bounds it');
  }
  if (a.caches !== undefined && !Array.isArray(a.caches)) problems.push('auth.caches must be an array');
  for (const c of a.caches ?? []) {
    if (!c || typeof c !== 'object') { problems.push('auth.caches[] entries must be objects'); continue; }
    if (c.class !== undefined && !CACHE_CLASSES.includes(c.class)) problems.push(`auth.caches[].class must be one of ${CACHE_CLASSES.join('|')}`);
    if (c.store !== undefined && !CACHE_STORES.includes(c.store)) problems.push(`auth.caches[].store must be one of ${CACHE_STORES.join('|')}`);
  }
  for (const k of ['login', 'rearm', 'identity', 'federates_from']) {
    if (a[k] !== undefined && typeof a[k] !== 'string') problems.push(`auth.${k} must be a string`);
  }
  return problems;
}

/** verbs[]: the tier of every verb as data, so a surface is a filter rather than a reading of prose. */
function validateVerbs(m) {
  const problems = [];
  if (m.verbs === undefined) return problems;
  if (!Array.isArray(m.verbs)) return ['"verbs" must be an array'];
  const seen = new Set();
  for (const v of m.verbs) {
    if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name) { problems.push('verbs[] entries need a string "name"'); continue; }
    if (seen.has(v.name)) problems.push(`verbs[] lists "${v.name}" twice`);
    seen.add(v.name);
    if (!TIERS.includes(v.tier)) problems.push(`verbs["${v.name}"].tier must be one of ${TIERS.join('|')}`);
    // Which door the verb is behind. Required when the entry registers an MCP server, because the
    // permission profile projects `mcp`/`both` verbs into mcp__<server>__<name> rules and a CLI
    // verb's name is not a tool name.
    if (v.surface !== undefined && !SURFACES.includes(v.surface)) problems.push(`verbs["${v.name}"].surface must be one of ${SURFACES.join('|')}`);
    if (m.mcp?.server_name && v.surface === undefined) problems.push(`verbs["${v.name}"] needs a surface (${SURFACES.join('|')}) because this entry registers the MCP server "${m.mcp.server_name}"`);
    if ((v.surface === 'mcp' || v.surface === 'both') && !/^[A-Za-z0-9_.-]+$/.test(v.name)) problems.push(`verbs["${v.name}"] is on the mcp surface but is not a single tool name`);
    if (v.tier === 'write-gated' && !GATES.includes(v.gate)) problems.push(`verbs["${v.name}"] is write-gated and must name its gate (${GATES.join('|')})`);
    if (v.tier !== 'write-gated' && v.gate !== undefined) problems.push(`verbs["${v.name}"].gate only applies to write-gated verbs`);
    // An ungated write is admissible only as a named, explained fact — the risk table names
    // every one. Claiming a gate that is not there is the lie the tiers exist to end.
    if (v.tier === 'write' && (typeof v.note !== 'string' || !v.note.trim())) problems.push(`verbs["${v.name}"] is an ungated write and needs a note: what bounds it, and why no gate yet`);
  }
  return problems;
}

/**
 * risk: the reviewer's own vocabulary, answered once per entry and rendered into docs/RISK.md.
 * Required on tools and connectors; skills orchestrate and carry no risk of their own.
 */
function validateRisk(m) {
  const problems = [];
  if (m.risk === undefined) {
    if (m.kind === 'tool' || m.kind === 'connector') problems.push('missing "risk" block (read_only, destructive, idempotent, open_world, worst_case) — docs/MANIFEST.md');
    return problems;
  }
  const r = m.risk;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['"risk" must be an object'];
  for (const k of ['read_only', 'destructive', 'idempotent', 'open_world']) {
    if (typeof r[k] !== 'boolean') problems.push(`risk.${k} must be a boolean`);
  }
  if (typeof r.worst_case !== 'string' || !r.worst_case.trim()) problems.push('risk.worst_case must be a one-line string');
  const writes = (Array.isArray(m.verbs) ? m.verbs : []).filter((v) => v?.tier === 'write-gated' || v?.tier === 'write');
  if (r.read_only === true && writes.length) problems.push(`risk.read_only is true but verbs[] has write entries: ${writes.map((v) => v.name).join(', ')}`);
  if (r.read_only === true && r.destructive === true) problems.push('risk.read_only and risk.destructive cannot both be true');
  return problems;
}

/** systems[]: the names your organization uses for what this entry reads, and the first read verb for each. */
function validateSystems(m) {
  const problems = [];
  if (m.systems === undefined) return problems;
  if (!Array.isArray(m.systems)) return ['"systems" must be an array'];
  for (const s of m.systems) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name) { problems.push('systems[] entries need a string "name"'); continue; }
    if (typeof s.read !== 'string' || !s.read) problems.push(`systems["${s.name}"].read (the first read verb, as typed) is required`);
    if (s.preferred !== undefined && typeof s.preferred !== 'boolean') problems.push(`systems["${s.name}"].preferred must be a boolean`);
  }
  return problems;
}

/** Find one manifest by canonical name or alias. */
export function find(toolbeltRoot, name) {
  const { manifests } = discover(toolbeltRoot);
  return resolve(manifests, name);
}
