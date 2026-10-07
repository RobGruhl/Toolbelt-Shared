// Doctor check: the running monthly OpenAI spend estimate, summed from the audit log the
// tool appends to (~/.local/state/toolbelt/transcribe.log, TRANSCRIBE_AUDIT_LOG overrides).
// Informational: pass with the total; warn above SOFT_MONTHLY_USD so a runaway script is
// noticed on the next doctor pass rather than on the invoice.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SOFT_MONTHLY_USD = 10;
const log = process.env.TRANSCRIBE_AUDIT_LOG || path.join(homedir(), '.local', 'state', 'toolbelt', 'transcribe.log');
const month = new Date().toISOString().slice(0, 7);
const out = (status, detail) => console.log(JSON.stringify({ status, detail }));

if (!existsSync(log)) {
  out('pass', `no audit log yet (${log}) — no paid calls have been made`);
} else {
  let total = 0, n = 0;
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.startsWith(month)) continue;
    const parts = line.split(' | ');
    if (!parts.includes('endpoint=openai')) continue;
    n++;
    const est = parts.find((p) => p.startsWith('est_usd='));
    const v = est ? parseFloat(est.slice(8)) : 0;
    if (!Number.isNaN(v)) total += v;
  }
  const detail = `${month}: $${total.toFixed(4)} estimated over ${n} OpenAI request(s) — ${log}`;
  out(total > SOFT_MONTHLY_USD ? 'warn' : 'pass', detail);
}
