// runtime.mjs — language runtime / package-manager version gates.
import { readdirSync, existsSync } from 'node:fs';
import { exec, findExecutable, cmpVersions } from '../platform.mjs';

async function pythonVersion(bin) {
  const r = await exec(bin, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], { timeout: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

export const checks = {
  'runtime.node': {
    title: 'Node.js version',
    category: 'runtime',
    impl: {
      darwin: async (ctx, params) => {
        const min = params.min ?? '18';
        const v = process.versions.node; // the doctor itself runs on node
        if (cmpVersions(v, min) >= 0) return { status: 'pass', detail: `v${v} (${process.execPath})` };
        // Name the upgrade path for the node that is actually running. `brew upgrade node`
        // on an nvm-managed install exits 0 having changed nothing, so the check keeps
        // failing with no hint why — the wrong fix is worse than none.
        const viaNvm = process.execPath.includes('/.nvm/versions/node/');
        const major = String(min).split('.')[0];
        const fix = viaNvm
          ? { description: `Install Node ${major} via nvm (this node is nvm-managed; brew does not own it)`, command: `nvm install ${major} && nvm alias default ${major}` }
          : { description: 'Upgrade Node', command: 'brew upgrade node' };
        return { status: 'fail', detail: `v${v} < required ${min}`, fix };
      },
      win32: null,
    },
  },

  'runtime.python': {
    title: 'Python version',
    category: 'runtime',
    impl: {
      darwin: async (ctx, params) => {
        const min = params.min ?? '3.13';
        const candidates = ['python3'];
        // brew kegs, newest first
        const optDir = '/opt/homebrew/opt';
        if (existsSync(optDir)) {
          const kegs = readdirSync(optDir)
            .filter((d) => /^python@3\.\d+$/.test(d))
            .sort((a, b) => cmpVersions(b.split('@')[1], a.split('@')[1]));
          for (const keg of kegs) candidates.push(`${optDir}/${keg}/bin/python3`);
        }
        for (const c of candidates) {
          const bin = await findExecutable([c]);
          if (!bin) continue;
          const v = await pythonVersion(bin);
          if (v && cmpVersions(v, min) >= 0) return { status: 'pass', detail: `${v} (${bin})` };
        }
        return {
          status: 'fail',
          detail: `no python3 >= ${min} found`,
          fix: { description: `Install Python ${min}+`, command: `brew install python@${min}` },
        };
      },
      win32: null,
    },
  },

  'runtime.poetry': {
    title: 'Poetry available',
    category: 'runtime',
    impl: {
      darwin: async (ctx) => {
        const poetry = await findExecutable(['poetry', `${ctx.home}/.local/bin/poetry`]);
        if (!poetry) {
          return { status: 'fail', detail: 'poetry not found', fix: { description: 'Install Poetry via pipx', command: 'pipx install poetry' } };
        }
        // Finding the binary is not the claim; the claim is that it runs. A poetry left
        // broken by a python upgrade is on PATH and exits non-zero.
        const r = await exec(poetry, ['--version'], { timeout: 15_000 });
        if (r.code !== 0) {
          return {
            status: 'fail',
            detail: `${poetry} found but \`poetry --version\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`,
            fix: { description: 'Reinstall Poetry via pipx', command: 'pipx reinstall poetry' },
          };
        }
        return { status: 'pass', detail: `${r.stdout.trim() || 'poetry'} (${poetry})` };
      },
      win32: null,
    },
  },

  'runtime.pipx': {
    title: 'pipx available',
    category: 'runtime',
    impl: {
      darwin: async (ctx) => {
        const pipx = await findExecutable(['pipx', `${ctx.home}/.local/bin/pipx`]);
        return pipx
          ? { status: 'pass', detail: pipx }
          : { status: 'fail', detail: 'pipx not found', fix: { description: 'Install pipx', command: 'brew install pipx' } };
      },
      win32: null,
    },
  },

  'runtime.pipx_app': {
    title: 'pipx app',
    category: 'runtime',
    impl: {
      darwin: async (ctx, params) => {
        const bin = params.binary ?? params.package;
        const found = await findExecutable([bin]);
        if (found) return { status: 'pass', detail: `${bin} at ${found}` };
        return { status: 'fail', detail: `${bin} not on PATH`, fix: { description: `pipx install ${params.package}`, command: `pipx install ${params.package}` } };
      },
      win32: null,
    },
  },
};
