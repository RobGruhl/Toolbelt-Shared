// key-accepted.mjs — does Firecrawl accept the operator's key? One GET on /team/credit-usage,
// which is not billed, bearer header only; reports remaining credits, never the key. Skips when
// no key is present (files.env_set owns that verdict). Emits one JSON result per the doctor's
// `custom` check contract.
import { keySource, resolveKey, creditUsage, setAuditSink } from '../lib/firecrawl.js';

setAuditSink(() => {});
const out = (r) => console.log(JSON.stringify(r));

if (keySource() === null) {
  out({ status: 'skip', detail: 'no Firecrawl key present — nothing to test' });
} else {
  try {
    resolveKey();
  } catch (e) {
    out({ status: 'fail', detail: e.message });
    process.exit(0);
  }
  try {
    const d = await creditUsage({ timeoutMs: 10_000 });
    const remaining = d.remainingCredits ?? d.remaining_credits;
    out({ status: 'pass', detail: `Firecrawl accepts the key from ${keySource()}; ${remaining ?? '?'} credit(s) remaining` });
  } catch (e) {
    const dead = /401/.test(e.message);
    out({
      status: dead ? 'fail' : 'warn',
      detail: dead ? 'Firecrawl rejected the key (401)' : `could not reach Firecrawl: ${e.message.slice(0, 120)}`,
      fix: dead ? { description: 'Create a new key at firecrawl.dev → API Keys and replace the stored one (env, ~/.config/toolbelt/firecrawl.key, or the toolbelt-firecrawl Keychain item)' } : undefined,
    });
  }
}
