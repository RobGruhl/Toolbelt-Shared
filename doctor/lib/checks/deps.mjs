// deps.mjs — per-tool dependency state.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { exec, findExecutable } from '../platform.mjs';

export const checks = {
  'deps.npm_installed': {
    title: 'npm dependencies installed',
    category: 'deps',
    impl: {
      darwin: async (ctx) => {
        const nm = path.join(ctx.toolDir, 'node_modules');
        if (!existsSync(nm)) {
          return {
            status: 'fail',
            detail: 'node_modules/ missing',
            // `npm ci`, not `npm install`: it installs exactly the committed lock and cannot
            // rewrite it on a teammate's machine.
            fix: { description: 'Install dependencies from the lockfile', command: `cd ${ctx.toolDir} && npm ci` },
          };
        }
        const r = await exec('npm', ['ls', '--omit=dev', '--depth=0'], { cwd: ctx.toolDir, timeout: 60_000 });
        return r.code === 0
          ? { status: 'pass', detail: 'node_modules consistent with package.json' }
          : {
              status: 'fail',
              detail: `npm ls reports problems: ${r.stderr.split('\n')[0] || r.stdout.split('\n').find((l) => l.includes('missing')) || 'see npm ls'}`,
              fix: { description: 'Reinstall dependencies from the lockfile', command: `cd ${ctx.toolDir} && npm ci` },
            };
      },
      win32: null,
    },
  },

  'deps.poetry_env_ready': {
    // "present", not "ready": this proves an in-project .venv exists with a working
    // interpreter, which a `python -m venv` with zero dependencies installed also
    // satisfies. Pair it with deps.python_import to claim the env can actually run
    // the tool — deps.npm_installed verifies its tree via `npm ls`, this has no
    // equivalent that is cheap enough to run on every doctor pass.
    title: 'poetry venv present (in-project)',
    category: 'deps',
    impl: {
      darwin: async (ctx, params = {}) => {
        const base = params.dir ? path.join(ctx.toolDir, params.dir) : ctx.toolDir;
        const venvPython = path.join(base, '.venv', 'bin', 'python');
        if (existsSync(venvPython)) return { status: 'pass', detail: `${params.dir ? params.dir + '/' : ''}.venv present` };
        const installCmd = ctx.manifest.install?.find((s) => s.run?.includes('poetry'))?.run ?? 'poetry install';
        return {
          status: 'fail',
          detail: `${params.dir ? params.dir + '/' : ''}.venv missing`,
          fix: { description: 'Create the in-project venv', command: `cd ${ctx.toolDir} && ${installCmd}` },
        };
      },
      win32: null,
    },
  },

  'deps.python_import': {
    title: 'python module imports',
    category: 'deps',
    impl: {
      darwin: async (ctx, params) => {
        const base = params.dir ? path.join(ctx.toolDir, params.dir) : ctx.toolDir;
        const venvPython = path.join(base, '.venv', 'bin', 'python');
        if (!existsSync(venvPython)) return { status: 'skip', detail: 'no .venv to probe' };
        const r = await exec(venvPython, ['-c', `import ${params.module}`], { timeout: 20_000 });
        return r.code === 0
          ? { status: 'pass', detail: `import ${params.module} OK` }
          : { status: 'fail', detail: `import ${params.module} failed: ${r.stderr.trim().split('\n').pop()}` };
      },
      win32: null,
    },
  },
};
