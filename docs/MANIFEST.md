# `toolbelt.json` — Manifest Schema

Every entry in `tools/`, `connectors/`, and `skills/` carries a `toolbelt.json` at its root. The
doctor discovers manifests by glob (`{tools,connectors,skills}/*/toolbelt.json`) — there is no
central registry to keep in sync. JSON (not YAML) so the doctor stays zero-dependency.
Validation lives in `doctor/lib/manifest.mjs`; a manifest that fails it is reported as an error
and excluded from every command, so the message names the file and the field.

The two example tools are the worked instances: `tools/example-readonly/toolbelt.json` (`exr`,
read-only) and `tools/example-write/toolbelt.json` (`exw`, gated writes). Copy the one whose
shape matches.

## Top-level fields

| Field | Type | Req | Meaning |
|---|---|---|---|
| `name` | string | ✓ | Directory name; unique across tools+connectors+skills |
| `aliases` | string[] | – | Extra names every command accepts for this tool (below) |
| `kind` | `"tool" \| "connector" \| "skill"` | ✓ | What this is |
| `description` | string | ✓ | One line, shown by `toolbelt list` |
| `hits` | string | – | What it hits — the README belt-table's second column; `toolbelt readme` fails loudly if missing |
| `surface` | string | – | The surface/safeguards prose — the README belt-table's third column; `toolbelt readme` fails loudly if missing |
| `readme_label` | string | – | Belt-table first-column label when it differs from `<dir>/<name>` (e.g. `` `tools/example-write` (`exw`) ``) |
| `platforms` | string[] | ✓ | Where it can run at all: `"darwin"`, `"win32"` |
| `origin` | object | ✓ | Provenance (below); `{}` for code authored here |
| `runtime` | object | – | Runtime requirements (below) |
| `install` | step[] | – | Ordered steps `toolbelt setup` runs from the tool dir |
| `entrypoints` | object | – | `cli`, `mcp_server`, and/or `approve`. `cli` and `approve` are **shell commands** run from the tool dir (`"node exr.mjs"`, `"poetry run tk"`, `"bin/tk"`) — `cli` by `toolbelt run <tool> -- …` (a bare `.js`/`.mjs` filename is run under `node`), `approve` by `toolbelt approve <tool> <code>` for staged writes (TTY required). `mcp_server` is a relative path to the script `mcp.stdio_*` checks spawn |
| `env` | envvar[] | – | Environment variables the tool reads |
| `auth` | object | – | Human-readable + checkable auth story (below); `auth.principal` is required whenever the block exists |
| `verbs` | verb[] | – | Every verb's tier — `read` / `write-gated` (+ its gate) / `write` (ungated, noted) / `never` (below). The agent-reachable surface as data |
| `risk` | object | ✓ tools, connectors | The reviewer's vocabulary, answered once (below); rendered into `docs/RISK.md` |
| `systems` | system[] | – | The names your organization uses for what this reads, each with its first read verb (below); rendered into `SYSTEMS.md` |
| `core` | boolean | – | Part of the first-week profile `toolbelt doctor --core` runs |
| `safeguards` | string[] | – | Surfaced by `toolbelt list` and the router skill; each gate claim is tested against the code by `repo-integrity` |
| `mcp` | object | – | MCP registration (below); omit for non-MCP tools |
| `checks` | check[] | – | Declarative doctor checks (below) |
| `smoke_test` | object | – | `{command, expect}` run by `doctor <tool> --smoke` from the tool dir, with `env[].value` exported |
| `do_not_vendor` | string[] | – | Documentation of the exclusion set (enforced by `git archive` + the secret gate + `.gitignore`) |

## `aliases` — the other names for a tool

`name` must equal the directory, which sometimes makes it longer or more specific than what
anyone actually types. `aliases` lists the extra spellings that resolve to this manifest, so
`doctor`, `setup`, `register` and `inspire` all accept them uniformly — resolution is one shared
helper (`resolve()` in `doctor/lib/manifest.mjs`), not per-command string matching.

```json
{ "name": "example-readonly", "aliases": ["exr"] }
```

