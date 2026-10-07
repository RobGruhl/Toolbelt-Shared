// smoke.mjs — the connector's smoke test. No network, no credential.
//
// Proves three things a teammate would otherwise discover by a failed session:
//   1. the registration block never carries a literal credential — both OAuth vars are ${VAR}
//      references the MCP client expands from the process environment (SENSIBILITIES #11);
//   2. verbs[] names every core-tier tool of workspace-mcp 1.25.0 (core/tool_tiers.yaml) with
//      an honest tier, so the offered permission profile is complete and a new tool cannot
//      appear in-session unclassified;
//   3. checks/token-cache.mjs emits one well-formed result line.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, '..', 'toolbelt.json'), 'utf8'));
const failures = [];

// 1. registration carries references, never literals
const env = manifest.mcp?.registration?.env ?? {};
for (const name of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) {
  if (env[name] !== `\${${name}}`) failures.push(`mcp.registration.env.${name} must be the reference \${${name}}, got ${JSON.stringify(env[name])}`);
}
if (manifest.mcp?.registration?.command !== 'uvx') failures.push('registration command must be uvx (nothing installed globally)');

// 2. every core-tier tool has a verb with an honest tier
const CORE = {
  read: [
    'search_gmail_messages', 'get_gmail_message_content', 'get_gmail_messages_content_batch',
    'search_drive_files', 'get_drive_file_content', 'get_drive_file_download_url', 'get_drive_shareable_link',
    'list_calendars', 'get_events',
    'get_doc_content',
    'read_sheet_values',
    'get_messages', 'search_messages',
    'get_form',
    'get_presentation',
    'get_task', 'list_tasks',
    'search_contacts', 'get_contact', 'list_contacts',
    'search_custom',
    'list_script_projects', 'get_script_project', 'get_script_content', 'generate_trigger_code',
  ],
  write: [
    'send_gmail_message',
    'create_drive_file', 'create_drive_folder', 'import_to_google_doc', 'import_to_google_slides', 'import_to_google_sheets',
    'manage_event',
    'create_doc', 'modify_doc_text',
    'create_spreadsheet', 'modify_sheet_values',
    'send_message', 'create_reaction',
    'create_form',
    'create_presentation',
    'manage_task',
    'manage_contact',
    'create_script_project', 'update_script_content', 'run_script_function',
  ],
};
const verbs = new Map((manifest.verbs ?? []).map((v) => [v.name, v]));
for (const [tier, names] of Object.entries(CORE)) {
  for (const n of names) {
    const v = verbs.get(n);
    if (!v) failures.push(`core tool ${n} has no verbs[] entry`);
    else if (v.tier !== tier) failures.push(`core tool ${n} is tier ${v.tier}; the smoke test expects ${tier}`);
    else if (v.surface !== 'mcp') failures.push(`core tool ${n} must have surface "mcp"`);
    else if (tier === 'write' && !v.note) failures.push(`ungated write ${n} needs a note (docs/MANIFEST.md)`);
  }
}
const coreCount = CORE.read.length + CORE.write.length;
if (coreCount !== 45) failures.push(`smoke table lists ${coreCount} core tools; workspace-mcp 1.25.0 core tier has 45`);
for (const v of verbs.values()) {
  if (v.tier === 'write-gated') failures.push(`${v.name}: a connector cannot claim a gate (no code here) — tier write with a note, or never`);
}

// 3. the custom check speaks the doctor's contract
const r = spawnSync(process.execPath, [path.join(here, 'token-cache.mjs')], { encoding: 'utf8', timeout: 10_000 });
try {
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  if (!['pass', 'warn', 'fail', 'skip'].includes(out.status) || typeof out.detail !== 'string') throw new Error('shape');
  if (/refresh_token|client_secret["']?\s*[:=]/.test(out.detail)) failures.push('token-cache.mjs leaked a credential field into its detail');
} catch {
  failures.push(`checks/token-cache.mjs did not emit a JSON result (exit ${r.status})`);
}

if (failures.length) {
  for (const f of failures) console.error(`smoke: ${f}`);
  process.exit(1);
}
console.log(`smoke ok: registration carries references only; ${coreCount} core-tier tools tiered (${CORE.read.length} read, ${CORE.write.length} write); token-cache check well-formed`);
