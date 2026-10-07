// runner.mjs — execute a manifest's declared checks through the platform-aware registry.
import { homedir } from 'node:os';
import { PLATFORM, expandPath, execShell } from './platform.mjs';
import { checks as system } from './checks/system.mjs';
import { checks as runtime } from './checks/runtime.mjs';
import { checks as deps } from './checks/deps.mjs';
import { checks as auth } from './checks/auth.mjs';
import { checks as mcp } from './checks/mcp.mjs';
import { checks as files } from './checks/files.mjs';
import { checks as secrets } from './checks/secrets.mjs';

export const registry = { ...system, ...runtime, ...deps, ...auth, ...mcp, ...files, ...secrets };

/** Apply manifest-declared severity downgrade: fail -> warn. */
export function applySeverity(result, params) {
  if (params.severity === 'warn' && result.status === 'fail') {
    return { ...result, status: 'warn' };
  }
  return result;
}

export function makeContext(toolbeltRoot, manifest) {
  const home = homedir();
  return {
    platform: PLATFORM,
    toolbelt: toolbeltRoot,
    toolDir: manifest._dir,
    manifest,
    home,
    expand: (p) => expandPath(p, { toolbelt: toolbeltRoot, home }),
  };
}

/**
 * Run all checks for one manifest.
 * @returns {Promise<{tool:string, kind:string, status:string, checks:object[]}>}
 */
export async function runManifest(toolbeltRoot, manifest, { category = null, only = null } = {}) {
  const ctx = makeContext(toolbeltRoot, manifest);
  const results = [];

  if (!manifest.platforms.includes(PLATFORM)) {
    return {
      tool: manifest.name,
      kind: manifest.kind,
      status: 'skip',
      checks: [{ id: '-', title: 'platform', status: 'skip', detail: `${manifest.name} does not support ${PLATFORM}` }],
    };
  }

  for (const entry of manifest.checks ?? []) {
    const def = registry[entry.use];
    if (!def) {
      results.push({ id: entry.use, title: entry.use, status: 'fail', detail: `unknown check "${entry.use}" — doctor and manifest out of sync` });
      continue;
    }
    if (category && def.category !== category) continue;
    if (only && !only(entry, def)) continue;
    const impl = def.impl[PLATFORM];
    if (!impl) {
      // `unimplemented` separates a coverage gap from the legitimate skip above. Both are
      // status 'skip', but they mean opposite things: "this tool does not support this
      // platform" is a correct answer, while "this check has no impl here" means the doctor
      // learned nothing and must not let the run read as clean. See tally()/renderJson().
      results.push({ id: entry.use, title: def.title, status: 'skip', unimplemented: true, detail: `not yet implemented on ${PLATFORM}` });
      continue;
    }
    let result;
    try {
      result = await impl(ctx, entry);
    } catch (e) {
      result = { status: 'fail', detail: `check crashed: ${e.message}` };
    }
    result = applySeverity(result, entry);
    // manifest-declared fix text overrides the check's default
    if (entry.fix && result.status !== 'pass') {
      result.fix = typeof entry.fix === 'string' ? { description: ctx.expand(entry.fix) } : entry.fix;
    }
    if (result.fix?.command) result.fix.command = ctx.expand(result.fix.command);
    if (result.fix?.description) result.fix.description = ctx.expand(result.fix.description);
    // A manifest may relabel a generic check so the report says what it actually proves
    // (e.g. `cli.authed` on `az account show` is a cached-profile read, not a live grant).
    results.push({ id: entry.use, title: entry.label ?? def.title, ...result });
  }

  return { tool: manifest.name, kind: manifest.kind, status: rollup(results), checks: results };
}

export function rollup(results) {
  if (results.some((r) => r.status === 'fail')) return 'fail';
  if (results.some((r) => r.status === 'warn')) return 'warn';
  if (results.length && results.every((r) => r.status === 'skip')) return 'skip';
  return 'pass';
}

/** Run a manifest's smoke test (in its dir, through the shell). */
export async function runSmoke(toolbeltRoot, manifest) {
  if (!manifest.smoke_test?.command) {
    return { tool: manifest.name, status: 'skip', detail: 'no smoke_test declared' };
  }
  const ctx = makeContext(toolbeltRoot, manifest);
  const env = {};
  // expandPath: a manifest value like "~/.config/exr/token" must reach the tool as a real
  // path — exported verbatim it shadows the tool's own default and the unexpanded ~
  // becomes a literal directory in the tree.
  for (const e of manifest.env ?? []) if (e.value !== undefined) env[e.name] = expandPath(e.value, { toolbelt: toolbeltRoot });
  const r = await execShell(ctx.expand(manifest.smoke_test.command), { cwd: manifest._dir, env, timeout: 120_000 });
  return {
    tool: manifest.name,
    status: r.code === 0 ? 'pass' : 'fail',
    detail: r.code === 0 ? (manifest.smoke_test.expect ?? 'exit 0') : `exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').pop() ?? ''}`,
  };
}
