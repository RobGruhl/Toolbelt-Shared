// secrets.mjs — the operator's credential hygiene, checked without ever reading a value
// (SENSIBILITIES #6, #11). Four questions: do the shell rc files
// export secrets, does the process environment carry any, are there secret files inside the
// tree and are they 600, does a declared Keychain item exist. Names and modes only.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { exec } from '../platform.mjs';

/** A variable NAME that is shaped like a secret. Deliberately broad on names, silent on values. */
export const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|_PAT$|^PAT_|CREDENTIALS?$|AUTH$|_KEY$)/i;
/** Names that match the shape but are not secrets (paths, flags, public ids). */
const NOT_SECRET = /(_FILE$|_PATH$|_DIR$|_URL$|_HELPER$|_ID$|PUBLIC|DISABLE|ENABLE|SKIP|TIMEOUT|_NAME$|TEMPLATE|EXAMPLE|TOKENS$|MAX_|_LIMIT|_COUNT)/i;
const RC_FILES = ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile'];

/**
 * Does an `export NAME=value` line carry a LITERAL secret? Command substitutions, variable
 * references, and reads from the keychain or a file are the recommended forms and pass.
 * Exported for tests; the classifier is the part that must not drift.
 */
export function rcLiteralExports(text) {
  const hits = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const [, name, rhs] = m;
    if (!SECRET_NAME.test(name) || NOT_SECRET.test(name)) continue;
    const value = rhs.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (!value) continue;
    if (/^\$\(|^`|^\$\{?[A-Za-z_]/.test(value)) continue; // $(security …), $OTHER — a reference, not a literal
    if (/^(\/|~\/)/.test(value)) continue; // a path
    hits.push(name);
  }
  return [...new Set(hits)];
}

export function envSecretNames(env = process.env) {
  return Object.keys(env)
    .filter((k) => SECRET_NAME.test(k) && !NOT_SECRET.test(k) && String(env[k] ?? '').trim())
    .sort();
}

/** Ignored-but-present files whose NAME says credential. `git ls-files -oi` never reads contents. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.ini|.*rc|.*token.*|.*secret.*|.*credential.*|.*\.pem|.*\.key|.*\.p12|.*auth.*\.json)$/i;
/** Public material that matches the shape: CA bundles are certificates, not credentials. */
const PUBLIC_FILE = /(^|\/)(ca[-_]?bundle|cacert|ca)[^/]*\.pem$/i;
/** Key=value files: read the KEYS (left of `=`), never the values, and count the file only if a key is secret-shaped. */
const KV_FILE = /(^|\/)(\.env(\..*)?|.*\.ini|.*rc)$/i;
export function kvHasSecretKey(text) {
  let parsed = 0;
  let content = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || /^\[.*\]$/.test(line)) continue;
    content++;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/.exec(line);
    if (!m) continue;
    parsed++;
    if (SECRET_NAME.test(m[1]) && !NOT_SECRET.test(m[1])) return true;
  }
  // A credential file that is not key=value at all (a pasted "Access token: …" note) is still a
  // credential file; only a file whose keys all parsed and none looked secret is config.
  return content > 0 && parsed === 0;
}
const SKIP_PATH = /(^|\/)(node_modules|\.venv|__pycache__|\.git|dist|build|\.cache)(\/|$)/;

export const checks = {
  'secrets.rc_clean': {
    title: 'shell rc files export no secret literals',
    category: 'secrets',
    impl: {
      darwin: async () => {
        const home = homedir();
        const found = [];
        for (const f of RC_FILES) {
          const p = path.join(home, f);
          if (!existsSync(p)) continue;
          let text;
          try { text = readFileSync(p, 'utf8'); } catch { continue; }
          for (const name of rcLiteralExports(text)) found.push(`${f}: ${name}`);
        }
        if (!found.length) return { status: 'pass', detail: `no literal secret exports in ${RC_FILES.filter((f) => existsSync(path.join(home, f))).join(', ') || 'any rc file'}` };
        return {
          status: 'warn',
          detail: `literal secret exports: ${found.join(', ')} — one \`env\`, \`set -x\`, or crash dump from the context window`,
          fix: { description: 'Move each to the Keychain and read it at use time (e.g. poetry config http-basic.<repo>, an apiKeyHelper, or $(security find-generic-password -w …)); then remove the export line.' },
        };
      },
      win32: null,
    },
  },

  'secrets.env_clean': {
    title: 'process environment carries no secrets',
    category: 'secrets',
    impl: {
      darwin: async (ctx, params) => {
        const allow = new Set(params.allow ?? []);
        const names = envSecretNames().filter((n) => !allow.has(n));
        if (!names.length) return { status: 'pass', detail: 'no secret-shaped variables set in this environment' };
        return {
          status: 'warn',
          detail: `set in this environment: ${names.join(', ')} — every subprocess (and every agent tool call) inherits them`,
          fix: { description: 'Prefer a 600-mode file or the Keychain the tool reads directly; if a tool needs the variable, export it in the one shell that runs the tool, not in the rc file.' },
        };
      },
      win32: null,
    },
  },

  'secrets.no_tree_secrets': {
    title: 'credential files in the tree are gitignored and mode 600',
    category: 'secrets',
    impl: {
      darwin: async (ctx) => {
        // --directory collapses ignored dirs (node_modules, .venv) to one entry each, which keeps the
        // listing small; the files we care about sit beside code, never inside a dependency tree.
        const r = await exec('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: ctx.toolbelt, timeout: 30_000 });
        if (r.code !== 0) return { status: 'skip', detail: `git ls-files failed (${r.error ?? r.stderr.trim() ?? 'not a git checkout'}) — nothing to compare against .gitignore` };
        const files = r.stdout.split('\0')
          .filter((f) => f && !f.endsWith('/') && !SKIP_PATH.test(f) && SECRET_FILE.test(f) && !PUBLIC_FILE.test(f) && !/\.example$/i.test(f))
          .filter((f) => {
            if (!KV_FILE.test(f)) return true; // a key, a token cache, a p12: credential by name
            try { return kvHasSecretKey(readFileSync(path.join(ctx.toolbelt, f), 'utf8')); } catch { return true; }
          });
        const loose = [];
        for (const f of files) {
          try {
            const st = statSync(path.join(ctx.toolbelt, f));
            if (st.isFile() && (st.mode & 0o077) !== 0) loose.push(`${f} (mode ${(st.mode & 0o777).toString(8)})`);
          } catch { /* vanished — fine */ }
        }
        if (loose.length) {
          return { status: 'fail', detail: `credential file(s) readable by others: ${loose.join(', ')}`, fix: { description: 'chmod 600 each — then move it to ~/.config/toolbelt/<tool>.env, the canonical home (SENSIBILITIES #11)', command: `chmod 600 ${loose.map((l) => l.split(' ')[0]).join(' ')}` } };
        }
        // A tracked credential file would be a leak, not a warning — but detect-secrets and the
        // hook own that. This check is about the ignored ones: present, 600, and a deprecated home.
        if (!files.length) return { status: 'pass', detail: 'no credential-shaped files inside the tree' };
        return {
          status: 'warn',
          detail: `${files.length} gitignored credential file(s) in the tree, all mode 600: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''} — the in-tree .env is a deprecated fallback`,
          fix: { description: 'Move each to ~/.config/toolbelt/<tool>.env (mode 600). git clean -fdx destroys in-tree credentials and an agent\'s grep -r pulls them into context.' },
        };
      },
      win32: null,
    },
  },

  'secrets.keychain_item': {
    title: 'keychain item present',
    category: 'secrets',
    impl: {
      darwin: async (ctx, params) => {
        // Presence only: no -w, so the secret never leaves the keychain. `services` lists the
        // names a tool reads in order (canonical first); the first present one passes.
        const services = params.services ?? [params.service];
        for (const service of services) {
          const args = ['find-generic-password', '-s', service];
          if (params.account) args.push('-a', params.account);
          const r = await exec('security', args, { timeout: 10_000 });
          if (r.code === 0) return { status: 'pass', detail: `keychain item "${service}"${params.account ? ` (${params.account})` : ''} exists` };
        }
        return { status: 'fail', detail: `no keychain item ${services.map((x) => `"${x}"`).join(' or ')}${params.account ? ` for ${params.account}` : ''}` };
      },
      win32: null,
    },
  },
};
