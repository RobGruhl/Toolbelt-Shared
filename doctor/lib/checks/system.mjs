// system.mjs — system-level dependency checks (darwin implemented; win32 planned).
import { existsSync } from 'node:fs';
import { exec, findExecutable } from '../platform.mjs';

export const checks = {
  'system.chrome': {
    title: 'Google Chrome installed',
    category: 'system',
    impl: {
      darwin: async (ctx) => {
        const candidates = [
          process.env.CHROME_PATH,
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          `${ctx.home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        ].filter(Boolean);
        const found = candidates.find((c) => existsSync(c));
        return found
          ? { status: 'pass', detail: found }
          : {
              status: 'fail',
              detail: 'Chrome not found (needed for browser-based SSO login)',
              fix: { description: 'Install Google Chrome', command: 'brew install --cask google-chrome' },
            };
      },
      win32: null,
    },
  },

  'system.brew': {
    title: 'Homebrew installed',
    category: 'system',
    impl: {
      darwin: async () => {
        const brew = await findExecutable(['brew', '/opt/homebrew/bin/brew']);
        if (!brew) {
          return {
            status: 'fail',
            detail: 'Homebrew not found',
            fix: { description: 'Install Homebrew from https://brew.sh (the one sanctioned installer script)' },
          };
        }
        return { status: 'pass', detail: brew };
      },
      win32: null,
    },
  },

  'system.ffmpeg': {
    title: 'ffmpeg + ffprobe installed',
    category: 'system',
    impl: {
      darwin: async () => {
        const ffmpeg = await findExecutable(['ffmpeg', '/opt/homebrew/bin/ffmpeg']);
        const ffprobe = await findExecutable(['ffprobe', '/opt/homebrew/bin/ffprobe']);
        return ffmpeg && ffprobe
          ? { status: 'pass', detail: ffmpeg }
          : {
              status: 'fail',
              detail: 'ffmpeg/ffprobe not found (needed for audio compression and chunking)',
              fix: { description: 'Install ffmpeg', command: 'brew install ffmpeg' },
            };
      },
      win32: null,
    },
  },

  'system.git': {
    title: 'git installed',
    category: 'system',
    impl: {
      darwin: async () => {
        const r = await exec('git', ['--version']);
        return r.code === 0
          ? { status: 'pass', detail: r.stdout.trim() }
          : { status: 'fail', detail: 'git not found', fix: { description: 'Install git', command: 'brew install git' } };
      },
      win32: null,
    },
  },

  /**
   * The doctor's one sanctioned network read. Dozens of clones update by `git pull` with nothing
   * between a commit and their machine; a P0 gate fix on main would otherwise leave every stale
   * clone green forever. One `git fetch` of origin/main, then a count — no write, no checkout.
   */
  'system.clone_fresh': {
    title: 'clone is current with origin/main',
    category: 'system',
    impl: {
      darwin: async (ctx, params) => {
        const git = (args, timeout = 15_000) => exec('git', args, { cwd: ctx.toolbelt, timeout });
        const remote = await git(['remote', 'get-url', 'origin']);
        if (remote.code !== 0) return { status: 'skip', detail: 'no origin remote — nothing to compare with' };
        const fetch = await git(['fetch', '--quiet', 'origin', 'main'], 25_000);
        if (fetch.code !== 0) return { status: 'warn', detail: `could not reach origin (${(fetch.stderr || fetch.error || '').trim().split('\n').pop() || 'fetch failed'}) — staleness unknown` };
        const behind = await git(['rev-list', '--count', 'HEAD..origin/main']);
        const ahead = await git(['rev-list', '--count', 'origin/main..HEAD']);
        const b = parseInt(behind.stdout, 10) || 0;
        const a = parseInt(ahead.stdout, 10) || 0;
        const max = params.behind_max ?? 20;
        if (b === 0) return { status: 'pass', detail: `up to date with origin/main${a ? ` (${a} local commit(s) ahead)` : ''}` };
        if (b > max) return { status: 'fail', detail: `${b} commits behind origin/main — gate fixes on main are not on this machine`, fix: { description: 'git pull --ff-only, then re-run the doctor', command: 'git pull --ff-only' } };
        return { status: 'warn', detail: `${b} commit(s) behind origin/main`, fix: { description: 'git pull --ff-only', command: 'git pull --ff-only' } };
      },
      win32: null,
    },
  },
};
