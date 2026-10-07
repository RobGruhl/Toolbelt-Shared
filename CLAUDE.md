# Toolbelt — the agent contract

The Why, then the invariants you must not break when you work in this repo. Per-tool
`CLAUDE.md` files own each tool's specifics; this file owns the repo. It does not restate
[SENSIBILITIES.md](SENSIBILITIES.md) — it points at it and tells you what to honor.

## What this is

This repo is a **belt**: a monorepo of **vendored** productivity tools for the systems its owner
works with (the roster is [SYSTEMS.md](SYSTEMS.md), derived from the manifests), the
**connectors** that configure hosted MCP servers, the **one skill** that routes an agent to the
right tool, and a zero-dependency `bin/toolbelt doctor` that takes a machine from `git clone` to
working. The kit ships two example tools, one example connector, and one real tool (`tools/slack`)
so every pattern has a worked instance; the owner replaces the examples with their own.

The Why, in one sentence: **official MCPs and vendor CLIs are correct but conservative — an LLM
round-trip per read, interactive-only registration, a server to babysit — so a belt vendors more
permissive, headless-capable tools and makes them safe by contract instead of by timidity.**
That contract is [SENSIBILITIES.md](SENSIBILITIES.md): 13 patterns, with read-first and
human-gated-writes at the core. The recurring design move is **narrowing-as-safety** — `exr`
ships no write code at all and so needs no gate; `exw` earns its one shared write by previewing
it, staging it for `toolbelt approve`, and auditing it; a tool against a shared warehouse would
drop DML/DDL to earn a hard byte ceiling. Permissiveness is *earned* by politeness and gates,
never assumed.

## How it's laid out

- `tools/<name>/` — vendored source you run locally. Each has a `toolbelt.json` manifest and a
  per-tool `CLAUDE.md` (the agent contract for *that* tool — **read it first**; it carries the
  auth path that actually works and the quirks). The kit ships four:
  - `tools/example-readonly` (CLI `exr`) — the read-only shape: no write code exists.
  - `tools/example-write` (CLI `exw`) — the gated-write shape: preview, `/dev/tty` gate, staged
    payload for headless callers, `toolbelt approve example-write <code>` as the human's confirm, an audit
    line on every write.
  - `tools/slack` — a real vendored tool against a system people use: read-first CLI + read-only
    MCP server on the operator's own browser session, writes tiered to blast radius
    (`/dev/tty` for send/react/edit/invite, typed-echo for create-channel, no delete verb at all).
  - `tools/repo-integrity` — the contract checks the doctor runs on every pass: gate claims
    against code, principal honesty, derived-table freshness, lockfile coverage, no credential
    literals, skill rot.
- `connectors/<name>/` — config + auth/registration for an MCP server that runs elsewhere.
  No business logic here; the safety lives in the hosted service. `connectors/example-mcp` is
  the shape.
- `skills/toolbelt/` — the one router skill. An agent's "do X with system Y" lands here and is
  sent to one tool and its contract. New capabilities are rows in its list, never new skills.
- `doctor/`, `bin/toolbelt` — the zero-dependency pre-flight and the belt's verbs
  (`toolbelt --help`): `list`, `doctor`, `auth`, `setup`, `approve` (the human's confirm of a
  write an agent staged), `register`, `inspire`, `ask` (draft an access request from a sketch),
  `run` / `usage` / `meter`, and the renderers `readme` / `systems` / `risk` / `creds`. Their outputs —
  README's belt table, `SYSTEMS.md`, `docs/RISK.md`, `docs/CREDENTIALS.md` — are derived from the manifests: edit the
  manifest and re-render, never hand-edit; `repo-integrity` fails on drift.
- `SYSTEMS.md` — system → preferred tool → first read → doctor id; the derived front door for an
  agent that knows which system it needs.
- `evals/` — standing task fixtures graded in plan mode (the net under any contract edit) and
  `LEDGER.md`, the generation ledger.
- `sketches/` — **the starting points for the next tools.** One research dossier per system the
  belt does not reach yet: what it is, who needs it, the documented surface and auth, the
  SENSIBILITIES shape a tool would take, a likely CLI, the access ask, the open questions.
  `sketches/README.md` indexes the verdicts; `sketches/TEMPLATE/README.md` is the form. Build the next
  tool *from* its sketch; when it ships, carry the durable facts into the tool's `CLAUDE.md`,
  remove the dossier, and leave the index row as `built → tools/<x>`.
- `docs/` — [GETTING-STARTED](docs/GETTING-STARTED.md) (clone to first tool),
  [PERSONAL-SETUP](docs/PERSONAL-SETUP.md) (your own Mac: texts, Gmail, Calendar) and [UW](docs/UW.md),
  [MANIFEST](docs/MANIFEST.md) (schema), [VENDORING](docs/VENDORING.md) (how source gets in),
  [RISK](docs/RISK.md) (derived).

## When you touch anything in here

Read the tool's own `CLAUDE.md` first, then hold these invariants. The full reasoning is in
[SENSIBILITIES.md](SENSIBILITIES.md) — honor it, don't re-derive it:

- **Reads are cheap and default; writes are exceptional and conspicuous.** A write path is
  never reachable from the MCP/agent surface without a human. A new mutation is a separate
  verb, gated to its blast radius: an un-bypassable `/dev/tty` gate for shared systems
  (headless callers stage the payload; `toolbelt approve <tool> <code>` is the human's
  confirm), a loud always-honored flag for private or reversible actions (SENSIBILITIES #2).
  Prevent the naive mistake; never refuse the deliberate one — an explicit `--yes`/`--force`
  on a flag-tier verb is always honored.
- **The manifest must not lie.** A `safeguards[]` entry or a `verbs[]` gate claiming a human
  gate means the code enforces one an agent can't route around. Change the code, change the
  manifest — if they disagree, that's a bug, not a nit. An over-claimed safeguard is more
  dangerous than an honest "this writes, no gate" (`tier: "write"` with a note), because it
  stops the next reader from looking. `toolbelt doctor repo-integrity` fails on a gate claimed
  with no gate in the code.
- **Secrets never enter the tree** — not in code, config, or history. Credentials live in OS
  keychains or 600-mode caches *outside* the repo; `*.example` files are vendored, real ones
  never are. Incidental PII (real names/IDs in a script) counts.
  [docs/CREDENTIALS.md](docs/CREDENTIALS.md) (derived) names each tool's key, its lookup order
  and how to set it. When a key seems missing, search the stores it lists — the operator
  usually already has one — before asking them for it, and never ask for the value in chat.
- **The belt stands alone.** Every file in the tree is yours to edit; nothing syncs to or from
  anywhere. An entry's `origin` is provenance and inspiration — `bin/toolbelt inspire <tool>`
  shows what the source repo did since your snapshot — never a merge base. Never overwrite a
  tool's tree from its origin: local edits like the safety gates are the point. See
  [docs/VENDORING.md](docs/VENDORING.md).
- **Install hygiene:** brew / pipx / poetry / npm-local. No global pip, no `curl | bash` — in
  the tools *or* in a doctor fix command.
- **No escalation.** Every credential a tool holds is the operator's own (`auth.principal:
  "user"`). A tool never grants a capability the operator does not already hold; the rare
  exception is written down as `principal_exception` and named on every doctor run.

Adding a whole new tool, not just editing one? Start from its sketch if one exists (it already
holds the demand, the surface, the tiers and the ask), copy `tools/example-readonly` as the
skeleton, then [CONTRIBUTING.md](CONTRIBUTING.md).

## How to write in here

**Every document states the doctrine, not the journey to it.** Record what is true and why it
matters. Do not narrate how it was discovered, what was believed before, or which attempt
failed on the way. The fuller rules of the pen — plain sentences, no examples the general
statement already covers, spend words only on what a smart reader couldn't guess — are in
[surfing-the-overhang.md](surfing-the-overhang.md); this section is the repo-specific summary.

When you learn something that overturns existing text, **rewrite the text to say the new
thing** — don't append a correction. The reader wants the current rule, and every "previously
we thought…" costs them attention while teaching them nothing they can act on.

| Don't write | Write |
|---|---|
| "An earlier note claimed X, but that was wrong — actually Y." | "Y." |
| "We first tried X, which 403s, so the route is really Y." | "The route is Y. The X form 403s even when correctly scoped." |
| "Verified on Tuesday that the cert is fixed." | "The cert is valid through 2026-12-31." |

Two things this does **not** mean:

- **Keep the reasoning.** "Why" is doctrine, not story. A rule whose rationale is stripped gets
  "simplified" away by the next reader. Explain the failure a rule prevents — just don't
  recount the time it bit you.
- **Keep genuine state, and date it.** Tokens, outages, open questions and anything
  time-sensitive belong in a clearly-marked status section with a date, so a reader can tell
  when it drifted. That is current state, not a war story. Prune it once it stops being true
  rather than layering the next update on top.

**Three genres are exempt, because for them the history _is_ the content.** Don't "fix" these:

- **The git log** — the one place a "how we got here" narrative belongs.
- **Audit and remediation records** (a compliance ledger, a standards-readiness doc, a
  `CHANGELOG.md`, `evals/LEDGER.md`). A finding struck through and marked `FIXED` is evidence
  that someone closed it. Strip the before-state and you destroy the audit trail. Their "do not
  re-flag" lists are load-bearing.
- **Migration and catalog docs** — "what moved, and why the old path still works" is the entire
  deliverable; a superseded-candidate table is current status, not reminiscence.

The test is not "does this sentence mention the past" but **"would a reader act differently if
this were cut?"** In a tool contract, a war story is noise. In an audit, it is the point.

## Git

Commits are public to your teammates: this repo is built to be cloned, so assume everything in
the tree will be read and run by someone else. Let git resolve the author from the clone's
configuration; never hardcode an identity per commit. The pre-commit secrets gate
(`toolbelt setup toolbelt` turns it on) is the last line between a pasted token and a history
that keeps it forever — leave it on.
