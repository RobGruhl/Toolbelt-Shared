# repo-integrity — agent guidance

## Read first

- **What:** Doctor-run checks on the belt's own contract — manifests against code, derived tables
  against manifests, skills against the CLI — not on any external system. Read-only by
  construction.
- **Auth:** none.
- **First read:** `bin/toolbelt doctor repo-integrity`
- **Writes:** none — every check reads files and prints one JSON verdict line.
- **Live here?** always; there is no external system to be down.

Seven checks, all read-only, each a script under `checks/`. What each reads and what makes it
fail:

- `safeguards-honesty` — every manifest's `safeguards[]` prose. A **positive** human/TTY-gate
  claim fails unless `isatty` / `/dev/tty` / `confirmOnTty` / `confirm_on_tty` appears somewhere
  in that entry's code.
- `principal-honesty` — every manifest's `auth.principal`, secret `env[]`, `auth.caches[]` and
  `verbs[]`. **Fail:** `principal: none` alongside secret env vars or credential caches, or a
  `write-gated` verb with gate `tty`/`typed-echo` and no gate string in the code. **Warn**, named
  on every run: a `service` principal (with its written exception) or an ungated `write`-tier
  verb — admitted facts that must stay visible, not bugs.
- `readme-index` — README.md's belt table, which is derived from the manifests. Fails when the
  marker block differs from the render (`bin/toolbelt readme --write` regenerates), when
  README.md is missing, or when a manifest lacks the `hits`/`surface` fields the render needs.
- `derived-freshness` — the marker blocks in `SYSTEMS.md` and `docs/RISK.md`, which must equal
  the render from manifests via `doctor/lib/systems.mjs` (`bin/toolbelt systems --write &&
  bin/toolbelt risk --write` regenerates). A missing file is drift. A manifest error anywhere
  fails this check, since nothing can render.
- `dependabot-coverage` — every directory carrying a lockfile or requirements file must be listed
  in `.github/dependabot.yml` or named in the script's `EXCLUDED` map with a reason (fail).
  Listed or excluded directories with no lockfile behind them warn. With no lockfiles and no
  `dependabot.yml` yet, the check skips — add the file with the first tool that carries a lockfile.
- `no-credential-literals` — every tracked path (`git ls-files`; the whole tree when the kit is
  not yet a git repo), scanned for package-registry credential literals: npm `_authToken` /
  `_auth` / `_password`, `POETRY_HTTP_BASIC_*PASSWORD`, `*_TOKEN` env assignments for registry
  names, and `user:pass@` in an index URL. Placeholders (`${VAR}`, `<token>`) and `*.example`
  files pass.
- `skills-rot` — every `SKILL.md`. Every repo path it names must exist, every `toolbelt <verb>` it
  names must be a `case` in `doctor/cli.mjs`, and every skill directory must carry a manifest (a
  skill without one is invisible to `toolbelt list`, the doctor, and the README).

Run via `toolbelt doctor repo-integrity`, or directly: `node checks/<name>.mjs` prints one JSON
verdict line (`status` is one of `pass` / `warn` / `fail` / `skip`).

## How a gate is recognized

Both honesty checks answer "does this entry's code contain a terminal gate?" the same way: they
walk the entry's directory for `.py .js .mjs .cjs .sh .ts` files (skipping `.venv`,
`node_modules`, `.git`, `dist`, `data`, `__pycache__`, `checks`, and — for verb tiers — `tests`
and `test`), to a depth of six, and test each file against

    /(isatty|\/dev\/tty|confirmOnTty|confirm_on_tty)/

Any one match anywhere in the entry satisfies the claim. A tool that stages headless writes for
`toolbelt approve <tool> <code>` is recognized through the same tokens: the approve path opens
`/dev/tty` or tests `isatty`, and that literal is what the check sees. Name the gate with one of
those four tokens in the code that enforces it; a gate written some other way is invisible here
and the manifest claiming it will fail.

The positive-claim regex on `safeguards[]` prose matches `/dev/tty`, `isatty()`, `confirmOnTty`,
`confirm_on_tty`, "TTY-confirmation gated", "gated by a(n un-bypassable) TTY", and
"un-bypassable /dev/tty | TTY | human". Prose that *denies* a gate ("cannot be TTY-gated", "no
local gate") does not match and keeps passing — honesty about the absence of a gate is the
behavior these checks exist to protect.

## Quirks that matter when editing

- A pass here proves a gate *string* exists in the entry's code, not that the gate is wired to
  the right verb. It catches the over-claim class (gate claimed, none written); code review still
  owns "is it on the right code path."
- Connectors carry no code, so a connector cannot truthfully claim a `tty`/`typed-echo` gate. Tier
  a hosted server's writes `write` (with a note) or `never`.
- The manifest-driven checks (`safeguards-honesty`, `principal-honesty`, `readme-index`,
  `derived-freshness`) import `doctor/lib/manifest.mjs` — if manifest discovery moves, they move
  with it. `readme-index` also imports `doctor/lib/readme.mjs`; `derived-freshness` also imports
  `doctor/lib/derived.mjs` and `doctor/lib/systems.mjs`. The other three read the filesystem and
  `git` directly.
- A crash in a check reports as "custom check did not emit a JSON result" and silently stops
  contract verification for that line — coerce shapes rather than trust them, and prefer a `skip`
  verdict with a message over a throw when a file the check reads is legitimately absent.
