# Sensibilities

The design philosophy behind every tool in a belt. These tools exist so a coding agent can
work your company's productivity systems at **industrial scale** — hundreds of reads, broad
sweeps, deep history pulls — without ever putting production stability, data, or trust at
risk. Each pattern below is stated, justified, anchored to a concrete exemplar (the kit's two
example tools, `tools/example-readonly` (`exr`) and `tools/example-write` (`exw`), or the
shape any tool against `<your-system>` would take), and translated into guidance for the
next tool you build.

A tool is admitted to a belt only if it honors these patterns. The patterns are the
acceptance bar, not aspirations.

---

## 1. Read-first bias

**Statement.** Reads are the default, plentiful, and cheap. Writes are exceptional,
singular, and conspicuous.

**Why.** An agent that can only read can embarrass you; an agent that can write can page
the on-call. Asymmetry in capability should match asymmetry in consequence.

**Exemplars.** `tools/example-write` keeps every write path on the CLI: its manifest gives no verb an
MCP surface, so an agent reaches a write only through the staged-and-approved path.
`tools/example-readonly` is read-only by construction — there is no write code to misuse.
The belt's own tooling follows the rule: anything in `bin/toolbelt` that would mutate a file
outside the tree (an editor's MCP registration, a skill symlink, a settings file) *prints* the
change by default and mutates only under an explicit `--write` or a per-step confirmation at a
terminal.

**Apply it.** Ship the read surface first. If a write path must exist, make it a separate
verb, a separate code path, and never reachable from the MCP/agent surface without a human.

## 2. Guardrails matched to blast radius

**Statement.** Every safeguard prevents the naive mistake, never the deliberate act.
Shared-system mutations pass through a TTY confirmation an agent cannot bypass;
paid-but-private and reversible actions guard *accidental* use only — a deliberate
override always proceeds, loud and audited, never refused.

**Why.** An engineer a tool refuses does not stop; they reach for a hand-rolled
workaround with no safeguards, no audit trail, and a bigger blast radius. Blocking a
legitimate act makes the real outcome worse, so ergonomics is itself a safety feature:
the safe path has to be the convenient one.

**Exemplars.** `tools/example-write` carries the whole tier ladder in one tool. Its
*destructive* verb, `board clear`, is the strictest gate: the shared board is wiped in one
stroke, so the verb reads `/dev/tty`, makes the operator **type the word `clear` back**
rather than "yes", and ships **no `--yes`**; `--force` skips the typed word only where
`/dev/tty` opens (from a pipeline it is refused with the command to run), so an agent's only
path is `--explain` plus handing the command to a human. Its
*reversible* shared write, `board post`, appends one line other people will read, so it
previews and exits 0 until re-run with a `--yes` the operator supplies after reading the
preview; with no terminal it stages the payload for `toolbelt approve example-write <code>`
instead. Its *private* writes, `note add` and `note rm`, touch only the operator's own
file, run at once and print their own undo — the three verbs are the tier boundary in one
tool. The tier is set by *what the write destroys*, not by which endpoint it calls: an edit
verb takes a stricter shape than a post — a diff of the text being replaced, a pre-edit
backup on disk, and a refusal when the update would drop what the platform cannot restore —
because a post can only be too much, while a bad edit erases wording people already read.
A paid-but-private tool (an image or embedding
generator billed to the operator's own account) guards surprise bulk spend with a confirm,
and `--yes` always proceeds. A browser-automation tool defaults to a contained throwaway
profile and makes every widening one loud, `--force`-able flag away.

**Apply it.** Judge by blast radius and reversibility, not by whether a prompt exists.
Irreversible shared-system mutation: gate on `isatty()`, no bypass flag. Private, paid,
or reversible: safe default, one obvious flag to widen, honored non-interactively for
scripts and agents. No TTY and no flag: exit non-zero and print the ways forward — that
is a missing acknowledgement, not a refusal. **A y/N the operator cannot evaluate is a ritual,
not a gate**: every prompt states what it does, why it exists, and what yes and no each mean —
the default is no, and no never breaks anything that already works. When the agent composes a
write it cannot confirm, **stage it** — write the exact payload to a 600-mode file and hand the
human one short command that opens `/dev/tty`, shows the payload, and sends on a typed `yes`:
`toolbelt approve <tool> <code>`. The gate is unchanged; what changes is that the human
confirms instead of retyping.

Declare the tier of every verb in the manifest — `verbs[]`, each `read`, `write-gated`
(naming its gate: `tty`, `typed-echo`, `flag`, or `containment`), or `never` — so the surface
an agent may touch is a filter over data, not a reading of prose. Three consequences the tiers
imply:

- **Read back after every write.** A platform's `200 OK` is a claim, not proof — some
  platforms discard disallowed fields and still answer 200. Re-read the record and report the
  diff.
- **Fetched enterprise content is untrusted input.** A page, ticket, or message the tool
  pulled in can carry instructions aimed at the agent; only the `/dev/tty` tier holds against
  a session that has been turned. That is why shared-system writes never get a `--yes` an
  agent can supply.
- **A read that sends data off-host is egress**, and takes the containment tier: a
  throwaway profile, a named destination, a loud flag to widen — not a silent default.

## 3. Conservative defaults in code, overrides that scale with the stakes

**Statement.** Resource defaults are conservative and live in code, so nothing expensive
happens by accident. How hard the override is scales with the blast radius: a loud flag
for private spend, a reviewable code edit for ceilings that protect shared systems.

**Why.** A flag can be passed by an agent having a bad day, so the last line against a
shared-warehouse petabyte scan must be a diff, not an argument. But a dollar of private
spend deliberately chosen is legitimate work — walling it off just drives the work to an
unguarded tool (pattern 2).

**Exemplars.** `tools/example-readonly` carries an in-code row cap that no flag raises. A
query tool against a shared warehouse enforces the full set — a server-side byte budget
(the platform kills the job, not the client), a statement allowlist that admits only
`SELECT`-shaped statements, a pre-flight dry-run, a timeout, and the row cap — with a modest
default budget that config can *lower* and only a code edit can raise past the ceiling. A
paid model-call tool applies a code-level per-request cost ceiling even when config omits
one; a hand-edited higher limit is honored. A batch-pricing tool prices every job before
running and asks for `--yes` above a small dollar threshold — a naive-mistake guard, never a
cap.

**Apply it.** Pick a conservative default, enforce it server-side where the platform
allows. For shared-system ceilings, make the override path a diff. For private spend,
make it a flag that always works — and always show the estimate first (pattern 5).

## 4. Off-hours bulk gating

**Statement.** Industrial-scale operations defer to business hours: bulk work runs
off-hours by default, and overriding that is loud.

**Why.** Tier 0 systems — the ones the business runs on — serve people during the day.
Your 400-channel export can wait until evening.

**Exemplars.** A chat-platform tool blocks bulk operations during local business hours
unless `--force` is passed, and `--force` prints a warning. A wiki/ticketing client carries
a resilience layer with business-hours-aware throttling, rate limiting, and circuit
breaking.

**Apply it.** Know which tier the target system is. For Tier 0/1, default bulk work to
off-hours and keep per-request delays even then.

## 5. Pre-flight everywhere

**Statement.** Estimate before you execute. Every expensive or risky operation has a
dry-run that costs nothing.

**Why.** The cheapest incident is the one previewed out of existence.

**Exemplars.** `exr --explain` prints what a verb would fetch — endpoint, filters, the cap
that applies — without touching `<your-system>`; `exw <write verb> --explain` prints the exact
line a write would append and writes nothing. A warehouse tool's `dry` verb prints the byte estimate before the query
runs. A model-call tool packs its input, counts tokens, prices the request, and warns about
sensitive files — all before submitting. The doctor is this pattern applied to the belt
itself: `toolbelt doctor` verifies runtime, deps, auth, and registration before you ever run
a tool in anger.

**Apply it.** If the operation has a cost dimension (bytes, dollars, API calls, blast
radius), expose a dry-run verb and make the real verb show the estimate first.

## 6. Token lifecycle discipline

**Statement.** Credentials live in well-known caches outside the repo, with `status` /
`login` / `logout` verbs, honored TTLs, and metadata-only logging.

**Why.** Tokens are radioactive. You want to know where every one of them is, how old it
is, and how to revoke it — without ever printing one.

**Exemplars.** `tools/example-readonly` reads its optional token from `$GITHUB_TOKEN` or a
600-mode file at `~/.config/exr/token`, refuses a looser mode, and shows the header as
`Bearer ***` in `--explain`; the doctor's `files.env_set` check reports presence, never the value. A tool whose platform
authenticates through a browser SSO flow caches the derived session in a 600-mode file and
re-auths through a *visible* browser window, never a hidden one. The doctor's `auth.*`
checks report existence, age, and file mode — never contents.

**Apply it.** Derived-token caches live under `~/.<tool>/`, `~/.config/toolbelt/`, or the
vendor's cache, mode 600. Give the user three verbs. Log that a token was used, never what it
was. Declare every cache in the manifest with its **class**, because the class sets the rule:

| Class | Store | Rule |
|---|---|---|
| Short-lived derived tokens (OAuth access/refresh, STS, cloud-SDK default credentials) | the vendor's cache or a 600-mode file outside the tree | Already "minimum time required" by construction. A 600 file outside the tree is a **pass**, never a warning — warning fatigue is the shadow path. |
| Long-lived static secrets (PATs, API keys, client secrets, identity tokens) | the **OS keychain** | Chosen for sweep-invisibility and encryption at rest, not for ACLs — anything running as the user can read either store. Read-only scope wherever the vendor offers one; where it doesn't, the manifest says so and names the compensating control. |
| Borrowed tokens (one tool reading a credential another tool already holds) | the lender's store | Read only the one key needed, never the whole blob; the doctor reads the exact store the tool reads. |
| Session credentials (browser profiles, cookie jars) | 700 dir / 600 files | Declared as secrets even though no standard names them; `logout` is the revocation. |

Two rules the classes share. **Every credential the belt holds is the operator's own, bound
to their corporate identity, and dies with their account** — no shared passwords, no
undeclared service tokens; a `service` principal is admitted only with its exception written
in the manifest (pattern 13). And **a verb that prints a token does not exist**: `status`
reports path, mode, and valid-through; the value never crosses stdout where a subprocess could
capture it.

## 7. Audit logging on writes and spend

**Statement.** Every write and every paid call leaves a local trace a human can
reconstruct later. Read-only tools may log, but are not required to.

**Why.** Pattern 2's "loud and audited" override is only real if the audit trail exists —
an un-logged `--force` is just an unlogged mutation. Reads carry no such debt; demanding
a trace for every read is a rule nobody follows, which teaches people to ignore the
rules that matter.

**Exemplars.** `tools/example-write` writes an `[exw audit]` line to stderr after every mutation —
timestamp, verb, target, and the byte and line delta from re-reading the file — and never the
credential or the full payload. An
edit verb backs up the pre-edit text to disk before it calls the update endpoint. A paid
tool tracks spend per call. A tool against a platform that silently drops disallowed fields
re-reads every field it set and reports the diff (pattern 2).

**Apply it.** On any mutation or paid call, log to stderr or a local file: timestamp,
verb, target, result size. Make "what did the agent change last Tuesday" answerable in
one grep.

## 8. Graceful degradation

**Statement.** Tools detect missing capability and offer the reduced mode instead of
dying.

**Why.** Half the value at zero risk beats all the value behind a broken dependency.

**Exemplars.** A tool whose platform refuses one read path falls back to a coarser one (a
rendered export instead of a direct query) and names the mode it is in; a `probe` verb
reports which capabilities the credential actually holds. When an enumeration endpoint is
closed by scope, fall back to search and say so rather than reporting an empty list.
`tools/slack`'s `find-channels` is that fallback where `conversations.list` is
admin-restricted. The doctor renders `skip` — not `fail` — for checks whose platform
implementation doesn't exist yet.

**Apply it.** Probe capabilities at startup. Name the degraded mode in your output so the
user knows which version of the tool they got.

## 9. Industrial scale with production protection

**Statement.** Scale is achieved with politeness built in: default delays, rate limits,
circuit breakers, backoff.

**Why.** The whole premise of a belt is *more permissive than the official MCPs, safer
than raw curl*. Politeness is what earns the permissiveness.

**Exemplars.** `exr` sends one request per verb, caps `--limit` at the API's own page maximum, and
when the rate limit is hit reports the reset time and exits rather than retrying. A client
library vendored for a shared platform ships rate limiting and circuit breaking as library
defaults, not options.

**Apply it.** Delays default on; the burden is on the human to lower them. Treat 429s as
a design failure, not a retry case.

## 10. Install hygiene

**Statement.** brew for system binaries, pipx for Python CLIs, poetry for Python libs,
npm-local for Node libs. No global pip. No `curl | bash`. Ever.

**Why.** A clean machine is diagnosable; a polluted one generates support tickets that
look like tool bugs.

**Exemplars.** Every Python tool carries a `poetry.toml` with `in-project = true` so its
venv is self-contained and disposable. The `bin/toolbelt` shim's missing-node remedy is
exactly `brew install node` — never a download script. Doctor `fix` commands must comply
with this table or they don't ship.

**Apply it.** Declare your runtime in `toolbelt.json`. If your fix suggestion isn't
brew/pipx/poetry/npm-local, it's wrong.

## 11. Secrets hygiene

**Statement.** Credentials never enter this repository: not in code, not in config, not
in history. Defense in depth — upstream `.gitignore`, `git archive` vendoring (tracked
files only), and a `detect-secrets` gate that blocks the vendor step and the commit on any
finding.

**Why.** A belt is built to be cloned by teammates. One leaked credentials file poisons the
well for every tool in it.

**Exemplars.** `bin/vendor.sh` refuses to complete if `detect-secrets` flags a file; the
pre-commit hook runs the same scanner. `.gitignore` blocks the known credential filenames
(`.env`, `*.ini`, token caches) as a third layer. Example files (`.env.example`,
`<tool>.ini.example`) ARE vendored so setup is self-documenting. Keys live in the store
§6's table assigns their class — the OS keychain for static secrets, a 600-mode file under
`~/.config/toolbelt/` for dotenv-loaded config — never in shell rc files.

**Apply it.** Before vendoring or committing, ask: if this file leaked on a conference
screen, would anything need rotating? If yes, it doesn't go in. Two extensions, because
config files are not the only vector — credentials *belonging to someone else* and
credentials *carried by data* leak just as readily:

- **Exports, attachments, and captures are scanned like config.** A channel catalog, a
  transcript, a screenshot, a zip bound for a shared drive: the secrets gate runs on what a
  tool *produces*, not only on what it commits.
- **The operator's own notes are a surface too.** Session memory, scratch files, and
  hand-off docs that load into every session carry the same rule as the tree.

Where a secret lives follows its class. A long-lived static secret goes in the OS keychain
when the tool reads one (§6). A tool that loads dotenv-style config reads
`~/.config/toolbelt/<tool>.env` (mode 600) — that file, not the tree, is the canonical home;
an in-tree gitignored `.env` is a deprecated fallback the doctor warns on, because
`git clean -fdx` destroys in-tree credentials and an agent's `grep -r` over the repo pulls
them into context. The doctor fails any in-tree secret file that is not mode 600.

## 12. Release discipline

**Statement.** The belt has one version (`VERSION`, semver, the whole repo). A change that
makes a clone need to re-run something or change a habit is breaking: it bumps the major and
gets a dated **Re-run** line in `CHANGELOG.md`. The doctor prints the version and tells each
machine once when it has crossed a release boundary. Nothing is published to an org-level home
until a pilot group has validated the release and the reviews your organization requires —
security, AI governance — have happened.

**Why.** Dozens of clones update by `git pull`, with no CI and no installer between the commit
and their machine. A breaking change that arrives silently looks like breakage; one that arrives
with a number, a date, and a re-run line looks like a release. And a reference architecture earns
org-level publication by demonstrating there is a there there, not by being pushed there first.

**Exemplars.** `VERSION` at the root; `CHANGELOG.md` with a **Re-run** line per breaking change;
the doctor's report reads both and remembers the last version seen per machine in
`~/.cache/toolbelt/last-version`.

**Apply it.** Breaking something on purpose is fine — say so in the changelog before you commit,
bump the major, and make the doctor's upgrade notice true. Fixing something is patch. Adding a
tool is minor. Tag the release when the pilot group says it works, not when the code compiles.

## 13. No escalation

**Statement.** No belt tool grants any capability the operator does not already hold.
Every credential is the operator's own; every action is attributable to them; the belt
accelerates and never escalates.

**Why.** This is the claim that makes sharing the belt with hundreds of people defensible
to a reviewer, and it only holds if it is checkable. A shared token, a service account, or a
credential minted for the tool rather than the person would turn a productivity kit into a
privilege grant — and a reviewer who finds one such exception stops trusting every other
safeguard in the tree.

**Exemplars.** `exr` and `exw` run on the operator's own token for `<your-system>`; a
warehouse tool runs on the operator's own cloud-SDK default credentials; a connector runs on
the operator's own login to the hosted service. Every credentialed manifest declares
`auth.principal` — `"user"` is the rule, `"none"` says the tool holds no credential at all,
and `"service"` is the exception that must carry a written `principal_exception`. The
`repo-integrity` check fails the doctor on a manifest that claims `"none"` while declaring
secret env vars or credential caches, and on a `tty`/`typed-echo` verb with no gate in the
code; it warns, naming each one, for every `service` principal on record — so the reviewer
verifies the thesis by running a check, not by reading this paragraph, and an exception is
never silently green.

**Apply it.** A tool whose credential is not the operator's own goes in only as a declared
exception: `auth.principal: "service"` with a `principal_exception` that says why the
credential is not the operator's own and what bounds it, and it stays visible as a doctor
warning until a user-scoped alternative exists. Declare `auth.principal` on every
credentialed manifest. Where a platform offers no user-scoped read-only token, say so in the
manifest and name the compensating control.

---

## The shape of a toolbelt tool

Putting it together — a new tool earns its directory under `tools/` when it has:

1. A read surface that covers the real need (1)
2. Writes, if any, gated to match their blast radius — un-bypassable TTY for shared
   systems, typed-echo for the irreversible, a loud always-honored flag for private spend (2)
3. Conservative defaults in code, override difficulty scaled to the stakes (3),
   business-hours awareness for bulk paths (4)
4. A dry-run verb (5)
5. Token verbs + 600-mode cache outside the repo (6)
6. A grep-able audit line on every write and paid call (7), a degraded mode (8),
   default delays (9)
7. A `toolbelt.json` manifest declaring runtime, install, auth, checks, and smoke
   test (10) — and whose `safeguards[]` matches what the code enforces; an over-claimed
   safeguard is a failing review, not a nit (see [CONTRIBUTING.md](CONTRIBUTING.md))
8. Nothing secret in the tree (11)
9. `auth.principal` declared (`"user"` unless a written `principal_exception` says
   otherwise), a `verbs[]` tier per verb, and a `risk` block a reviewer can
   read in their own vocabulary (13, 2) — all rendered into derived tables, none restated
   in prose
