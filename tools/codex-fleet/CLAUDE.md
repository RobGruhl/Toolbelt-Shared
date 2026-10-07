# codex-fleet — the agent contract

## Read first

- **What:** `bin/codex-fleet` fans out N stateless `codex exec --ephemeral` workers (default
  model `gpt-5.6-luna`) to run tests, verify a diff, hunt flakes, or sweep a check matrix, and
  rolls their structured verdicts into `summary.json`. Claude owns ambiguity and judgment; the
  fleet owns volume.
- **Auth:** the operator's own Codex CLI login (`codex login`, ChatGPT plan, `~/.codex/auth.json`).
  The tool holds no credential. `codex login status` prints `Logged in using ChatGPT` when it
  is armed; `bin/toolbelt doctor codex-fleet` runs that check.
- **First read:** `bin/codex-fleet -n 1 -e low --explain "Run 'true'. Acceptance check: exit status."`
  — the plan and the exact codex argv, nothing launched. Drop `--explain` to run it: a default
  fleet is read-only and spends plan credits only.
- **Writes (flag tier):** `-w`, `-s workspace-write`, `-s danger-full-access`, `--net` each
  **preview and exit 0** until the same command carries `--yes`. `--api` is its own loud flag
  (metered billing). **Never add `--yes` or `--api` yourself**; show the preview, get the
  human's yes naming that fleet, then re-run with the flag and say you did.
- **Ceilings:** `MAX_JOBS=50`, `MAX_CONCURRENCY=16` — constants in `bin/codex-fleet`; over
  either is exit 2, not a trim.
- **Audit:** one `[codex-fleet audit]` line per fleet at start and at done, on stderr and
  appended to `data/audit.log` (`CODEX_FLEET_AUDIT` relocates it).
- **On PATH:** `toolbelt setup codex-fleet` links `/opt/homebrew/bin/codex-fleet` at this
  directory's `bin/codex-fleet`. That link is the only thing the install touches outside the
  tree, and it is what makes the bare `codex-fleet` that `~/.claude/CLAUDE.md` names resolve to
  the gated copy.

## Writing job prompts

Each job needs an **executable acceptance criterion** — a command whose exit status objectively
decides pass/fail. State the outcome and the command, not a step list; Luna drifts on
procedural briefs. One check per job; one line per job in a jobs file (`#` lines and blanks
are skipped). `docs/test-fleet.md` is the prompt-writing guide in full.

```bash
bin/codex-fleet -n 10 -e low "Run 'pytest tests/test_sync.py' once. Acceptance check: exit status. Report the failing assertion verbatim on failure."
bin/codex-fleet -f jobs.txt -C /path/to/repo              # distinct jobs, one per line
bin/codex-fleet -n 5 -s workspace-write "Run 'npm test'. Acceptance check: exit status."   # previews
bin/codex-fleet -f jobs.txt -w -s workspace-write --yes   # mutating jobs in isolated worktrees, after the human's yes
```

## Flags and tiers

| Flag | Default | Tier | Effect |
|---|---|---|---|
| `-n N` / `-f FILE` | 1 | read | replicas of one prompt, or one job per line; total ≤ `MAX_JOBS` |
| `-m MODEL` | `gpt-5.6-luna` | read | never run a fleet on Sol by accident: the origin's `~/.codex/config.toml` defaults to Sol, which is why the wrapper pins Luna |
| `-e none…max` | `medium` | read | reasoning effort; `low` is enough for run-and-report; `max` multiplies output tokens ~9× |
| `-j N` | 8 | read | concurrent workers, ≤ `MAX_CONCURRENCY` |
| `-C DIR` | cwd | read | the work root workers see; results go under `DIR/.fleet/run-N` |
| `-t SECS` | 900 | read | per-job timeout; the whole process tree is killed |
| `-o DIR` | `.fleet/run-N` | read | results dir |
| `--raw` / `--schema F` | verdict schema | read | free-form output, or your own schema for the final message |
| `--explain` | — | read | pre-flight: the plan and the codex argv; exits 0 with nothing created |
| `-w` | off | **write-gated, flag** | each job in its own detached git worktree of `-C DIR` (dirty tracked diff applied; untracked files not copied); removed after the job |
| `-s workspace-write` | `read-only` | **write-gated, flag** | workers may write under the work root |
| `-s danger-full-access` | `read-only` | **write-gated, flag** | no sandbox at all |
| `--net` | off | **write-gated, flag** | network egress from workspace-write workers |
| `--yes` | — | — | the human's acknowledgement of a widened fleet; honored from anyone, which is why this contract forbids an agent to pass it |
| `--api` | plan billing | **write-gated, flag** | metered billing on `OPENAI_API_KEY`; exits 1 if the key is empty |

