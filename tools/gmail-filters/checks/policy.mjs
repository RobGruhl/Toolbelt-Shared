// policy.mjs — doctor `custom` check for gmf's sender policy.
//
// ~/.config/toolbelt/gmail-filters/policy.json (or $GMF_POLICY) holds the operator's labels and
// trash/protect lists. Absent is a warn (gmf runs on default labels with no trash or protect
// list); a group/world-readable or invalid file is a fail, because gmf refuses to plan with it.
// Reports counts only — never a sender. Prints exactly one JSON result line.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePolicy, POLICY_PATH } from '../gmf.mjs';

const file = process.env.GMF_POLICY || POLICY_PATH;
const shown = file.replace(homedir(), '~');
const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'policy.json.example');
const result = (r) => console.log(JSON.stringify(r));

if (!existsSync(file)) {
  result({
    status: 'warn',
    detail: `no policy at ${shown} — gmf plans with default labels (Promo, Receipts) and no trash or protect list`,
    fix: { description: 'Start from the example, then edit it', command: `mkdir -p ${path.dirname(shown)} && cp ${example} ${shown} && chmod 600 ${shown}` },
  });
} else {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    result({ status: 'fail', detail: `${shown} is mode ${mode.toString(8)}; gmf refuses a loose-permission policy`, fix: { description: 'Tighten it', command: `chmod 600 ${shown}` } });
  } else {
    try {
      const p = normalizePolicy(JSON.parse(readFileSync(file, 'utf8')), shown);
      result({
        status: 'pass',
        detail: `${shown} mode 600 · labels ${p.labels.cleanup} / ${p.labels.auto_handled} (+${Object.keys(p.labels.auto_handled_by_domain).length} per-domain) · ${p.trash.length} trash · ${p.protect.length} protect`,
      });
    } catch (e) {
      result({ status: 'fail', detail: `${shown} is invalid: ${e.message.replace(homedir(), '~')}`, fix: { description: `Compare with ${example}` } });
    }
  }
}
