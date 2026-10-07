// registry.mjs — render and (TTY-gated) write Claude Code MCP registrations.
// SENSIBILITIES #1: read-first — default prints the snippet; mutation requires --write,
// a TTY confirmation, and a timestamped backup of ~/.claude.json.
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expandPath } from './platform.mjs';

function expandDeep(value, opts) {
  if (typeof value === 'string') return expandPath(value, opts);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, opts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v, opts)]));
  }
  return value;
}

export function renderRegistration(toolbeltRoot, manifest) {
  if (!manifest.mcp?.registration) return null;
  const opts = { toolbelt: toolbeltRoot, home: homedir() };
  return {
    name: manifest.mcp.server_name,
    entry: expandDeep(manifest.mcp.registration, opts),
  };
}

export async function cmdRegister(toolbeltRoot, manifest, values) {
  const reg = renderRegistration(toolbeltRoot, manifest);
  if (!reg) {
    console.log(`${manifest.name} has no MCP registration (kind: ${manifest.kind}).`);
    return 0;
  }

  console.log(`mcpServers["${reg.name}"] for ~/.claude.json:\n`);
  console.log(JSON.stringify({ [reg.name]: reg.entry }, null, 2));

  if (!values.write) {
    console.log(`\n(read-only preview — pass --write to merge into ~/.claude.json)`);
    return 0;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('\n--write mutates ~/.claude.json and requires an interactive terminal (SENSIBILITIES.md #2).');
    return 1;
  }

  const file = path.join(homedir(), '.claude.json');
  if (!existsSync(file)) {
    console.error(`\n${file} not found — is Claude Code installed?`);
    return 1;
  }

  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const existing = cfg.mcpServers?.[reg.name];
  if (existing) {
    console.log(`\nExisting entry will be replaced:`);
    console.log(JSON.stringify({ [reg.name]: existing }, null, 2));
  }

  console.log(`\n  yes →  mcpServers["${reg.name}"] in ${file} is ${existing ? 'REPLACED with' : 'set to'} the entry above (a timestamped`);
  console.log(`         backup is written first; nothing else in the file changes). Claude Code sees it after a restart and will`);
  console.log(`         inject this server's tools into every session — that is the cost of registering anything.`);
  console.log(`  no  →  nothing is written; the snippet above is yours to paste by hand if you prefer.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let ok;
  try {
    ok = (await rl.question(`\nMerge into ${file}? [y/N] `)).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (ok !== 'y' && ok !== 'yes') {
    console.log('aborted — nothing written');
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `${file}.toolbelt-bak-${stamp}`;
  copyFileSync(file, backup);

  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers[reg.name] = reg.entry;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');

  console.log(`\n✓ written. Backup: ${backup}`);
  console.log('Restart Claude Code to pick up mcpServers changes.');
  return 0;
}
