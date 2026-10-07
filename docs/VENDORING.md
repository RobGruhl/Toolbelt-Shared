# Vendoring — how code gets in, and why it never goes back out

**The belt stands alone.** Every file in this tree is owned, edited, and released here — tools,
connectors, skills, the doctor. Nothing syncs in either direction: no upstream to PR against, no
mirror to publish to, no copy that is "really" somewhere else. A tool's `origin` block records
where its code came from, and that record is *provenance plus inspiration*: `toolbelt inspire
<tool>` shows what the origin repo has committed since the snapshot you took, so a human can
glance at it for ideas worth hand-porting. It is never a merge base and never an obligation.

Why this shape: a belt cloned by dozens of engineers cannot wait on anyone else's review cycle,
and a safety gate that lives "only here, pending an upstream PR" is a gate that exists. The cost
is that improvements made upstream don't arrive by themselves — which is exactly the cost a
one-command glance and a deliberate port are meant to keep small.

Code lives in the tree as plain directories: full source committed, provenance recorded in each
`toolbelt.json`. No git submodules, no subtree merges — a plain copy, so `git log` of the belt
is the whole history a reader needs. One clone gets everything; dependencies (`node_modules`,
`.venv`) are rebuilt by `toolbelt setup`, never committed.

## Initial vendor

```sh
bin/vendor.sh ~/src/hello-tool tools/hello
# subtree vendor (one tool out of a monorepo):
bin/vendor.sh ~/src/team-scripts tools/hello tools/hello-cli
```

The script:

1. **Warns on dirty trees** — only committed state (`HEAD`) is vendored. If the source has
   uncommitted work you want, commit it there first.
2. **Copies tracked files only** via `git archive HEAD | tar -x`. This single choice excludes
   every credential the source gitignores, and `.git/`, by construction. `cp -r` is banned for
   repo sources.
3. **Prints the `origin` block** for the destination's `toolbelt.json`: `repo` (the source repo
   URL, or the local path for local-only sources), `vendored_commit` (the snapshot — what
   `toolbelt inspire` diffs against), and `vendored_at`. See
   [MANIFEST.md](MANIFEST.md#origin--provenance).
4. **Runs the secret gate** — `detect-secrets scan` over the vendored tree; any finding deletes
   the tree and fails. Belt to git-archive's suspenders. The script refuses to run at all when
   `detect-secrets` is missing (`pipx install detect-secrets`): a scan that does nothing reads
   as a pass.

Then by hand:

5. Write `toolbelt.json` (schema: [MANIFEST.md](MANIFEST.md)) and the tool's `CLAUDE.md`.
6. Python tools: add `poetry.toml` with `[virtualenvs] in-project = true` so the venv lives
   inside the tool dir (self-contained, gitignored, path-stable).
7. `./bin/toolbelt doctor <name>` and `./bin/toolbelt setup <name>`.

### Code authored here

A tool written in the belt (start by copying `tools/example-readonly`) has no source to
archive. Its `origin` is `{}` — or `{ "note": "authored in this repo" }` — and every other
step above still applies, the secret gate included.

### Non-repo sources

Single files (a standalone launcher or binary dropped into a tool dir) are copied by hand.
Record where it came from in `origin` (`repo`, plus a `note` if the source needs explaining —
see [MANIFEST.md](MANIFEST.md)), and still run `detect-secrets scan` over the result.

### What must never be vendored

Three classes, and the per-tool list lives in the tool, not here: its manifest's
`auth.caches[]` (where credentials live) and `do_not_vendor[]` (what the tree excludes),
enforced by the root and per-tool `.gitignore`.

- **Credentials and token caches.** Canonical home is `~/.config/toolbelt/<tool>.*` (mode 600),
  the OS keychain, or a vendor-owned cache (`~/.config/gcloud/`, `~/.aws/`, a cloud CLI's own
  profile dir); an in-tree gitignored copy (`.env`, a `*.ini` with a password) is a deprecated
  fallback the tool announces on stderr. The `.example` file IS vendored; the real one never is.
- **Data and artifacts.** Exported content, generated output dirs, consultation history, and
  packed-source bundles.
- **Anything `detect-secrets` flags**, in any tool, on every commit — the pre-commit hook
  `toolbelt setup toolbelt` installs runs the same scanner.

## Changing a tool

Edit it. Run `./bin/toolbelt doctor <tool> --smoke`. Commit. That is the whole procedure, for
every entry in the belt.

When an origin repo is worth a look — a vendor shipped a fix, a teammate's repo grew a feature —
`./bin/toolbelt inspire <tool>` lists its commits since your snapshot. Port what's worth porting
by hand, commit here, and (optionally) bump `origin.vendored_commit` so the next glance starts
from there. Never copy a tree over yours: local changes such as the safety gates are the point
of the belt, and an overwrite silently removes them.

The secret rules above apply to *every* commit, not just the initial add.
