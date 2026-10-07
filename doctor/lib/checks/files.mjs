// files.mjs — file/symlink/env presence checks.
import { existsSync, lstatSync, realpathSync, statSync, accessSync, readFileSync, constants } from 'node:fs';
import { exec } from '../platform.mjs';
import path from 'node:path';

export const checks = {
  'files.exists': {
    title: 'required file present',
    category: 'files',
    impl: {
      // `paths: [canonical, legacy]` — first existing wins, so a credential file that has
      // moved to ~/.config/toolbelt/<tool>.env (SENSIBILITIES #11) still reads green, and a
      // legacy hit is labelled as the deprecated fallback it is.
      darwin: async (ctx, params) => {
        const candidates = (params.paths ?? [params.path]).map((x) => ctx.expand(x));
        const hit = candidates.find((x) => existsSync(x));
        if (!hit) return { status: 'fail', detail: `${candidates.length > 1 ? `none of ${candidates.join(', ')}` : candidates[0]} missing` };
        if (candidates.length > 1 && hit !== candidates[0]) {
          return { status: 'warn', detail: `${hit} (deprecated fallback — move it to ${candidates[0]}, chmod 600)` };
        }
        return { status: 'pass', detail: hit };
      },
      win32: null,
    },
  },

  'files.symlink_valid': {
    title: 'symlink resolves',
    category: 'files',
    impl: {
      darwin: async (ctx, params) => {
        const p = ctx.expand(params.path);
        if (!existsSync(p) && !safeIsSymlink(p)) return { status: 'fail', detail: `${params.path} missing` };
        let resolved;
        try {
          resolved = realpathSync(p);
        } catch {
          return { status: 'fail', detail: `${params.path} is a broken symlink` };
        }
        if (params.target) {
          const want = ctx.expand(params.target);
          let wantReal = want;
          try { wantReal = realpathSync(want); } catch { /* compare as-is */ }
          if (resolved !== wantReal) {
            return { status: 'warn', detail: `${params.path} -> ${resolved} (expected ${want})` };
          }
        }
        return { status: 'pass', detail: `${params.path} -> ${resolved}` };
      },
      win32: null,
    },
  },

  'files.fresh': {
    title: 'content freshness',
    category: 'files',
    impl: {
      darwin: async (ctx, params) => {
        const p = ctx.expand(params.path);
        if (!existsSync(p)) return { status: 'fail', detail: `${p} missing` };
        const { statSync } = await import('node:fs');
        const ageH = (Date.now() - statSync(p).mtime.getTime()) / 3_600_000;
        const ageStr = ageH < 48 ? `${ageH.toFixed(0)}h` : `${Math.round(ageH / 24)}d`;
        const max = params.max_age_hours ?? 336; // 14 days
        return ageH > max
          ? { status: 'fail', detail: `${p} last touched ${ageStr} ago (max ${Math.round(max / 24)}d) — stale` }
          : { status: 'pass', detail: `${p} fresh (${ageStr})` };
      },
      win32: null,
    },
  },

  'files.env_set': {
    title: 'credential present (env or key file)',
    category: 'files',
    impl: {
      // Presence only — never the value. Mirrors how the tool itself resolves the
      // credential so the check goes green exactly when the tool would work: env var
      // first, then an optional `key_file` fallback. The file branch enforces the same
      // 600-mode requirement the tool does, so we never report green on a file a tool that
      // refuses group/world-readable key files would reject.
      darwin: async (ctx, params) => {
        const env = process.env[params.name];
        // An exported-but-empty variable is absent: it is how a credential looks after a
        // failed `export $(…)` or a sourced file with a blank line, and no tool can
        // authenticate with it.
        if (env !== undefined && env.trim() === '') {
          return { status: 'fail', detail: `${params.name} is set but empty` };
        }
        if (env !== undefined) {
          return { status: 'pass', detail: `${params.name} is set` };
        }
        // `key_files: [canonical, legacy]` — first existing wins; a legacy hit is named as the
        // deprecated fallback so the move to ~/.config/toolbelt/ is a warning, never a red.
        const keyFiles = (params.key_files ?? (params.key_file ? [params.key_file] : [])).map((x) => ctx.expand(x));
        if (keyFiles.length) {
          const file = keyFiles.find((x) => existsSync(x));
          if (!file) return { status: 'fail', detail: `${params.name} not set and ${keyFiles.join(' / ')} absent` };
          const looseBits = statSync(file).mode & 0o077;
          if (looseBits !== 0) {
            return { status: 'fail', detail: `${file} is group/world readable — chmod 600 it` };
          }
          // A touched-but-never-filled key file is absence wearing the right permissions.
          if (readFileSync(file, 'utf8').trim() === '') {
            return { status: 'fail', detail: `${file} exists but is empty` };
          }
          if (keyFiles.length > 1 && file !== keyFiles[0]) {
            return { status: 'warn', detail: `${params.name} unset, using ${file} (mode 600) — deprecated fallback, move it to ${keyFiles[0]}` };
          }
          return { status: 'pass', detail: `${params.name} unset, using ${file} (mode 600)` };
        }
        return { status: 'fail', detail: `${params.name} not set in this shell` };
      },
      win32: null,
    },
  },

  'files.dir_writable': {
    title: 'directory writable',
    category: 'files',
    impl: {
      darwin: async (ctx, params) => {
        const p = ctx.expand(params.path);
        if (!existsSync(p)) return { status: 'fail', detail: `${params.path} does not exist` };
        try {
          accessSync(p, constants.W_OK);
          return { status: 'pass', detail: params.path };
        } catch {
          return { status: 'fail', detail: `${params.path} not writable` };
        }
      },
      win32: null,
    },
  },

  'files.git_config': {
    title: 'git config',
    category: 'files',
    impl: {
      darwin: async (ctx, params) => {
        const r = await exec('git', ['config', '--get', params.key], { cwd: ctx.toolbelt });
        const value = r.stdout.trim();
        if (r.code !== 0 || !value) return { status: 'fail', detail: `${params.key} is unset in this clone` };
        if (params.expect && value !== params.expect) return { status: 'fail', detail: `${params.key} = ${value} (expected ${params.expect})` };
        return { status: 'pass', detail: `${params.key} = ${value}` };
      },
      win32: null,
    },
  },

  custom: {
    title: 'custom check',
    category: 'custom',
    impl: {
      darwin: async (ctx, params) => {
        const script = path.join(ctx.toolDir, params.script);
        if (!existsSync(script)) return { status: 'fail', detail: `custom check script missing: ${params.script}` };
        const r = await exec(process.execPath, [script], { cwd: ctx.toolDir, timeout: 30_000 });
        try {
          const out = JSON.parse(r.stdout.trim().split('\n').pop());
          if (!['pass', 'warn', 'fail', 'skip'].includes(out.status)) throw new Error('bad status');
          return out;
        } catch {
          return { status: 'fail', detail: `custom check did not emit a JSON result (exit ${r.code})` };
        }
      },
      win32: null,
    },
  },
};

function safeIsSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