Canonical names always win, and `discover()` reports a manifest error if an alias collides with
a real tool's `name`, repeats its own `name`, or is claimed by two manifests. That guard is the
point: a silently shadowed alias would resolve to a *different tool* than the typist meant, which
is much worse than the "no such tool" it replaces. `toolbelt list` prints aliases under the
description so they're discoverable rather than folklore.

## `origin` — provenance

The belt owns everything in its tree ([VENDORING.md](VENDORING.md)). This block only records
where an entry's code — or, for a connector, the service it configures — came from, so that a
human can glance at the source later with `toolbelt inspire <tool>`. Nothing reads it to decide
what may be edited; everything may.

```jsonc
{
  "repo": "https://github.com/<org>/<tool>.git",
                                  // optional: git URL or local path the code was taken from, or the
                                  // service/CLI a connector wraps. Omit for code authored here.
  "vendored_commit": "8aabb74",   // optional: the snapshot taken — `toolbelt inspire` lists commits after it
  "vendored_at": "2026-01-15",    // optional: when it entered the tree
  "subdir": "tools/hello-cli",    // optional: the subtree it came from, if a monorepo
  "note": "..."                   // optional: anything a reader needs — "no public upstream", access caveats
}
```

The doctor requires the block to exist (an empty object is valid), rejects unknown keys, rejects
`vendored_commit` without `repo`, and rejects a top-level `upstream` block outright — there is no
sync direction to declare.

## `runtime`

```jsonc
{
  "node": ">=18",          // semver range; omit keys that don't apply
  "python": ">=3.13",
  "package_manager": "npm" // "npm" | "poetry" | "none"
}
```

## `install` steps

```jsonc
[
  { "run": "npm install", "description": "Install Node dependencies locally" }
]
```

Steps execute in order, in the tool directory, each TTY-confirmed by `toolbelt setup` (or all
pre-confirmed with `--yes`, which still requires a TTY). A y/N the operator cannot evaluate is a
ritual, not a gate, so every step is introduced with what it does, **why** it exists, and what
**yes** and **no** each mean. Write them on the step — `"why"`, `"yes"`, `"no"` — whenever the
generic text ("runs `<command>` in the tool dir" / "skipped; the doctor keeps reporting it")
would undersell the consequence:

```jsonc
{ "action": "git_config", "key": "core.hooksPath", "value": ".githooks",
  "description": "Turn on the repo's pre-commit secrets gate for this clone",
  "why": "the hook is the only gate between a pasted token and a commit that lives in history forever",
  "yes": "git runs .githooks/pre-commit before every commit in THIS clone; a secret-shaped value is refused and named",
  "no":  "commits are unscanned; nothing else changes; the doctor keeps warning" }
```

Special post-install actions are declared as steps with `"action"` instead of `"run"` (a step
needs one or the other). `{TOOLBELT}` and `~` are expanded in paths.

| action | params | What it does |
|---|---|---|
| `symlink` | `from, to` | creates the link at `from` pointing at `to`. A real file or dir already at `from` is renamed to `<from>.pre-toolbelt`, never deleted; a stale link is replaced; a correct one is left alone |
| `ensure_dir` | `path` | `mkdir -p` |
| `git_config` | `key, value` | `git config <key> <value>` in this clone only |
| `pipx_ensure` | `package, binary?` | `pipx install <package>`, skipped when `binary ?? package` is already on PATH; fails with a brew hint if pipx itself is missing |
| `permissions_offer` | – | prints the read-tier permission profile computed from every manifest's `verbs[]`, then merges its allow/deny rules into `~/.claude/settings.json` only on a typed yes, after a timestamped backup |

```jsonc
{ "action": "symlink", "from": "~/.claude/skills/toolbelt", "to": "{TOOLBELT}/skills/toolbelt",
  "description": "Install the skill where Claude Code discovers it" }
{ "action": "ensure_dir", "path": "~/.config/toolbelt", "description": "Create the token cache dir" }
```

## `env`

```jsonc
// the shape, for a tool <your-tool>; the shipped manifests' real env blocks are in tools/*/toolbelt.json
[
  { "name": "YOURTOOL_BASE_URL", "required": true, "secret": false,
    "description": "Base URL of the service the tool reads" },
  { "name": "YOURTOOL_API_KEY", "required": true, "secret": true,
    "description": "Personal API key; create it in the service's UI, store it in the keychain or a 600-mode file" },
  { "name": "YOURTOOL_CACHE_DIR", "value": "~/.config/toolbelt/<your-tool>", "secret": false,
    "description": "Exported into the smoke test so it runs against the same cache the tool uses" }
]
```