Exit codes: `0` fleet passed, or previewed/explained · `1` a job failed, or codex/jq missing ·
`2` usage, a ceiling, or `-w` outside a git repo.

**Sandbox facts.** `read-only` blocks every write including `/tmp`, so it runs inspection and
plain `unittest` but breaks `pytest`, `cargo` and `jest` caches — those need
`-s workspace-write`, which is a gated run. Pair `-s workspace-write` with `-w` for anything
that edits files, so the edits land in throwaway worktrees and the main checkout is untouched.
Workers cannot `git commit` inside a worktree; have them report diffs. Fleets over ~2 minutes:
launch with Bash `run_in_background`.

## What the preview shows

A widened run without `--yes` prints the plan on stderr — jobs, model/effort, sandbox and
widenings, work root, results dir, pool and timeout, billing, tier, the exact `codex exec`
argv — then the sentence naming what workers could change, and exits 0 having created
nothing. Hand that to the user. If they approve *that* fleet, re-run the identical command
with `--yes`. A standing instruction that covers the exact command counts as the yes.

## Reading results

`.fleet/run-N/` (printed on launch) holds `summary.json` (per-job exit, `completed`, token
usage, verdict, plus the fleet's model/effort/sandbox/billing), `summary.md`, and per-job
`job-N.{prompt,out,jsonl,log,exit}`. A job passes only when exit 0, a `turn.completed` event,
and verdict `pass` all agree — exit 0 alone can mean codex quit without doing the task. Fleet
exit 0 means every job passed. A verdict whose `evidence` carries no command output is a
claim, not a result; before acting on a decisive fleet verdict, re-run the single decisive
command yourself. `blocked` usually means a sandbox denial — check `job-N.log` and, if a write
was legitimately needed, ask for a `-s workspace-write --yes` run rather than retrying blind.
Add `.fleet/` to the work root's `.gitignore`; the results dir is local output, never a commit.

## Cost

Plan billing is the default: the wrapper removes `OPENAI_API_KEY` from each worker's
environment because codex prefers the key over the plan login and would meter silently. Luna
is ~25× cheaper than Sol on plan credits. `--api` at Luna's metered rate costs roughly
$0.01–0.03 per run-tests-and-diagnose job; reasoning effort is the dominant multiplier, so pin
it per task class. Never run a bare `codex exec` without `-m gpt-5.6-luna`. The `done` audit
line carries the fleet's summed input+output tokens.

## Storage

| Path | Holds |
|---|---|
| `<work root>/.fleet/run-N/` | prompts, event streams, verdicts, logs, `summary.{json,md}` — the operator's local output; gitignore it in that repo |
| `data/audit.log` (mode 600, gitignored) | one line per fleet start and done; `grep 'billing=api'` answers "what did we meter" |
| `~/.codex/auth.json` | the Codex CLI's own login; never read by this tool |

## Known limitations

- `-w` applies the work root's dirty *tracked* diff to each worktree; untracked new files are
  invisible to workers. Commit or `git add -N` them first.
- The `--yes` gate is a flag, not a terminal test: a fleet is private compute on the operator's
  own machine and account, so the tier is "prevent the naive mistake, honor the deliberate act"
  (SENSIBILITIES #2). The contract above, not the code, is what keeps an agent from supplying it.
- No Windows: the script is bash plus `readlink -f`, and `codex`'s sandbox model is
  macOS/Linux.

`RESEARCH.md` is the ecosystem survey (dated 2026-08-16) behind the model choice and the
acceptance-criterion rule.
