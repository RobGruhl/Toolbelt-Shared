# Getting started — your first real tool

This is the literal walkthrough from the shipped example to a tool that reaches a system at your
company. It assumes `bin/toolbelt doctor` exits 0 on the kit as unzipped (warnings on the
placeholder connector, the optional GitHub token, and the not-yet-linked router skill are the
expected state). The schema every field below comes from is [MANIFEST.md](MANIFEST.md); the philosophy the steps enforce is
[SENSIBILITIES.md](../SENSIBILITIES.md); the review checklist is
[CONTRIBUTING.md](../CONTRIBUTING.md). This file routes into them and does not restate them.

The tool built here is called `tickets` (CLI `tk`), a read-only client for whatever ticket
tracker you have. Substitute your system; keep the shape.

## Part 1 — a read-only tool

### 1. Copy the example

```sh
cp -R tools/example-readonly tools/tickets
cd tools/tickets
mv exr.mjs tk.mjs && mv test/exr.test.mjs test/tk.test.mjs
perl -pi -e 's/example-readonly/tickets/g; s/\bexr\b/tk/g' $(grep -rlE 'example-readonly|exr' .)
```

(`perl -pi` because `sed -i` differs between macOS and Linux and BSD sed has no `\b`.) Three
manifest fields must change before the doctor will look at the copy:

- `name` must equal the directory name; the doctor discovers manifests by glob
  (`{tools,connectors,skills}/*/toolbelt.json`) — there is no registry to add yourself to.
- `aliases` must be unique across the belt. The rename above turns `["exr"]` into `["tk"]`; a copy
  that still says `exr` is a manifest error (`alias "exr" already claimed`) that fails `doctor`
  and every render.
- `systems[].name` must be your system. Two entries naming one system need a `preferred: true`
  between them, or `toolbelt systems --write` refuses to render.

The copy also brings `package.json` and `package-lock.json` (the example declares its `bin` and
test script there, with no dependencies), so the new directory needs a line in
`.github/dependabot.yml` — step 7 — before repo-integrity passes.

Bringing code in from somewhere else instead of writing it? Use `bin/vendor.sh <source>
tools/tickets`: it copies tracked files only (`git archive`) and runs the secret gate. From that
point the code is yours; there is no upstream to sync back to ([VENDORING.md](VENDORING.md)).

### 2. Write the manifest

Replace `tools/tickets/toolbelt.json` with the real thing. Every field below is in
[MANIFEST.md](MANIFEST.md); the ones marked required there are `name`, `kind`, `description`,
`platforms`, `origin`, and `risk`.