`secret: true` vars are checked for *presence only* — the doctor never reads or prints their
values. `value` is exported (with `~` and `{TOOLBELT}` expanded) when the smoke test runs.

## `auth`

```jsonc
// the shape for a browser-session tool (tools/slack/toolbelt.json is the shipped instance)
{
  "principal": "user",
  "flow": "SSO in the browser; token + cookies cached to a 600-mode file",
  "caches": [
    { "path": "~/.config/toolbelt/<your-tool>-auth.json", "ttl_hours": null, "class": "session", "store": "file",
      "refresh": "Run any read command; a browser window opens for sign-in" },
    { "path": "~/.config/toolbelt/<your-tool>-profile/", "class": "session", "store": "file", "note": "dedicated browser profile dir" }
  ]
}
```

### `auth.principal` — the no-escalation thesis as data

[SENSIBILITIES #13](../SENSIBILITIES.md#13-no-escalation): no belt tool grants a capability the
operator does not already hold. Every manifest with an `auth` block declares whose credential it
runs on, and `tools/repo-integrity` reports the answer on every doctor run.

| Value | Meaning | Doctor |
|---|---|---|
| `"user"` | The operator's own credential, bound to their identity, dies with their account | pass |
| `"none"` | The entry holds no credential (static site, local computation, a contained default) | pass — fails if the manifest also declares secret env vars or caches |
| `"service"` | A credential that is **not** the operator's own (client-credentials grant, project API key, workspace token). Requires `principal_exception`: why, and what bounds it | **warn, named, every run** — an exception is honest; a silent one is a failing review |

```jsonc
"auth": {
  "principal": "user",
  "flow": "cloud CLI Application Default Credentials; no tool-local credentials",
  "login": "gcloud auth application-default login",   // optional: the command that starts the human flow
  "rearm": "…",                                        // optional: re-arms with no human (a refresh grant); toolbelt auth runs it first
  "identity": "gcloud config get-value account",      // optional: prints who the credential is (no secret) — toolbelt auth snapshots it before and after
  "federates_from": "example-readonly",               // optional: the entry whose credential this borrows; its re-auth re-arms this one
  "caches": [
    { "path": "~/.config/gcloud/application_default_credentials.json",
      "class": "derived",        // derived | static | borrowed | session  (SENSIBILITIES #6 table)
      "store": "vendor",         // file | keychain | vendor | env
      "revoke": "gcloud auth application-default revoke",
      "refresh": "gcloud auth application-default login" }
  ]
}
```

`class` sets the rule the doctor applies: a `derived` 600-mode file outside the tree is a pass,
never a warning; `static` secrets belong in the keychain; `borrowed` caches are read by one key;
`session` directories are secrets even though no standard names them. `login`, `rearm`,
`identity` and `federates_from` must be strings when present.

## `verbs`

```jsonc
"verbs": [
  { "name": "get",    "tier": "read" },
  { "name": "post",   "tier": "write-gated", "gate": "tty",  "note": "reversible: a post can be deleted" },
  { "name": "delete", "tier": "write-gated", "gate": "typed-echo", "note": "irreversible: type the id back, no --yes" },
  { "name": "admin",  "tier": "never", "surface": "mcp", "note": "exists in the SDK; the belt exposes no path to it" }
]
```

`surface` — `cli` | `mcp` | `both` — says which door the verb is behind, and is required on every
verb of an entry that registers an MCP server: the offered permission profile
(`toolbelt setup toolbelt`) projects `mcp`/`both` verbs into `mcp__<server>__<name>` allow/deny
rules, and a CLI verb's name is not a tool name (an `mcp`/`both` verb's name must therefore be a
single token: letters, digits, `_ . -`). A verb name may appear once.

