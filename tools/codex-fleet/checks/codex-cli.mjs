// codex-cli.mjs — the Codex CLI the fleet shells out to is on PATH and runs.
// Presence is not the claim; `codex --version` exiting 0 is.
import { execFileSync } from 'node:child_process';
try {
  const v = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  console.log(JSON.stringify({ status: 'pass', detail: v }));
} catch (e) {
  console.log(JSON.stringify({
    status: 'fail',
    detail: `codex not runnable on PATH (${e.code ?? e.status ?? 'error'})`,
    fix: { description: 'Install the Codex CLI (brew cask); never the npm global', command: 'brew install codex' },
  }));
}
