// no-credential-literals.mjs — no package-registry credential in a tracked file.
//
// A committed `.npmrc` / `pip.conf` / `poetry.toml` that points at a private registry invites
// exactly one footgun: a token pasted next to the registry pointer. The sanctioned shape is
// pointer in the project, token in the operator's own ~/.npmrc / keyring — never both in one
// file (SENSIBILITIES #11). This scans every tracked file for the literal forms; placeholders
// (`${VAR}`, `<token>`, `…`) and `*.example` files pass. Emits one JSON result per the doctor's
// `custom` check contract.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF = 'tools/repo-integrity/checks/no-credential-literals.mjs';

// key = value   where the value is the secret
const PATTERNS = [
  { name: 'npm _authToken', re: /:_authToken\s*=\s*(\S+)/ },
  { name: 'npm _auth', re: /(?:^|\/|\s)_auth\s*=\s*(\S+)/ },
  { name: 'npm _password', re: /:_password\s*=\s*(\S+)/ },
  { name: 'POETRY_HTTP_BASIC_* password', re: /POETRY_HTTP_BASIC_[A-Z0-9_]*PASSWORD\s*[=:]\s*["']?([^\s"']+)/ },
  { name: 'registry token env var', re: /(?:NPM|PYPI|REGISTRY|ARTIFACTORY|NEXUS|PACKAGES?)_(?:AUTH_)?TOKEN\s*[=:]\s*["']?([^\s"']+)/ },
  { name: 'credentials in index URL', re: /https?:\/\/([^\s/@:]+:[^\s/@]+)@[^\s/]*(artifactory|nexus|pypi|npm|registry|packages)/i },
];
// A value that is obviously not a secret.
const PLACEHOLDER = /^(\\?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\.\.\.|…|xxx+|\*+|your[-_]|changeme|TOKEN|token|PASSWORD|password|redacted|<redacted>|"")/i;

const SKIP_DIRS = new Set(['node_modules', '.venv', '.git', 'dist', 'build', '__pycache__']);
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(path.relative(ROOT, p));
  }
  return out;
}
// `git ls-files` is the honest set (what a commit would carry). An unzipped kit that is not yet
// a git repo falls back to walking the tree, so the check still runs on day one.
function candidates() {
  try {
    return { files: execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean), source: 'tracked' };
  } catch {
    return { files: walk(ROOT, []), source: 'tree (not a git repo yet)' };
  }
}

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.wav', '.mp3', '.ico', '.woff', '.woff2', '.lock']);
const findings = [];
let scanned = 0;
const { files, source } = candidates();
for (const rel of files) {
  if (rel.endsWith('.example') || SKIP_EXT.has(path.extname(rel)) || rel === SELF) continue;
  const file = path.join(ROOT, rel);
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, 'utf8');
  } catch { continue; }
  scanned++;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      const m = p.re.exec(lines[i]);
      if (!m) continue;
      const value = m[1] ?? '';
      if (PLACEHOLDER.test(value) || value.length < 8) continue;
      findings.push(`${rel}:${i + 1} (${p.name})`);
    }
  }
}

console.log(JSON.stringify(findings.length
  ? {
      status: 'fail',
      detail: `credential literal(s) in ${source} files: ${findings.join(', ')}`,
      fix: { description: 'Remove the value (the pointer stays; the token goes to ~/.npmrc / the poetry keyring), then ROTATE it — history keeps what the tree forgets (SENSIBILITIES #11).' },
    }
  : { status: 'pass', detail: `${scanned} ${source} files carry no registry credential literal` }));
