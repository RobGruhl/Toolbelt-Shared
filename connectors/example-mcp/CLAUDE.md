# example-mcp — the agent contract

A template for a connector: a hosted MCP server that runs somewhere else. This directory holds
**no code** — `toolbelt.json` (registration, tiers, doctor lines) and this file. Copy the
directory, rename it and its `name`, replace the placeholder URL, list the server's real tools
under `verbs[]`, and rewrite this contract for the real system.

## Read first

- **What:** `<Your hosted MCP>`, reached through its own MCP endpoint. The belt wraps nothing; it
  names the auth path, the registration, the tiers, and the traps.
- **Auth:** the server's own OAuth or device flow, driven by the MCP client when the server is
  first used. The server applies the operator's own identity to every call; the belt holds no
  credential and caches nothing.
- **First read:** `bin/toolbelt register example-mcp` — prints the registration snippet without
  writing it. Once registered and authenticated, the tools appear in-session as
  `mcp__example-mcp__<tool>`.
- **Writes:** the server's write tools run under the operator's grant with no belt gate; see
  "What you still own" for the contract that stands in for one.
- **Live here?** `bin/toolbelt doctor example-mcp --json` — registered on this machine, and is the
  endpoint answering?

## No business logic lives here

The safety lives in the hosted service: its authentication, its authorization, its audit log,
its rate limits. Nothing in this directory can make the server do more or less than the operator
is allowed to do in the vendor's own UI. That is also why a connector cannot claim a terminal
gate — `repo-integrity` fails any connector whose `safeguards[]` or `verbs[]` claims a `tty` /
`typed-echo` gate, because there is no code here to enforce one.

## What you still own

Three things are the belt's, and they are what this directory is for.

**Registration.** `mcp.server_name` and `mcp.registration` are exactly what `toolbelt register`
merges into `~/.claude.json` (after a timestamped backup, after a typed yes at a terminal;
`--write` refuses to run headless). An `http` server needs `type` and `url`; a `stdio` server
needs `type`, `command`, `args`, and optionally `env`, with `{TOOLBELT}` and `~` expanded at
register time. Every registered server's tools are injected into every session — that is the
cost of registering anything, and why `mcp.orphans` on the router skill flags a server no
manifest claims.

**The read-tier permission profile.** `verbs[]` with `surface: mcp` is data the belt acts on:
every `read` verb becomes an `mcp__example-mcp__<name>` allow rule in the profile
`toolbelt setup toolbelt` offers, and every `never` verb becomes a deny rule. List the server's
real tools with their honest tiers. A tool left off the list is neither allowed nor denied — the
client prompts per call, which is the safe default. `docs/RISK.md` renders the result.

**The contract for writes.** A hosted server's write tool is an ungated `write` in this belt's
vocabulary: admissible, named with a note, and surfaced on every doctor run by
`repo-integrity`. The gate is you:

1. Preview: compose the full payload and show it to the human before any call.
2. Ask: get an explicit yes for *that* payload. Never supply the yes yourself.
3. Run once, then **re-read** — a platform's 200 is a claim, not proof.
4. Anything irreversible at the service (`delete_item` in the template) is tiered `never`: denied
   in the profile, done by a human in the vendor's UI.

If the write carries real blast radius and the service offers no staging or approval of its own,
do not widen this connector — vendor a tool for that system instead, where a `/dev/tty` gate and
`toolbelt approve` can exist (`tools/example-write` is the pattern).

## Traps

- **The placeholder URL is fake on purpose.** `https://mcp.example.com/mcp` keeps the doctor's two
  lines at `warn`, not `fail`, so a fresh kit passes while still pointing at the gap. Replace it in
  both `mcp.registration.url` and the `mcp.http_reachable` check.
- **`mcp.http_reachable` proves the host answers, not that the credential works.** 401 and 403
  count as reachable; auth happens in-session. A refused connection usually means your corporate
  VPN/ZTNA client is not connected.
- **`mcp.registered` reads `~/.claude.json`**, so it is `fail` (downgraded to `warn` here) until the
  operator runs `register --write`. Restart the client after registering.
