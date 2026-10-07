// auth.mjs — token/credential state. METADATA ONLY: existence, age, mode — never contents.
import { statSync, existsSync, readFileSync } from 'node:fs';
import { execShell } from '../platform.mjs';

function ageHours(mtime) {
  return (Date.now() - mtime.getTime()) / 3_600_000;
}

/** The conventional 300s pre-expiry buffer token-caching tools refresh inside of. */
const EXPIRY_BUFFER_SECONDS = 300;

/**
 * A cache may record its expiry as epoch seconds or as an ISO-8601 string. Both have to read
 * the same way here as in the tool, or the doctor and the tool disagree about when a token is
 * spent — and the doctor's answer is the one a human trusts.
 */
function parseExpiry(v) {
  if (v === undefined || v === null || v === '') return null;
  const epoch = Number(v);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000);
  const dt = new Date(String(v));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function humanDuration(seconds) {
  const s = Math.abs(seconds);
  if (s < 3_600) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${(s / 3_600).toFixed(1)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Narrower than redact() on purpose. The only secret a token probe could emit is an
 * access token, and those are long unbroken base64url runs — so mask at 40 chars and
 * exclude `.` and `/`. redact()'s 16-char rule is right for arbitrary command output
 * but here it eats the words that make the failure diagnosable ("Reauthentication",
 * "application-default"), which is how a real dead grant reads as noise.
 */
export function maskTokenish(s) {
  return String(s).replace(/[A-Za-z0-9_=-]{40,}/g, '***');
}

/**
 * A dead grant still reads as "logged in" to every cloud CLI that answers from its
 * local profile — `az account show` and `gcloud config get-value account` both print
 * the account and exit 0 with the token cache emptied. Only *asking for a token*
 * proves the grant is alive.
 *
 * The commands live here rather than in a manifest on purpose: each one is pinned to
 * a form that cannot spill the token onto stdout, and no manifest gets to weaken that.
 */
const TOKEN_PROBES = {
  azure: {
    cli: 'az',
    needs_scope: true,
    command: (scope) => `az account get-access-token --scope ${shellQuote(scope)} --output none`,
    fix: 'Run: az login',
  },
  'gcp-adc': {
    cli: 'gcloud',
    needs_scope: false,
    command: () => 'gcloud auth application-default print-access-token >/dev/null',
    fix: 'Run: gcloud auth application-default login',
  },
};

/**
 * "A key is on disk" and "the service accepts the key" are different claims, and only
 * the second one means the tool works. Each probe sends the key in a header — never on
 * argv, where `ps` would show it — and reports only whether it was accepted.
 */
const KEY_PROBES = {
  newrelic: {
    service: 'New Relic NerdGraph',
    url: 'https://api.newrelic.com/graphql',
    request: (key) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': key },
      body: JSON.stringify({ query: '{ actor { user { email } } }' }),
    }),
    // NerdGraph answers 200 with an `errors` array for a rejected key, so a status
    // check alone would pass on a revoked one.
    accepted: (status, body) => status === 200 && !body?.errors && !!body?.data?.actor?.user,
    fix: 'Create a User key in the New Relic UI, then export NEW_RELIC_API_KEY or write it to ~/.config/newrelic/user.key (chmod 600)',
  },
  typesafe: {
    service: 'TypeSafe',
    url: 'https://api.typesafe.ai/v1/models',
    // Lists model names and runs no inference, so the probe spends nothing.
    request: (key) => ({ method: 'GET', headers: { Authorization: `Bearer ${key}` } }),
    accepted: (status, body) => status === 200 && Array.isArray(body?.models),
    fix: 'Create a key in your TypeSafe account, then export TYPESAFE_API_KEY or write it to ~/.config/toolbelt/typesafe-jev.key (chmod 600)',
  },
};

/**
 * The one sentence every network-path verdict carries. Shared by mcp.http_reachable and the
 * data-plane probe so the two never drift; tests assert on it verbatim.
 */