| Tier | Meaning |
|---|---|
| `read` | Free to call. Includes verbs that write only a local file the operator asked for |
| `write-gated` | Mutates something beyond the operator's own machine, or something paid. Names its `gate`: `tty` (`/dev/tty`, no bypass), `typed-echo` (`/dev/tty` plus typing the target's name back; no `--yes`; a `--force` that skips the word is honored only where `/dev/tty` opens), `flag` (a loud `--yes`/`--force`, always honored, for reversible or paid-but-private actions), `containment` (a throwaway profile or named destination, widened only by a flag) |
| `write` | Mutates, and the belt's code puts **no gate** in front of it. The honest tier for a private, free, reversible write that runs at once and prints its undo (`exw note add`), and for any write whose gate is not built yet. Admissible only with a `note` (what bounds it, why no gate); `tools/repo-integrity` warns on every one, every run. Honest data beats a `flag` claim the code does not back |
| `never` | Exists on the underlying platform or SDK; the belt exposes no path to it |

`gate` is only valid on `write-gated`. The tiers are a projection, not prose: a future
deployed-agent subset is `tier == "read"`, and `safeguards-honesty` tests a `tty`/`typed-echo`
claim against the code.

## `risk`

```jsonc
"risk": {
  "read_only": true,        // no verb mutates anything beyond the operator's machine
  "destructive": false,     // some reachable verb (read, write, write-gated) can destroy data or state that cannot be recovered; a `never` verb has no path and does not count
  "idempotent": true,       // repeating a call changes nothing further
  "open_world": false,      // reaches arbitrary hosts/URLs the operator names (a browser, a fetcher), not one fixed service
  "worst_case": "a read that returns more rows than the operator wanted, capped at the in-code ceiling"
}
```

Required on tools and connectors; skills orchestrate and carry no risk of their own. All four
booleans and the one-line `worst_case` are required. `read_only: true` with a `write-gated` or
`write` verb is a manifest error, as is `read_only` and `destructive` both true.
`toolbelt risk --write` renders every block into [RISK.md](RISK.md); `repo-integrity` fails on
drift, so the table a reviewer reads is never stale.

## `systems`

```jsonc
"systems": [
  { "name": "Example Service", "read": "poetry run exr get --limit 1", "preferred": true }
]
```

The names are the ones your organization uses when it talks about the system — what a teammate
would type, not the vendor's product name if those differ. `read` is the first read verb exactly
as typed from the tool directory. `preferred: true` marks the one headless path when two entries
reach the same system (a CLI over a UI-shaped connector, say). `toolbelt systems --write` renders
[`SYSTEMS.md`](../SYSTEMS.md) — one row per system → tool → first read → doctor id — the front
door for an agent that knows which system it needs.

## `mcp`

```jsonc
// tools/slack/toolbelt.json registers a stdio server this way; connectors/example-mcp/toolbelt.json shows "http"
{
  "server_name": "<your-tool>",
  "registration": {
    "type": "stdio",                                    // or "http" with "url"
    "command": "node",
    "args": ["{TOOLBELT}/tools/<your-tool>/server.mjs"]   // {TOOLBELT} expanded at register time
  }
}
```

`toolbelt register <name>` renders this with `{TOOLBELT}` expanded to the repo root. Default
prints; `--write` merges into `~/.claude.json` after a timestamped backup.

## `checks`

Each entry instantiates a built-in check (see `doctor/lib/checks/`) with parameters:

```jsonc
[
  { "use": "runtime.node", "min": "18" },
  { "use": "deps.npm_installed" },
  { "use": "files.env_set", "name": "EXR_API_KEY", "key_file": "~/.config/toolbelt/exr.key" },
  { "use": "auth.file_cache", "path": "~/.config/toolbelt/exr-auth.json",
    "expiry_field": "expires_at", "refreshable": true,
    "severity": "warn",
    "fix": "Run: {TOOLBELT}/tools/example-readonly/exr get --limit 1 — the browser opens for sign-in" },
  { "use": "mcp.registered", "name": "example-readonly" },
  { "use": "mcp.stdio_handshake", "timeout_ms": 20000, "severity": "warn" },
  { "use": "custom", "script": "checks/special.mjs" }   // escape hatch: prints one JSON result to stdout
]
```

- Every entry needs `use`; an id the registry does not know fails as "doctor and manifest out
  of sync" rather than skipping.
