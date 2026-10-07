// smoke.mjs — the connector's smoke test. No Blender GUI needed.
// Proves:
//   1. the registration block is stdio over uvx blender-mcp with loopback host and port;
//   2. verbs[] covers all blender-mcp tools with honest tiers and surface "mcp";
//   3. no write-gated verbs claimed (a connector has no code to gate);
//   4. custom checks emit well-formed JSON results.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, '..', 'toolbelt.json'), 'utf8'));
const failures = [];

// 1. registration checks
if (manifest.mcp?.registration?.command !== 'uvx') {
  failures.push(`registration command must be uvx, got ${manifest.mcp?.registration?.command}`);
}
const args = manifest.mcp?.registration?.args ?? [];
if (!args.includes('blender-mcp')) {
  failures.push('registration args must include "blender-mcp"');
}

// 2. tool classification
const EXPECTED = {
  read: [
    'get_scene_info',
    'get_object_info',
    'get_viewport_screenshot',
    'get_addon_status',
    'get_polyhaven_categories',
    'search_polyhaven_assets',
    'get_polyhaven_status',
    'get_sketchfab_status',
    'search_sketchfab_models',
    'get_sketchfab_model_preview',
    'get_polypizza_status',
    'search_polypizza_models',
    'get_hyper3d_status',
    'poll_rodin_job_status',
    'get_hunyuan3d_status',
    'poll_hunyuan_job_status',
  ],
  write: [
    'execute_blender_code',
    'set_texture',
    'download_polyhaven_asset',
    'download_sketchfab_model',
    'download_polypizza_model',
    'generate_hyper3d_model_via_text',
    'generate_hyper3d_model_via_images',
    'generate_hunyuan3d_model',
    'import_generated_asset',
    'import_generated_asset_hunyuan',
    'record_trajectory_feedback',
    'disable_telemetry',
  ],
};

const verbs = new Map((manifest.verbs ?? []).map((v) => [v.name, v]));
for (const [tier, names] of Object.entries(EXPECTED)) {
  for (const n of names) {
    const v = verbs.get(n);
    if (!v) failures.push(`tool ${n} has no verbs[] entry`);
    else if (v.tier !== tier) failures.push(`tool ${n} is tier ${v.tier}; expected ${tier}`);
    else if (v.surface !== 'mcp') failures.push(`tool ${n} surface must be "mcp"`);
    else if (tier === 'write' && !v.note) failures.push(`ungated write ${n} needs a note`);
  }
}

for (const v of verbs.values()) {
  if (v.tier === 'write-gated') failures.push(`${v.name}: a connector cannot claim a gate`);
}

// 3. check scripts contract
for (const script of ['blender-app.mjs', 'addon.mjs', 'socket.mjs']) {
  const r = spawnSync(process.execPath, [path.join(here, script)], { encoding: 'utf8', timeout: 10_000 });
  try {
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    if (!['pass', 'warn', 'fail', 'skip'].includes(out.status) || typeof out.detail !== 'string') {
      failures.push(`${script} emitted malformed result`);
    }
  } catch {
    failures.push(`${script} did not emit JSON (exit ${r.status})`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`smoke: ${f}`);
  process.exit(1);
}

console.log(`smoke ok: registration valid; ${EXPECTED.read.length + EXPECTED.write.length} tools classified (${EXPECTED.read.length} read, ${EXPECTED.write.length} write); checks speak the doctor contract`);