export const NETWORK_PATH_HINT =
  'Network path, not permission: the request reached the service from a source IP that is not on its allowlist. Connect your corporate VPN / zero-trust client (whatever puts this machine on an allowlisted egress), then retry — credentials are fine, and re-running az login will not help. Usually transient: it often clears within a few minutes.';

/**
 * "The endpoint answers" and "the endpoint will serve this tool" are different claims,
 * and only the second one means the tool works.
 *
 * An Azure OpenAI resource with networkAcls.defaultAction=Deny still reads as healthy to
 * anything short of a real call: the root answers 200 from a blocked network (a HEAD carries
 * no body, so the rejection is invisible to it), and an unauthenticated data-plane GET answers
 * 401 as readily as the allowlist 403 — the front-door behavior is not stable enough to lean
 * on. The one probe that sees the rejection under every front-door behavior is one that is
 * both authenticated AND on the data plane — the same call shape the tools make. Off the
 * allowlist the body carries the exact string "Access denied due to Virtual Network/Firewall
 * rules."; on it, 200.
 *
 * The path is pinned here rather than read from the manifest, for the same reason
 * TOKEN_PROBES pins its command: a manifest free to choose the URL is free to choose the
 * root path again and restore the blind spot. Manifests supply only the host.
 */
export const DATA_PLANE_PROBES = {
  'azure-openai': {
    service: 'Azure OpenAI',
    scope: 'https://cognitiveservices.azure.com/.default',
    // Read-only, billing-free, and generates nothing. It exists to prove the call gets
    // past the ACL, not to enumerate anything.
    path: 'openai/models?api-version=2025-04-01-preview',
    token: (scope) =>
      `az account get-access-token --scope ${shellQuote(scope)} --query accessToken --output tsv`,
    // Conjunction, not disjunction: status 403 AND a body carrying BOTH signature phrases.
    // Either phrase alone is ordinary 403 prose — "firewall" turns up in proxy blocks,
    // "virtual network" in unrelated Azure errors — so a permanent authorization or
    // content-policy 403 is never reported as a network problem.
    isNetworkDenial: (status, text) => {
      const body = String(text).toLowerCase();
      return status === 403 && body.includes('virtual network') && body.includes('firewall');
    },
    fix: NETWORK_PATH_HINT,
  },
};

/**
 * Split out from the check so the branch that matters can be tested without a live
 * `az` grant or a network. The red state of this check cannot be reproduced on demand
 * from a laptop: once a zero-trust client has classified the hostname it tunnels the flow
 * at the socket layer regardless of the IP the client resolved, so a forced-public request
 * stops reaching the public path. A unit test is therefore the only repeatable proof that
 * a 403 turns this check red, which is the whole point of it existing.
 */
export function classifyDataPlane(probe, status, text = '') {
  if (status >= 200 && status < 300) {
    return {
      status: 'pass',
      detail: `${probe.service} served an authenticated data-plane read (HTTP ${status})`,
    };
  }
  // A rate-limit answer is POSITIVE evidence for the only thing this check asks: the
  // request reached the deployment's rate limiter, which sits downstream of both the IP
  // ACL and authentication. Failing on it would be a false red — and a self-inflicted
  // one, because several tools may declare this same probe against one shared deployment
  // and `doctor` (no tool argument) runs them concurrently against its RPM limit.
  if (status === 429) {
    return {
      status: 'pass',
      detail: `${probe.service} rate-limited this probe (HTTP 429) — which still proves the call cleared the IP allowlist and authenticated`,
    };
  }
  if (probe.isNetworkDenial(status, text)) {
    return {
      status: 'fail',
      detail: `${probe.service} refused this network — HTTP 403 "Access denied due to Virtual Network/Firewall rules." The credential is fine; the egress IP is not on the resource allowlist, so every call this tool makes will fail`,
      fix: { description: probe.fix },
    };
  }
  if (status === 401) {
    return {
      status: 'fail',
      detail: `${probe.service} rejected the token (HTTP 401) — authenticated as the wrong principal, or with no data-plane role on this resource`,
      fix: {
        description:
          'Run: az login — then confirm this account holds a Cognitive Services OpenAI data-plane role on the resource (it may arrive via a group, not a direct assignment)',
      },
    };
  }
  return {
    status: 'fail',
    detail: `${probe.service} data plane returned HTTP ${status}${text ? `: ${text}` : ''}`,
  };
}

