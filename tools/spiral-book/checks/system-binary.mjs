// system-binary.mjs — one doctor check per brew-installed binary the pipeline needs.
// Invoked by the manifest's `custom` checks as `node checks/system-binary.mjs <name>`; the
// wrappers pandoc.mjs and typst.mjs exist because a custom check takes no params.
import { spawnSync } from 'node:child_process';

const FIX = {
  pandoc: { why: 'Markdown → Typst conversion', command: 'brew install pandoc' },
  typst: { why: 'Typst → PDF compilation', command: 'brew install typst' },
  fswatch: { why: 'watch mode in a scaffolded build.sh (optional)', command: 'brew install fswatch', optional: true },
};

export function checkBinary(name) {
  const spec = FIX[name];
  if (!spec) return { status: 'fail', detail: `no such binary in the table: ${name}` };
  const w = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  if (w.status !== 0) {
    return {
      status: spec.optional ? 'warn' : 'fail',
      detail: `${name} not on PATH (${spec.why})`,
      fix: { description: `Install ${name} with Homebrew`, command: spec.command },
    };
  }
  const bin = w.stdout.trim();
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const version = (v.stdout || '').split('\n')[0].trim() || 'version unknown';
  return { status: 'pass', detail: `${version} (${bin})` };
}

if (process.argv[1] && process.argv[1].endsWith('system-binary.mjs')) {
  console.log(JSON.stringify(checkBinary(process.argv[2])));
}
