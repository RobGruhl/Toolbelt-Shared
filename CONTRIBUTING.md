# Contributing

A tool earns a directory under `tools/` only if it honors [SENSIBILITIES.md](SENSIBILITIES.md)
— the 13 patterns are the acceptance bar, not aspirations. This file is the *process*; the
philosophy ([SENSIBILITIES.md](SENSIBILITIES.md)), the schema ([docs/MANIFEST.md](docs/MANIFEST.md)),
and the vendoring mechanics ([docs/VENDORING.md](docs/VENDORING.md)) live elsewhere and are
not restated here — this is the checklist that routes into them.

## Adding a tool

0. **Start from the sketch.** If the system has a dossier under [sketches/](sketches/)
   ([sketches/README.md](sketches/README.md) indexes them with a verdict), it is the design
   brief: the documented surface and auth, the tier every verb should take, the principal, the
   ceilings, the exact access ask. `bin/toolbelt ask <sketch>` drafts that ask. Build what the
   sketch says or write down in the contract why you diverged; when the tool ships, carry its
   durable facts into `tools/<name>/CLAUDE.md`, `git rm` the dossier, and set the index row to
   `built → tools/<name>`. No sketch? Write one from [sketches/TEMPLATE/README.md](sketches/TEMPLATE/README.md)
   first if the system is shared — it is cheaper than discovering the access wall after the code.
1. **Bring the source in.** Writing it yourself: copy `tools/example-readonly` (or
   `tools/example-write` if any verb mutates) as the skeleton — it already has the manifest
   shape, the contract headings, the doctor checks and a smoke test. Vendoring an existing
   repo: `bin/vendor.sh <source> tools/<name>` copies tracked files only (via `git archive`)
   and runs the `detect-secrets` gate. Subtree copies and non-repo single files:
   [docs/VENDORING.md](docs/VENDORING.md). Once it's in, **your belt owns it** — there is no
   upstream to sync back to.
2. **Write `toolbelt.json`** — declare `runtime`, `install`, `auth` (with `principal`,
   normally `"user"`), `env`, `checks`, `smoke_test`, `verbs[]` (a tier per verb — and a
   `surface` if the entry registers an MCP server), `risk` (required on tools and
   connectors), `systems[]` (the names your organization uses for what it reads), and the
   `origin` block (`repo` + `vendored_commit` for vendored code, `{}` for code authored here).
   Schema: [docs/MANIFEST.md](docs/MANIFEST.md).
3. **Write `CLAUDE.md`** — the agent contract for this tool: the auth path that actually works,
   the first read verb as typed, every write verb with its gate and what the gate shows, the
   ceilings, the quirks. Doctrine, not journey (root `CLAUDE.md`, "How to write in here").
4. **Meet "the shape of a toolbelt tool"** — the acceptance checklist at the end of
   [SENSIBILITIES.md](SENSIBILITIES.md): read-first surface; writes gated to match their
   blast radius; conservative defaults in code; a dry-run; token verbs + an external
   600-mode cache; an audit line on writes and spend; a degraded mode; default delays.
5. **Go green** — `./bin/toolbelt doctor <name>` (and `--smoke`) pass on a clean machine. Every
   `checks[]` entry proves something a teammate would otherwise discover by a failed call; a
   check that passes over a dead credential is worse than none (prefer `auth.live_token`,
   `mcp.stdio_read`, `auth.key_accepted` over file-presence checks).