/** Mirror how the tools resolve a credential: env var wins, then a 600-mode key file. */
function resolveKey(ctx, params) {
  if (params.env && process.env[params.env]) {
    return { key: process.env[params.env].trim(), source: `$${params.env}` };
  }
  if (params.key_file) {
    const p = ctx.expand(params.key_file);
    if (existsSync(p)) {
      const key = readFileSync(p, 'utf8').trim();
      if (key) return { key, source: params.key_file };
    }
  }
  return { key: null, source: null };
}

/** SENSIBILITIES #6: metadata only, never values — mask anything token-shaped. */
export function redact(s) {
  return String(s)
    .replace(/(token|key|secret|bearer|password)(\s*[:=]\s*)\S+.*/gi, '$1$2***')
    .replace(/[A-Za-z0-9+/_-]{16,}(\.{3})?/g, '***');
}

/**
 * A private package registry (Artifactory and its kin) sits in front of every install, and it
 * has no anonymous read tier: `/api/system/ping` answers 200 to anyone and proves nothing about
 * a token. The one probe that separates the three states a teammate actually hits is an
 * authenticated GET on a package index: a connect failure is network, 401 is a dead or
 * missing token, 200 is fine. The credential is read from the stores the tools themselves
 * use, in that order, and leaves this process only as a header.
 *
 * The host is the manifest's to declare (`host`), because it is the one thing that differs
 * per organization; the path defaults to the Artifactory pypi-virtual metadata read, which is
 * small, cached, and has no install side effect.
 */
export const REGISTRY_DEFAULT_PATH = '/artifactory/api/pypi/pypi/simple/pip/';

/** Where the token came from — never the token itself leaves this function except to the caller. */
export function artifactoryCredential(home, env = process.env, host = null) {
  if (env.ARTIFACTORY_TOKEN?.trim()) return { token: env.ARTIFACTORY_TOKEN.trim(), source: '$ARTIFACTORY_TOKEN' };
  if (env.POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD?.trim()) return { token: env.POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD.trim(), source: '$POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD' };
  if (host) {
    try {
      const npmrc = readFileSync(`${home}/.npmrc`, 'utf8');
      const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`${esc}\\/[^\\n]*:_authToken\\s*=\\s*(\\S+)`).exec(npmrc);
      if (m && !/^\$\{?[A-Z_]+\}?$/.test(m[1])) {
        const mode = (statSync(`${home}/.npmrc`).mode & 0o777).toString(8);
        return { token: m[1], source: '~/.npmrc', loose: mode !== '600' ? mode : null };
      }
    } catch { /* no ~/.npmrc */ }
  }
  return { token: null, source: null };
}

/**
 * Pure, so the three verdicts can be tested without a network: `status` null means the
 * connection itself failed (`error` carries why).
 */
export function classifyArtifactory({ status, error }, cred, host) {
  if (status === null || status === undefined) {
    return {
      status: 'fail',
      detail: `${host} unreachable (${error ?? 'connect failed'}) — network, not credentials: a private registry usually lives behind your corporate VPN / zero-trust client`,
      fix: { description: 'Connect your corporate VPN / zero-trust client, then retry. Installed tools keep working; only installs and re-locks need this.' },
    };
  }
  if (!cred.token) {
    return {
      status: status === 401 ? 'fail' : 'warn',
      detail: `${host} answers (HTTP ${status}) but no identity token is configured in any store this machine's tools read ($ARTIFACTORY_TOKEN, $POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD, ~/.npmrc)`,
      fix: { description: 'Generate an identity token from your registry profile (Artifactory: Edit Profile → Generate Identity Token; shown once); store it in the keychain or a 600-mode file outside the tree — never in the tree, never pasted into a chat.' },
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: 'fail',
      detail: `${host} rejected the token from ${cred.source} (HTTP ${status}) — expired or revoked; every npm ci / poetry install will fail with misleading errors (E401, "no wheels")`,
      fix: { description: 'Generate a new identity token from your registry profile and update every store that holds the old one. Identity tokens often cannot be revoked individually — if the old one leaked, that is an account reset.' },
    };
  }
  if (status >= 200 && status < 300) {
    const loose = cred.loose ? ` — ~/.npmrc is mode ${cred.loose}; chmod 600 ~/.npmrc` : '';
    return { status: cred.loose ? 'warn' : 'pass', detail: `authenticated index read OK (HTTP ${status}) with the token from ${cred.source}${loose}` };
  }
  return { status: 'warn', detail: `${host} answered HTTP ${status} to an authenticated index read — not a known state; check the registry's status page before blaming the token` };
}

