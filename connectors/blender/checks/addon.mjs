// addon.mjs — check if the MCP for Blender addon is installed in Blender's addons directory.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const home = homedir();
const candidateDirs = [];

// macOS
const macBase = path.join(home, 'Library', 'Application Support', 'Blender');
if (existsSync(macBase)) {
  try {
    for (const entry of readdirSync(macBase, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidateDirs.push(path.join(macBase, entry.name, 'scripts', 'addons', 'blender_mcp.py'));
      }
    }
  } catch {}
}

// Linux
const linuxBase = path.join(home, '.config', 'blender');
if (existsSync(linuxBase)) {
  try {
    for (const entry of readdirSync(linuxBase, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidateDirs.push(path.join(linuxBase, entry.name, 'scripts', 'addons', 'blender_mcp.py'));
      }
    }
  } catch {}
}

if (process.env.BLENDERMCP_ADDONS_DIR) {
  candidateDirs.unshift(path.join(process.env.BLENDERMCP_ADDONS_DIR, 'blender_mcp.py'));
}

const found = candidateDirs.find((p) => existsSync(p));

if (found) {
  console.log(JSON.stringify({ status: 'pass', detail: found }));
} else {
  console.log(JSON.stringify({
    status: 'fail',
    detail: 'blender_mcp.py addon not found in Blender scripts/addons',
    fix: {
      description: 'Install MCP for Blender addon',
      command: 'uvx blender-mcp install-addon',
    },
  }));
}