- `severity` downgrades a `fail` to `warn` (e.g. a stale auth cache is a warn; a missing runtime
  is a fail).
- `fix` overrides the check's default remediation text. `{TOOLBELT}` is expanded.
- `label` overrides the check's title in the report, so a generic check can say what it actually
  proves — `cli.authed` on a cloud CLI's `account show` is a cached-profile read, and labelling
  it as such keeps it from reading as a live-auth green.
- Check results: `pass | warn | fail | skip` + `detail` + optional `fix {description, command}`.
- Platform-aware: a check with no implementation for the current OS returns `skip` flagged
  `unimplemented`, and the run exits 4 (inconclusive) rather than 0 — the doctor learned
  nothing and must not read as clean. An entry whose `platforms` excludes the current OS skips
  cleanly instead. Every built-in below is implemented on darwin; win32 is not yet.
- A check that throws is reported as `fail: check crashed`, never swallowed.

## Built-in check library

| id | params | What it verifies (darwin) |
|---|---|---|
| `system.chrome` | – | Google Chrome present (standard app paths, `CHROME_PATH`) |
| `system.brew` | – | Homebrew installed |
| `system.git` | – | git installed |
| `system.ffmpeg` | – | ffmpeg and ffprobe installed |
| `system.clone_fresh` | `behind_max?` | clone is current with `origin/main`. Skips with no origin remote; warns if the fetch fails (staleness unknown) or if behind at all; fails past `behind_max` (default 20) — gate fixes on main are not on this machine |
| `runtime.node` | `min` | the Node running the doctor satisfies `min` (the doctor and the tools share one interpreter) |
| `runtime.python` | `min` | a python3 (PATH or `/opt/homebrew/opt/python@3.*`) satisfies |
| `runtime.poetry` | – | poetry available (pipx) |
| `runtime.pipx` | – | pipx available |
| `runtime.pipx_app` | `package, binary?` | `binary ?? package` on PATH; fix is `pipx install <package>` |
| `deps.npm_installed` | – | `node_modules/` exists, `npm ls --omit=dev` clean |
| `deps.poetry_env_ready` | `dir?` | in-project `.venv` exists with a working interpreter. Presence, not readiness — a `python -m venv` with nothing installed passes, so pair it with `deps.python_import` |
| `deps.python_import` | `module, dir?` | module imports in the tool venv — this is what proves `poetry install` actually ran |
| `auth.file_cache` | `path, max_age_hours?, expiry_field?, refreshable?, rotates?` | cache exists; mode; metadata only. **Prefer `expiry_field`** (the JSON key holding the cache's own expiry, epoch seconds or ISO-8601) — mtime answers "when was this written", not "is this alive". Add `refreshable` where a spent token is renewed by a refresh grant with no human, so the routine case stays green. Add `rotates` where the file is rewritten per grant without extending its lifetime: the age is then a floor, not proof, and only a live call settles it |
| `auth.proxy_status` | `command, expect?` | a proxy `… status` command exits 0 (and matches the `expect` regex) — for a ZTNA/VPN client whose CLI reports its tunnel state |
| `auth.live_token` | `provider, scope?` | the grant actually mints a token (`azure` needs a scope; `gcp-adc` does not). Use this, not a cached-profile read, as a tool's real auth check. The command per provider is pinned in `TOKEN_PROBES` (`doctor/lib/checks/auth.mjs`) in a form that cannot spill the token to stdout |
| `auth.key_accepted` | `provider, env?, key_file?` | the service accepts the credential (`newrelic`, `typesafe`). Skips when none is present — pair it with `files.env_set`, which owns "is a key there at all". The key travels in a header, never on argv; add a provider in `KEY_PROBES` |
| `auth.data_plane_accepted` | `provider, endpoint` | an **authenticated** read on the service's data plane succeeds (`azure-openai`). The layer `mcp.http_reachable` cannot vouch for: it proves the IP allowlist and the data-plane role, not merely that the host answers. The probe path and token command are pinned per provider in `DATA_PLANE_PROBES` (`doctor/lib/checks/auth.mjs`), never named by a manifest, so a manifest can't re-point it at the root and restore a false green. 429 is a **pass** — reaching the rate limiter proves the call cleared both the ACL and auth. Skips when no token can be minted; `auth.live_token` owns that verdict |
| `auth.artifactory` | `host` | your private package registry (JFrog Artifactory) accepts the identity token: an authenticated GET on its pypi index, bearer header only, token never printed. `host` is required — the registry hostname (a scheme prefix and trailing slash are stripped); the check fails naming the param when it is missing. The token is read from `$ARTIFACTORY_TOKEN`, then `$POETRY_HTTP_BASIC_ARTIFACTORY_PASSWORD`, then the `_authToken` line for that host in `~/.npmrc` (warns if that file is not mode 600). Connect failure → network (the registry is behind your VPN/ZTNA); 401/403 → dead or missing token; `/api/system/ping` answers 200 to anyone and proves nothing, which is why the probe is an index read |
| `cli.authed` | `command, expect?` | e.g. `gh auth status` exits 0 and its output contains `expect`; values masked |
| `mcp.registered` | `name` | entry in `~/.claude.json` mcpServers; command path exists |
| `mcp.stdio_handshake` | `timeout_ms?` | spawn `entrypoints.mcp_server`, JSON-RPC initialize + tools/list. Proves the process starts, **not** that its credential works — a server answers this perfectly over a dead token |
| `mcp.stdio_read` | `timeout_ms?` | same handshake, then `tools/call` one cheap **read** tool — the check that can see a dead credential. The tool and args are pinned per manifest name in `MCP_READ_PROBES` (`doctor/lib/checks/mcp.mjs`), never named by a manifest, so this can't be pointed at a mutation. Payloads are PII: only the verdict is reported. Skips where no probe is pinned — add one for your server there |
| `mcp.http_reachable` | `url, expect_status?` | host answers (200/401/403 all count). One exception, ahead of `expect_status`: a 403 whose body carries Azure's Virtual-Network/Firewall signature is a **fail** — that is an IP allowlist rejecting an off-tunnel source IP, which is never "reachable". Body-gated, because a bare 403 from those endpoints is more often a missing role |
| `mcp.orphans` | `ignore?` | every `mcpServers` entry in `~/.claude.json` is claimed by some manifest's `mcp.server_name` — an unclaimed server is injected into every session and maintained by no one; `ignore` names servers that are deliberately not the belt's business |
| `files.exists` | `path` or `paths: [canonical, legacy]`, `fix?` | file present (e.g. a config the tool needs and the tree deliberately excludes). With `paths`, the first existing wins and a legacy hit is a warn labelled as the deprecated fallback |
| `files.symlink_valid` | `path, target?` | symlink resolves (and points at `target` when given) — the `~/.claude/skills/<name>` link each skill installs |
| `files.env_set` | `name, key_file?` or `key_files: [canonical, legacy]` | credential present: env var, else a 600-mode key file (presence only — a blank value or empty key file counts as absent, not present). With `key_files`, the first existing wins and a legacy hit is a warn labelled as the deprecated fallback |
| `files.fresh` | `path, max_age_hours?` | file mtime is within the window (default 336 h = 14 days) |
| `files.git_config` | `key, expect?` | `git config <key>` is set in this clone (and equals `expect` when given) |
| `files.dir_writable` | `path` | directory exists and is writable |
| `secrets.rc_clean` | – | shell rc files export no secret literals |
| `secrets.env_clean` | `allow?` | the process environment carries no secret-shaped variables (every subprocess and agent tool call inherits them); `allow` names the exceptions |
| `secrets.no_tree_secrets` | – | credential files inside the tree are gitignored and mode 600 |
| `secrets.keychain_item` | `service` or `services: [canonical, alternate…]`, `account?` | Keychain item present under the first listed name found — presence only, no `-w`, so the secret never leaves the Keychain |
| `custom` | `script` | run `script` (relative to the tool dir) from the tool dir; parse the single JSON result object it prints — `{status, detail, fix?}` |

The probe tables (`TOKEN_PROBES`, `KEY_PROBES`, `DATA_PLANE_PROBES`, `MCP_READ_PROBES`) are
code, not manifest data, on purpose: each pins a command or a call that cannot leak a token or
perform a mutation, and a manifest is not allowed to weaken that. Adding a provider or a server
means adding an entry there and a row here.