export const checks = {
  'auth.file_cache': {
    title: 'auth cache file',
    category: 'auth',
    impl: {
      darwin: async (ctx, params) => {
        const p = ctx.expand(params.path);
        if (!existsSync(p)) {
          return { status: 'fail', detail: `${params.path} missing (never authenticated, or logged out)` };
        }
        const st = statSync(p);
        const age = ageHours(st.mtime);
        const mode = (st.mode & 0o777).toString(8);
        const ageStr = age < 1 ? `${Math.round(age * 60)}m` : age < 48 ? `${age.toFixed(1)}h` : `${Math.round(age / 24)}d`;
        const loose = st.isFile() && (st.mode & 0o077) !== 0;
        const modeNote = loose ? ' — consider chmod 600' : '';
        const soften = (status) => (loose && status === 'pass' ? 'warn' : status);

        // Prefer the credential's own recorded expiry over mtime, always. mtime answers
        // "when was this file written", which is a different question from "is this token
        // still good" — and answering the easy one in the voice of the hard one is how a
        // doctor reports green over a dead credential.
        if (params.expiry_field) {
          let recorded;
          try {
            recorded = JSON.parse(readFileSync(p, 'utf8'))?.[params.expiry_field];
          } catch {
            recorded = undefined; // not JSON; surfaced below rather than silently ignored
          }
          const expiry = parseExpiry(recorded);
          if (!expiry) {
            // Declared but unreadable means the manifest and the cache format have drifted.
            // Say so. Falling back to mtime here would quietly restore the old blind spot.
            return {
              status: 'warn',
              detail: `${params.path} (written ${ageStr} ago, mode ${mode}) — no readable "${params.expiry_field}" in the cache, so expiry is unknown${modeNote}`,
            };
          }
          const left = (expiry.getTime() - Date.now()) / 1_000;
          if (left > EXPIRY_BUFFER_SECONDS) {
            return {
              status: soften('pass'),
              detail: `${params.path} valid ${humanDuration(left)} more (recorded ${params.expiry_field}, mode ${mode})${modeNote}`,
            };
          }
          const when = left < 0 ? `expired ${humanDuration(left)} ago` : `expires inside the ${EXPIRY_BUFFER_SECONDS / 60}m refresh buffer`;
          // A spent *access* token is routine where a refresh grant renews it with no human.
          // Reporting that as a problem trains people to ignore this check, so the manifest
          // declares it refreshable and the live-read check carries the real verdict.
          if (params.refreshable) {
            return {
              status: soften('pass'),
              detail: `${params.path} ${when} — renewed by a refresh-token grant with no human; a live read is what proves the chain (mode ${mode})${modeNote}`,
            };
          }
          return { status: 'fail', detail: `${params.path} ${when} (recorded ${params.expiry_field} ${expiry.toISOString()})` };
        }

        if (params.max_age_hours && age > params.max_age_hours) {
          return { status: 'fail', detail: `${params.path} is ${ageStr} old (max ${params.max_age_hours}h) — likely expired` };
        }
        // A rotating credential is rewritten on every grant, but its lifetime runs from the
        // original interactive sign-in and rotation does not extend it. So mtime age is a
        // FLOOR on the true age, never proof of life: a file rewritten an hour ago can hold a
        // token that died hours earlier.
        if (params.rotates) {
          return {
            status: soften('pass'),
            detail: `${params.path} (rewritten ${ageStr} ago, mode ${mode}) — rotation rewrites this file without extending its lifetime, so the age is a floor, not proof; only a live mint settles it${modeNote}`,
          };
        }
        return {
          status: soften('pass'),
          detail: `${params.path} (age ${ageStr}, mode ${mode})${modeNote}`,
        };
      },
      win32: null,
    },
  },

  'auth.proxy_status': {
    title: 'auth proxy status',
    category: 'auth',
    impl: {
      darwin: async (ctx, params) => {
        const r = await execShell(ctx.expand(params.command), { timeout: 20_000 });
        const firstLine = redact((r.stdout || r.stderr).trim().split('\n')[0] ?? '');
        const ok = r.code === 0 && (!params.expect || new RegExp(params.expect, 'i').test(r.stdout + r.stderr));
        return ok
          ? { status: 'pass', detail: firstLine || 'status OK' }
          : { status: 'fail', detail: firstLine || `exit ${r.code}` };
      },
      win32: null,
    },
  },

  'auth.live_token': {
    title: 'live token grant',
    category: 'auth',
    impl: {
      darwin: async (ctx, params) => {
        const probe = TOKEN_PROBES[params.provider];
        if (!probe) {
          return {
            status: 'fail',
            detail: `unknown provider "${params.provider}" — expected one of ${Object.keys(TOKEN_PROBES).join(', ')}`,
          };
        }
        if (probe.needs_scope && !params.scope) {
          return { status: 'fail', detail: `provider "${params.provider}" requires a "scope"` };
        }
        const r = await execShell(probe.command(params.scope), { timeout: 60_000 });
        const target = params.scope ? ` for ${params.scope}` : '';
        if (r.code !== 0) {
          // az can answer with a full Python traceback, so take its ERROR: line rather
          // than the first or last line of the dump.
          const lines = (r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
          const why = maskTokenish(lines.find((l) => l.startsWith('ERROR:')) ?? lines[0] ?? '').slice(0, 300);
          return {
            status: 'fail',
            detail: `${probe.cli} could not mint a token${target} — the grant is dead, not just uncached${why ? `: ${why}` : ` (exit ${r.code})`}`,
            fix: { description: probe.fix },
          };
        }
        // Never echo the token or anything derived from it — the probe redirects it, and
        // this line stays metadata-only regardless (SENSIBILITIES #6).
        return { status: 'pass', detail: `${probe.cli} minted a token${target}` };
      },
      win32: null,
    },
  },

  'auth.key_accepted': {
    title: 'credential accepted by service',
    category: 'auth',
    impl: {
      darwin: async (ctx, params) => {
        const probe = KEY_PROBES[params.provider];
        if (!probe) {
          return {
            status: 'fail',
            detail: `unknown provider "${params.provider}" — expected one of ${Object.keys(KEY_PROBES).join(', ')}`,
          };
        }
        const { key, source } = resolveKey(ctx, params);
        // No credential at all is auth.file_cache / files.env_set territory; this check
        // only answers whether a credential that *is* present actually works.
        if (!key) return { status: 'skip', detail: 'no credential present to validate' };

        let res;
        try {
          res = await fetch(probe.url, { ...probe.request(key), signal: AbortSignal.timeout(20_000) });
        } catch (e) {
          return {
            status: 'warn',
            detail: `could not reach ${probe.service} to validate the credential from ${source}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`,
          };
        }
        let body = null;
        try {
          body = await res.json();
        } catch {
          // non-JSON body (proxy interstitial, HTML error page) — accepted() will reject it
        }
        if (!probe.accepted(res.status, body)) {
          const why = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
          return {
            status: 'fail',
            detail: `${probe.service} rejected the credential from ${source} — it is present but not valid: ${maskTokenish(String(why)).slice(0, 200)}`,
            fix: { description: probe.fix },
          };
        }
        return { status: 'pass', detail: `${probe.service} accepted the credential from ${source}` };
      },
      win32: null,
    },
  },

  'auth.data_plane_accepted': {
    title: 'data plane reachable and authorized',
    category: 'auth',
    impl: {
      darwin: async (ctx, params) => {
        const probe = DATA_PLANE_PROBES[params.provider];
        if (!probe) {
          return {
            status: 'fail',
            detail: `unknown provider "${params.provider}" — expected one of ${Object.keys(DATA_PLANE_PROBES).join(', ')}`,
          };
        }
        if (!params.endpoint) {
          return { status: 'fail', detail: `provider "${params.provider}" requires an "endpoint"` };
        }

        // The token is read into this process and never leaves it: never logged, never
        // interpolated into a detail, and every detail below is masked regardless
        // (SENSIBILITIES #6).
        const t = await execShell(probe.token(probe.scope), { timeout: 60_000 });
        if (t.code !== 0) {
          // auth.live_token carries the "is the grant alive" verdict; this check should
          // not restate it as a data-plane failure.
          return {
            status: 'skip',
            detail: `no ${probe.service} token could be minted, so the data plane could not be tested — see the live token check`,
          };
        }
        const token = t.stdout.trim();
        if (!token) {
          return { status: 'skip', detail: 'az returned an empty token; data plane not tested' };
        }

        const url = `${String(params.endpoint).replace(/\/+$/, '')}/${probe.path}`;
        let res;
        try {
          res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(20_000),
          });
        } catch (e) {
          return {
            status: 'fail',
            detail: `could not reach the ${probe.service} data plane at ${params.endpoint}: ${
              e.name === 'TimeoutError' ? 'timed out' : maskTokenish(e.message)
            }`,
          };
        }

        const text = res.ok ? '' : maskTokenish((await res.text().catch(() => '')).slice(0, 400));
        return classifyDataPlane(probe, res.status, text);
      },
      win32: null,
    },
  },

  'cli.authed': {
    title: 'CLI authenticated',
    category: 'auth',
    impl: {
      darwin: async (ctx, params) => {
        const r = await execShell(ctx.expand(params.command), { timeout: 20_000 });
        if (r.code !== 0) {
          return { status: 'fail', detail: `\`${params.command}\` exited ${r.code}${r.error ? ` (${r.error})` : ''}` };
        }
        if (params.expect && !(r.stdout + r.stderr).includes(params.expect)) {
          return { status: 'fail', detail: `\`${params.command}\` output did not match "${params.expect}"` };
        }
        // Deliberately do not echo command output — it may contain account details.
        return { status: 'pass', detail: `\`${params.command}\` OK${params.expect ? ` (matched "${params.expect}")` : ''}` };
      },
      win32: null,
    },
  },

  'auth.artifactory': {
    title: 'private registry identity token',
    category: 'auth',
    impl: {
      darwin: async (ctx, params = {}) => {
        const host = typeof params.host === 'string' ? params.host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
        if (!host) {
          // No host means nothing to probe. A skip, not a fail: the belt cannot guess an
          // organization's registry, and a red here would train people to ignore the check.
          return { status: 'skip', detail: 'inconclusive — auth.artifactory needs a "host" (e.g. "registry.example.com"); none declared in the manifest' };
        }
        const probePath = params.path ?? REGISTRY_DEFAULT_PATH;
        const cred = artifactoryCredential(ctx.home, process.env, host);
        const headers = { Accept: 'text/html, application/json' };
        if (cred.token) headers.Authorization = `Bearer ${cred.token}`;
        let probe;
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 10_000);
          const res = await fetch(`https://${host}${probePath}`, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
          clearTimeout(t);
          probe = { status: res.status };
        } catch (e) {
          probe = { status: null, error: maskTokenish(e?.cause?.code ?? e?.name ?? e?.message ?? 'connect failed') };
        }
        return classifyArtifactory(probe, cred, host);
      },
      win32: null,
    },
  },
};