```jsonc
{
  "name": "tickets",
  "aliases": ["tk"],                    // unique across the belt; `toolbelt doctor tk` works too
  "kind": "tool",
  "description": "Read-only CLI over your ticket tracker's REST API",

  // The README belt table's two columns. `toolbelt readme` fails loudly if either is missing.
  "hits": "<your-system> (tickets and comments)",
  "surface": "read-only CLI; 500-row cap in code, `--limit` raises it to a 5000 ceiling; PAT in a 600-mode file outside the tree",

  "platforms": ["darwin", "win32"],
  "origin": {},                         // authored here. Vendored code: { "repo": "...", "vendored_commit": "...", "vendored_at": "YYYY-MM-DD" }

  "runtime": { "node": ">=18", "package_manager": "npm" },
  "install": [
    { "run": "npm ci", "description": "Install the pinned dependencies from package-lock.json" }
  ],
  "entrypoints": { "cli": "bin/tk" },   // a shell command run from this directory by `toolbelt run tickets -- …`

  "env": [
    { "name": "TICKETS_BASE_URL", "required": true, "secret": false,
      "description": "Your tracker's API root, e.g. https://tickets.example.internal/api/v2" },
    { "name": "TICKETS_TOKEN", "required": true, "secret": true,
      "description": "Personal access token minted in the tracker's UI; read from ~/.config/toolbelt/tickets.env when unset" }
  ],

  "auth": {
    "principal": "user",               // the operator's own credential: no belt tool grants what they do not already hold
    "flow": "personal access token minted in the tracker's profile page; stored in ~/.config/toolbelt/tickets.env (mode 600)",
    "identity": "bin/tk whoami",       // prints who the credential is; no secret. `toolbelt auth` snapshots it before and after
    "caches": [
      { "path": "~/.config/toolbelt/tickets.env", "class": "static", "store": "file",
        "refresh": "mint a new token in the tracker's UI and replace the value",
        "revoke": "delete the token in the tracker's UI" }
    ]
  },

  "safeguards": [
    "read-only: the tree holds no write code for this system",
    "500-row cap in code; --limit raises it, never above 5000",
    "every call logs verb + target + row count to stderr"
  ],

  "verbs": [
    { "name": "whoami", "tier": "read" },
    { "name": "search", "tier": "read" },
    { "name": "get",    "tier": "read" }
  ],

  "risk": {
    "read_only": true,
    "destructive": false,
    "idempotent": true,
    "open_world": false,
    "worst_case": "a search that returns the 5000-row ceiling; nothing is written"
  },

  "systems": [
    { "name": "<your-system>", "read": "bin/tk search \"is:open\"", "preferred": true }
  ],

  "checks": [
    { "use": "runtime.node", "min": "18" },
    { "use": "deps.npm_installed" },
    { "use": "files.env_set", "name": "TICKETS_BASE_URL" },
    { "use": "files.env_set", "name": "TICKETS_TOKEN", "key_file": "~/.config/toolbelt/tickets.env",
      "severity": "warn", "fix": "Mint a token in the tracker's UI; write TICKETS_TOKEN=... to ~/.config/toolbelt/tickets.env and chmod 600 it" }
  ],

  "smoke_test": {
    "command": "bin/tk whoami",
    "expect": "prints the credential's identity; one authenticated GET, nothing written"
  }
}
```

What each block is for, in one line each:

- **`verbs`** is the agent-reachable surface as data. Tiers: `read` (free to call, including verbs
  that write only a local file the operator asked for), `write-gated` (mutates beyond the
  operator's machine and names its `gate`), `write` (mutates with no gate in the belt's code —
  admissible only with a `note`, and repo-integrity warns on it every run), `never` (exists on the
  platform; the belt exposes no path to it). Declaring a `never` verb is how you say "the API can
  delete; this tool cannot."
- **`risk`** is the reviewer's vocabulary answered once. `read_only: true` alongside a
  `write-gated` verb is a manifest error.
- **`auth.principal`** is the no-escalation thesis as data: `user` passes, `none` passes when the
  entry holds no credential, `service` warns by name on every run and requires a
  `principal_exception`.