6. **Regenerate the derived docs** — set `hits` and `surface` (and `readme_label` if the
   row's name differs from `<dir>/<name>`) in the tool's `toolbelt.json`, then run
   `bin/toolbelt readme --write && bin/toolbelt systems --write && bin/toolbelt risk --write`.
   README's belt table, `SYSTEMS.md` and `docs/RISK.md` are rendered from the manifests, never
   hand-edited. If the tool brings a lockfile (`package-lock.json`, `poetry.lock`,
   `requirements.txt`, …), add its directory to `.github/dependabot.yml` — or to the `EXCLUDED`
   map in `tools/repo-integrity/checks/dependabot-coverage.mjs` with a reason a reviewer can
   check. Add an example to [docs/MANIFEST.md](docs/MANIFEST.md) if the tool exercises a new
   field or check.
7. **`toolbelt doctor repo-integrity`** passes. It fails on drift in any of the above: a gate
   claimed with none in the code, a derived table out of date, a lockfile nobody watches, a
   credential literal in a tracked file, a skill naming a path that does not exist.

## The gates a review rejects on

Most of the checklist is self-evident. These four are the ones that get waved through and
shouldn't be — they are exactly where vendored tools drift:

- **The manifest must match the code (S1/S2).** If `safeguards[]` or a `verbs[]` gate claims a
  human gate, the code must enforce an `isatty()` check an agent cannot bypass with `--yes`,
  `--json`, or a client annotation. A prompt that `--yes` skips, a confirmation that's commented
  out, or a "writes are gated" line with no gate behind it is a **failing review, not a nit** —
  an over-claimed safeguard is worse than an honest `tier: "write"` with a note, because it stops
  the next reader from looking. `toolbelt doctor repo-integrity` catches the string-level
  version (gate claimed, none in the code); the reviewer still owns "is it on the right code
  path."
- **A real audit line (S7).** Every write and every paid call leaves a grep-able trace:
  timestamp, verb, target, result size — to stderr or a file. Ephemeral `print()` to stdout is
  not an audit trail. "What did the agent change last Tuesday" must be answerable in one grep.
- **Nothing secret in the tree (S11).** The secret gate must pass. `*.example` files are
  vendored; real credentials live outside the repo. This includes incidental PII — real names
  and IDs hard-coded in a script count.
- **Provenance recorded.** `origin` says where the code came from (`repo`, `vendored_commit`)
  or is `{}` for code authored here. The belt owns it either way — there is no sync direction
  to choose: [docs/MANIFEST.md](docs/MANIFEST.md#origin--provenance).

## Connectors and skills

A **connector** configures an MCP server that runs elsewhere — most code-level patterns
(ceilings, dry-run, backoff) are n/a. Focus on token lifecycle (S6), the install hygiene of its
doctor `checks`/fixes (S10), secrets (S11), and that registration is correct and its
`auth`/`safeguards` claims are actually true (a "the agent can't self-reauth" claim must still
hold in the current harness). `connectors/example-mcp` is the shape.

**Before accepting "this system is MCP-only," probe the transport.** A hosted MCP's unfitness
for bulk work is usually the per-read *inference*, not the wire: if the endpoint is stateless
HTTP (no `Mcp-Session-Id` header on `initialize`) and accepts the host's OAuth token as a plain
bearer, a script can drive it concurrently under the operator's own identity — thousands of rows
in seconds where the MCP path is an LLM turn per page. Read the token from the exact store the
host uses (one key, never the whole blob), and sniff for errors returned as text inside a 200 —
a shim that misses that turns "table not found" into "0 rows, exit 0".

There is **one skill**, `skills/toolbelt`, and it is a router. A new capability is a row in
[skills/toolbelt/SKILL.md](skills/toolbelt/SKILL.md) pointing at the tool plus the contract in
that tool's `CLAUDE.md` — never a new auto-triggering skill. Two skills that both claim "send a
message" randomize which contract the agent reads; one front door and a contract at the
destination is the only arrangement whose behavior you can eval. A skill routes writes
*through* the gated tools (never around them), pre-flights expensive work with a size/cost
preview (S5), and degrades gracefully — naming the reduced mode — when a backing asset is
missing (S8).

## Changing a contract

The prose an agent reads every session — the root and per-tool `CLAUDE.md`, the router skill,
`SENSIBILITIES.md` — is under a delete-first ablation: a line stays only if an eval fails
without it. [evals/](evals/README.md) holds the standing fixtures (one per rule the contracts
must keep carrying: the gate fires, empty means unknown, tokens never cross stdout, …) and
`node evals/run.mjs` runs them in plan mode, so nothing is sent or filed. Before cutting or
rewording a rule, run the set; if it still passes, the cut stands. A new rule that matters gets
a fixture, or the next ablation removes it without notice. Record the run on the generation
line in [evals/LEDGER.md](evals/LEDGER.md); `bin/toolbelt meter` gives the per-session token
count that line carries.

## What doesn't get vendored

Production-owned stacks, deployed services with their own pipelines, and data-heavy repos stay
out: where a hosted service is the right surface, the belt adds a connector (registration +
checks) and never forks the service. Credentials, token caches, exported data and generated
artifacts never enter the tree at all — [docs/VENDORING.md](docs/VENDORING.md) lists the
classes and where each lives instead.
