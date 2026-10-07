// mcp.mjs — MCP registration and liveness checks.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnChild, expandPath } from '../platform.mjs';
import { maskTokenish, NETWORK_PATH_HINT } from './auth.mjs';

/**
 * A handshake proves the server starts. It does not prove the credential behind the server
 * is alive — every token cache on disk still reads "present" the moment after it dies, so a
 * tool can answer tools/list perfectly while every actual call 401s. Only issuing a real
 * read settles it.
 *
 * The probes live here rather than in a manifest on purpose, exactly as TOKEN_PROBES does in
 * auth.mjs: each names one cheap READ tool, so no manifest can point this at a mutation and
 * have the doctor send mail or write a calendar event on every run.
 */
const MCP_READ_PROBES = {
  // '<manifest name>': {
  //   tool: 'list_items',                    // one cheap READ tool the server exposes
  //   args: () => ({ limit: 1 }),            // the smallest honest call; dates computed at call time
  //   proves: 'the token chain end to end (cached token → refresh → the live service)',
  // },
};

/** Pin a read probe for a manifest name at runtime — for tests, or a belt extension that keeps its probes beside its tool. */
export function registerReadProbe(name, probe) {
  MCP_READ_PROBES[name] = probe;
}

function readClaudeConfig(home) {
  const file = path.join(home, '.claude.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read one tool result without ever putting its payload in the report. A calendar or mail
 * read is PII by definition, so only the pass/fail verdict and a masked error string leave
 * this function (SENSIBILITIES #6).
 *
 * Both failure shapes have to be read: MCP marks protocol errors with `isError`, but this
 * server also answers a well-formed result whose *content* is `{"ok": false, "error": …}` —
 * checking only `isError` would green a call that plainly failed.
 */
function readToolVerdict(msg) {
  if (msg.error) return { ok: false, why: msg.error.message ?? 'tools/call returned an error' };
  const result = msg.result ?? {};
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON — isError still applies */ }
  if (result.isError || parsed?.ok === false || parsed?.error) {
    return { ok: false, why: String(parsed?.error ?? parsed?.message ?? 'the tool reported an error') };
  }
  return { ok: true };
}

/**
 * Speak just enough JSON-RPC to prove an MCP stdio server is alive:
 * initialize -> initialized -> tools/list, expect a tools array. With `call`, go one step
 * further and issue that tools/call, which is what proves the credential rather than the
 * process.
 */
function stdioHandshake(cmd, args, { cwd, env, timeout = 20_000, call = null }) {
  return new Promise((resolve) => {
    const child = spawnChild(cmd, args, { cwd, env });
    let buf = '';
    let stderrTail = '';
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, detail: `no tools/list response within ${timeout / 1000}s${stderrTail ? ` — stderr: ${stderrTail.trim().split('\n').pop()}` : ''}` }),
      timeout,
    );

    child.on('error', (e) => finish({ ok: false, detail: `spawn failed: ${e.message}` }));
    child.on('exit', (code) => finish({ ok: false, detail: `server exited early (code ${code})${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''}` }));
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          // initialized; ack then list tools
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (msg.id === 2) {
          if (!msg.result?.tools) {
            finish({ ok: false, detail: `tools/list error: ${msg.error?.message ?? 'no tools in result'}` });
          } else if (!call) {
            finish({ ok: true, detail: `handshake OK — ${msg.result.tools.length} tools` });
          } else if (!msg.result.tools.some((t) => t.name === call.name)) {
            // The probe names a tool in code; if the server no longer has it, that is drift
            // to report, not a call to attempt blind.
            finish({ ok: false, detail: `server has no tool "${call.name}" — probe and server have drifted` });
          } else {
            child.stdin.write(
              JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: call.name, arguments: call.arguments } }) + '\n',
            );
          }
        } else if (msg.id === 3) {
          const verdict = readToolVerdict(msg);
          finish(
            verdict.ok
              ? { ok: true, detail: `${call.name} returned live data` }
              : { ok: false, detail: `${call.name} failed: ${maskTokenish(verdict.why).slice(0, 300)}` },
          );
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'toolbelt-doctor', version: '1.0.0' },
        },
      }) + '\n',
    );
  });
}