- **`checks`** instantiate the built-in library ([MANIFEST.md](MANIFEST.md#built-in-check-library)).
  `secret: true` env vars and `files.env_set` are presence-only: the doctor never prints a value
  (it opens a key file only to tell an empty one from a filled one).
- **`smoke_test`** passes on exit 0; `expect` is the sentence the doctor prints when it does, so
  write what exit 0 proves.
- **`systems`** names the system the way the rest of your company does, with the first read exactly
  as typed from the tool directory; it renders into `SYSTEMS.md`.

### 3. Write the code to match

The manifest is a claim; the code makes it true. For a read-only tool that means:

- The request helper sends `GET` only. There is no `POST`/`PUT`/`DELETE` branch to reach.
- The row cap and its ceiling live in code, not in a default argument the caller can blow past.
- Every call writes one audit line to stderr: timestamp, verb, target, result size.
- The token is read from the env var or the 600-mode file. It never appears in stdout, in a log
  line, or in an error message.
- `tk --explain <verb>` (or `--dry-run`) prints what a call would do without doing it.

### 4. Write `CLAUDE.md`

`tools/tickets/CLAUDE.md` is the per-tool agent contract. An agent reads it before the first call,
so it carries only what the agent cannot guess from `--help`:

```markdown
# tickets — agent contract

## Read first
- Auth: `TICKETS_TOKEN` from the env, else `~/.config/toolbelt/tickets.env` (600). `bin/tk whoami`
  proves it is live; a 401 means the PAT expired — the human mints a new one in the tracker's UI.
- First read: `bin/tk search "is:open" --limit 20`. Default cap 500, ceiling 5000.
- This tool has no write verbs. Do not build one from the tracker's API; a write belongs in a
  separate verb with a gate (see the kit's `tools/example-write`).

## Quirks
- The API returns errors as text inside a 200 for unknown fields; `tk` detects and exits 1.
- Search is eventually consistent; a ticket filed in the last minute may not appear.
```

State the doctrine, not the journey: what is true and why it matters, never how it was found.

### 5. Go green

```sh
cd ../..                                   # repo root
./bin/toolbelt setup tickets               # runs the install steps, each TTY-confirmed
./bin/toolbelt doctor tickets --smoke      # every check passes; the smoke test exits 0
```

A `warn` on the token check is the expected state before you have minted one; the fix line you
wrote in the manifest is what the doctor prints.

### 6. Render the derived docs

```sh
./bin/toolbelt readme --write
./bin/toolbelt systems --write
./bin/toolbelt risk --write
```

Three lines rather than one `&&` chain, so one refusal (two entries naming one system with no
`preferred`, a missing `hits`) does not hide the other two verdicts. README's belt table,
`SYSTEMS.md` and `docs/RISK.md` are rendered from the manifests, never hand-edited. If a row is
wrong, fix `hits`, `surface`, `systems` or `risk` in the manifest and re-render.

### 7. Wire the router skill and Dependabot

- Add a row for the tool to the routing table in `skills/toolbelt/SKILL.md`: what it reaches, its
  CLI name, the first read as typed from the tool directory, the path to its `CLAUDE.md`. The skill
  is the one front door: it routes an agent to the tool, its doctor and its `CLAUDE.md`, and does no
  work itself. New capabilities are rows in that list plus a contract at the destination — never a
  new auto-triggering skill.
- Add the tool's directory to `.github/dependabot.yml` under the matching ecosystem. A copy of the
  example always brings a `package-lock.json`; any tool with a lockfile (`package-lock.json`,
  `poetry.lock`, `requirements.txt`) needs this line. Security alerts scan the whole repository
  regardless; without the entry the tool gets alerts but no routine bumps and drifts silently.

### 8. Pass repo-integrity

```sh
./bin/toolbelt doctor repo-integrity
```

This fails on: a derived table that drifts from the manifests; a `tty`/`typed-echo` gate claimed
in `safeguards[]` or `verbs[]` with no gate in the code; `principal: "none"` on an entry that
declares secret env vars or credential caches; a lockfile directory missing from
`.github/dependabot.yml`; a package-registry credential literal in a tracked file; a skill naming a
path or `toolbelt` verb that does not exist. It warns, by name, on every `service` principal and
every ungated `write` verb. A credential file in the tree is the skill's own check
(`toolbelt doctor toolbelt`), and a `service` principal with no `principal_exception` is rejected
earlier, by manifest validation.

### 9. Commit

```sh
git add tools/tickets README.md SYSTEMS.md docs/RISK.md skills/toolbelt/SKILL.md .github/dependabot.yml
git commit -m "tickets: read-only client for <your-system>"
```

The pre-commit hook `setup toolbelt` installed runs the secret gate. A refused commit names the
secret-shaped value; move it to the 600-mode file outside the tree and retry.

### 10. Delete the examples

Once one real tool is green: `git rm -r tools/example-readonly tools/example-write`; remove their
two rows from the routing table in `skills/toolbelt/SKILL.md`; drop `/tools/example-readonly` and
`/tools/example-write` from `.github/dependabot.yml`; retarget `evals/cases/staged-write-hands-approve.json`
(and its row in `evals/README.md`) at your own staging tool, or delete the case. Then re-render
(step 6) and re-run repo-integrity (step 8). Keep `tools/repo-integrity`; keep or delete
`tools/slack` on its own merits.

## Part 2 — adding a write verb the right way

A write is a separate verb, never a flag on a read, and its gate matches its blast radius
([SENSIBILITIES.md §2](../SENSIBILITIES.md#2-guardrails-matched-to-blast-radius)). The tiers,
from smallest blast radius up:

| Blast radius | Gate | Manifest | Shape in code |
|---|---|---|---|
| Private, free, and reversible (a line in your own notes, a personal setting, a file on your machine) | none — loud, with its undo | `{ "name": "note add", "tier": "write", "note": "private + reversible: prints the exact undo" }` | Runs at once. Prints what changed and the exact command that undoes it, and writes the audit line. No gate, because nobody else can see it and the operator asked; repo-integrity names every ungated `write` on every run so the tier stays visible. `exw note add` is this row. |
| Reversible but paid, or shared and reversible (a label others see, a comment on a team's ticket, a bulk job billed to you) | a loud flag | `{ "name": "comment", "tier": "write-gated", "gate": "flag", "note": "visible to the ticket's watchers; deletable" }` | Without `--yes` the verb prints exactly what it would change — the full payload as it will land — and exits 0. With `--yes` it does it and prints the audit line with the target's id. The flag is always honored: prevent the naive mistake, never refuse the deliberate one. `exw board post` is this row. |
| Shared state a human must confirm in person (assign, reopen, file on someone's behalf) | `/dev/tty` | `{ "name": "file", "tier": "write-gated", "gate": "tty" }` | The verb opens `/dev/tty` directly and asks for a typed `yes`. `--yes`, `--json`, stdin redirection and a client annotation do not satisfy it. No TTY: the verb stages the payload and prints the one command a human runs — `toolbelt approve tickets <code>`. |
| Destructive or irreversible (delete, purge, close-with-prejudice) | typed echo | `{ "name": "delete", "tier": "write-gated", "gate": "typed-echo", "note": "irreversible: type the ticket id back; no --yes, nothing staged; --force only where /dev/tty opens" }` | `/dev/tty` plus typing the target's name or id back. There is no `--yes` and nothing is staged. A `--force` that skips the word is honored only where `/dev/tty` opens — a deliberate human is never refused — and is refused from a pipeline with the command to run. The terminal test is about the harness, not the caller (an agent whose shell inherits the operator's terminal passes it), so the agent contract, not the test, is what keeps an agent from passing `--force`. `exw board clear` is this row. |
| Exists on the platform, not in this belt | none — unreachable | `{ "name": "purge_project", "tier": "never", "note": "no path from here" }` | No code. Declaring it tells the reviewer you saw it and left it out. |

From an agent or an MCP surface, the `tty` and `typed-echo` gates cannot be satisfied — that is
the point. A `tty` verb called without a terminal **stages** the fully composed write (a file
under a 600-mode cache outside the tree, with a short code and an expiry of minutes), and returns
the one command: `toolbelt approve tickets <code>`. Set `entrypoints.approve` to the command that
replays a staged code; `toolbelt approve` runs it from the tool directory on a real TTY, shows the
exact payload, and asks for the typed `yes`. `toolbelt approve tickets --list` shows pending codes;
`--discard <code>` drops one unexecuted.

Every prompt states what it does, why the gate exists, and what yes and no each mean. A `y/N` the
operator cannot evaluate is a ritual, not a gate.

What changes in the rest of the manifest when a write arrives:

- `risk.read_only` becomes `false`; `risk.destructive` becomes `true` if any verb is; `worst_case`
  names the worst thing one call can do.
- `safeguards[]` states the gate in words the code backs. repo-integrity tests a `tty` or
  `typed-echo` claim against the code; an over-claimed gate fails the run.
- `surface` on each verb (`cli` | `mcp` | `both`) is required if the tool registers an MCP
  server: the offered permission profile projects `mcp`/`both` verbs into allow/deny rules.
- The audit line is not optional on a write: timestamp, verb, target, result — to stderr or a
  file, so "what did the agent change last Tuesday" is one grep.
- Read the result back after every write. A platform's `200 OK` is a claim; some APIs silently
  discard fields they reject.

## Part 3 — adding a connector for a hosted MCP

A **connector** configures an MCP server that runs elsewhere. No business logic lives in the
connector; the safety lives in the hosted service, so the connector's job is registration,
token lifecycle, and honesty about what the service lets an agent do.

```sh
mkdir -p connectors/<name>
```

`connectors/<name>/toolbelt.json`:

```jsonc
{
  "name": "<name>",
  "kind": "connector",
  "description": "Hosted MCP for <your-system>; registered into the coding agent, runs remotely",
  "hits": "<your-system> (via its hosted MCP)",
  "surface": "hosted MCP; reads free; writes the service allows are listed under verbs with their tier",
  "platforms": ["darwin", "win32"],
  "origin": { "repo": "https://<vendor>/<mcp-server>", "note": "the service this connector configures; no code vendored" },

  "auth": {
    "principal": "user",
    "flow": "OAuth in the browser on first use; the coding agent holds the token in its own store",
    "caches": [
      { "path": "~/.claude/.credentials.json", "class": "borrowed", "store": "vendor",
        "refresh": "the agent re-prompts for sign-in when the token expires" }
    ]
  },

  "mcp": {
    "server_name": "<name>",
    "registration": {
      "type": "http",
      "url": "https://<your-system>.example.internal/mcp"
    }
  },

  "verbs": [
    { "name": "search",        "tier": "read",  "surface": "mcp" },
    { "name": "get_record",    "tier": "read",  "surface": "mcp" },
    { "name": "update_record", "tier": "write", "surface": "mcp",
      "note": "the hosted service gates nothing; the agent's permission profile denies it by default" },
    { "name": "delete_record", "tier": "never", "surface": "mcp", "note": "the service exposes it; the permission profile denies it" }
  ],

  "risk": {
    "read_only": false,
    "destructive": false,
    "idempotent": false,
    "open_world": false,
    "worst_case": "an agent with update_record allowed edits a record under the operator's name; the service keeps history"
  },

  "systems": [
    { "name": "<your-system>", "read": "MCP tool search (registered by toolbelt register <name>)" }
  ],

  "checks": [
    { "use": "mcp.registered", "name": "<name>" },
    { "use": "mcp.http_reachable", "url": "https://<your-system>.example.internal/mcp" }
  ]
}
```

Then:

```sh
./bin/toolbelt register <name>            # prints the registration; --write merges it into the agent's config after a backup
./bin/toolbelt doctor <name>
./bin/toolbelt readme --write && ./bin/toolbelt systems --write && ./bin/toolbelt risk --write
./bin/toolbelt doctor repo-integrity
```

Three things to get right in a connector, because nothing else is there to get right:

- **Tell the truth about writes.** A hosted MCP's write tools are reachable by the agent the
  moment the server is registered. List each one under `verbs` as `write` with a `note`, or as
  `never` when the offered permission profile denies it. A connector that calls itself read-only
  while the service exposes `update_*` is the over-claimed safeguard the kit exists to prevent.
- **Token lifecycle.** Name the cache the agent uses, its class, and how it refreshes. If the
  agent can re-authenticate itself with no human, say so; if it cannot, the doctor's check is
  what tells the operator before the first failed call.
- **Probe the transport before accepting "MCP-only."** If the endpoint is stateless HTTP and
  accepts the agent's OAuth token as a plain bearer, a script can drive it under the operator's
  own identity at bulk scale — that is a tool, not a connector, and it gets the gates above.

`connectors/<name>/CLAUDE.md` follows the same shape as a tool's: `## Read first` with the auth
path that works and the first read, then the quirks, then which tools the agent must treat as
writes.