/**
 * Resolve the stdio server a manifest declares, the same way for every check that speaks to
 * one. ctx.expand runs over env values too, not just command/args — a verbatim "~/.cache/x"
 * reaches the server as a relative path and mkdir()s a literal ~/ directory inside the tool dir.
 */
function resolveStdioServer(ctx) {
  const reg = ctx.manifest.mcp?.registration;
  let cmd, args;
  if (reg?.type === 'stdio') {
    cmd = ctx.expand(reg.command);
    args = (reg.args ?? []).map((a) => ctx.expand(a));
  } else if (ctx.manifest.entrypoints?.mcp_server) {
    cmd = process.execPath;
    args = [path.join(ctx.toolDir, ctx.manifest.entrypoints.mcp_server)];
  } else {
    return null;
  }
  const env = {};
  for (const e of ctx.manifest.env ?? []) if (e.value !== undefined) env[e.name] = ctx.expand(e.value);
  for (const [k, v] of Object.entries(reg?.env ?? {})) env[k] = ctx.expand(v);
  return { cmd, args, env };
}

export const checks = {
  'mcp.registered': {
    title: 'MCP server registered in ~/.claude.json',
    category: 'mcp',
    impl: {
      darwin: async (ctx, params) => {
        const cfg = readClaudeConfig(ctx.home);
        if (!cfg) return { status: 'fail', detail: '~/.claude.json missing or unparseable' };
        const entry = cfg.mcpServers?.[params.name];
        if (!entry) {
          return {
            status: 'fail',
            detail: `no mcpServers["${params.name}"] entry`,
            fix: { description: 'Register it', command: `{TOOLBELT}/bin/toolbelt register ${ctx.manifest.name} --write` },
          };
        }
        // If the entry points at a local path, make sure it still exists.
        const paths = [entry.command, ...(entry.args ?? [])].filter((a) => typeof a === 'string' && a.startsWith('/'));
        const missing = paths.filter((p) => !existsSync(p));
        if (missing.length) return { status: 'fail', detail: `registered but path missing: ${missing[0]}` };
        const target = entry.type === 'http' ? entry.url : [entry.command, ...(entry.args ?? [])].join(' ');
        return { status: 'pass', detail: `${entry.type ?? 'stdio'}: ${target}` };
      },
      win32: null,
    },
  },

  /**
   * The mirror of mcp.registered: servers in ~/.claude.json that no manifest claims. Every
   * registered server is injected into every session — a retired one costs context on each
   * turn and advertises tools nobody maintains. Belt-wide, so it lives on the router skill's
   * manifest; names that are deliberately not the belt's business go in `ignore`.
   */
  'mcp.orphans': {
    title: 'no orphan MCP registrations',
    category: 'mcp',
    impl: {
      darwin: async (ctx, params) => {
        const cfg = readClaudeConfig(ctx.home);
        if (!cfg) return { status: 'skip', detail: '~/.claude.json missing — nothing registered' };
        const { discover } = await import('../manifest.mjs');
        const { manifests } = discover(ctx.toolbelt);
        const claimed = new Set(manifests.map((m) => m.mcp?.server_name).filter(Boolean));
        const ignore = new Set(params.ignore ?? []);
        const registered = Object.keys(cfg.mcpServers ?? {});
        const orphans = registered.filter((n) => !claimed.has(n) && !ignore.has(n));
        if (!orphans.length) return { status: 'pass', detail: `${registered.length} registered server(s), every one claimed by a manifest` };
        return {
          status: 'fail',
          detail: `registered in ~/.claude.json but claimed by no manifest: ${orphans.join(', ')} — injected into every session, maintained by no one`,
          fix: { description: `Deregister each: claude mcp remove <name>   (or delete the mcpServers entry by hand after a backup)` },
        };
      },
      win32: null,
    },
  },

  'mcp.stdio_handshake': {
    title: 'MCP stdio server answers initialize + tools/list',
    category: 'mcp',
    impl: {
      darwin: async (ctx, params) => {
        const server = resolveStdioServer(ctx);
        if (!server) return { status: 'skip', detail: 'no stdio mcp entrypoint declared' };
        const r = await stdioHandshake(server.cmd, server.args, {
          cwd: ctx.toolDir,
          env: server.env,
          timeout: params.timeout_ms ?? 20_000,
        });
        return r.ok ? { status: 'pass', detail: r.detail } : { status: 'fail', detail: r.detail };
      },
      win32: null,
    },
  },

  'mcp.stdio_read': {
    title: 'MCP server completes a live read (proves the credential, not just the process)',
    category: 'mcp',
    impl: {
      darwin: async (ctx, params) => {
        const probe = MCP_READ_PROBES[ctx.manifest.name];
        if (!probe) {
          return { status: 'skip', detail: `no read probe pinned for "${ctx.manifest.name}" — add one in MCP_READ_PROBES (doctor/lib/checks/mcp.mjs)` };
        }
        const server = resolveStdioServer(ctx);
        if (!server) return { status: 'skip', detail: 'no stdio mcp entrypoint declared' };
        // Longer default than the handshake: this call may spend a refresh-token grant on
        // the way to the API. It cannot block on a human — the server's interactive fallback
        // needs a TTY, and stdin here is a pipe, so a dead grant fails fast.
        const r = await stdioHandshake(server.cmd, server.args, {
          cwd: ctx.toolDir,
          env: server.env,
          timeout: params.timeout_ms ?? 60_000,
          call: { name: probe.tool, arguments: probe.args() },
        });
        return r.ok
          ? { status: 'pass', detail: `${r.detail} — proves ${probe.proves}` }
          : { status: 'fail', detail: r.detail };
      },
      win32: null,
    },
  },

  'mcp.http_reachable': {
    title: 'hosted MCP endpoint reachable',
    category: 'mcp',
    impl: {
      darwin: async (ctx, params) => {
        const url = ctx.expand(params.url);
        const expect = params.expect_status ?? null; // null = any HTTP answer counts
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), params.timeout_ms ?? 10_000);
        try {
          const res = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'manual' });
          // Azure Cognitive Services enforces its IP/VNet allowlist at the front door, before
          // auth, and says so verbatim in the body. That 403 is a network-path verdict, not a
          // permission one, so it can never be healthy — it takes precedence over expect_status.
          // Gated on the body, never on the status: a bare 403 here is far more often a genuine
          // authorization failure, and sending that user to reconnect a VPN is worse than saying nothing.
          if (res.status === 403) {
            const body = (await res.text()).slice(0, 400).toLowerCase();
            if (body.includes('virtual network') && body.includes('firewall')) {
              return { status: 'fail', detail: `${url} answered HTTP 403 — off-allowlist source IP. ${NETWORK_PATH_HINT}` };
            }
          }
          const ok = expect ? expect.includes(res.status) : true;
          return ok
            ? { status: 'pass', detail: `${url} answered HTTP ${res.status}${[401, 403].includes(res.status) ? ' (auth happens in-session — reachable)' : ''}` }
            : { status: 'fail', detail: `${url} answered unexpected HTTP ${res.status}` };
        } catch (e) {
          const reason = e.name === 'AbortError' ? 'timeout' : (e.cause?.code ?? e.message);
          return { status: 'fail', detail: `${url} unreachable (${reason}) — is your corporate VPN / zero-trust client connected?` };
        } finally {
          clearTimeout(timer);
        }
      },
      win32: null,
    },
  },
};

export { stdioHandshake };
