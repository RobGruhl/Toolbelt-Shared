# test-fleet — writing jobs for a Codex fleet

The guidance an agent needs before it writes a fleet prompt. The tool's flags, gates and
result format are in [../CLAUDE.md](../CLAUDE.md); this page is only about the prompt.

## The one rule

Every job states an **executable acceptance criterion**: a command, and that its exit status
(or one grep-able line of its output) decides pass or fail. Luna does bounded, fully specified
work well and drifts on procedural briefs, so describe the outcome and the check, not the
steps.

```
Run 'pytest tests/test_sync.py' once. Acceptance check: exit status. Report the failing assertion verbatim on failure.
Apply the diff in /tmp/fix.patch with 'git apply', then run 'cargo test -p core'. Acceptance check: exit status of cargo test.
Run 'npm run lint'. Acceptance check: exit status. List every file:line reported.
```

## Shapes that work

| Task class | Shape | Flags |
|---|---|---|
| Flake hunt | the same run-once prompt, `-n 10` or more | `-e low`, read-only unless the suite writes caches |
| Verify a diff | "apply X, run Y, report" — the patch is on disk, the job names its path | `-w -s workspace-write` (gated; a human's `--yes`) |
| Check matrix | a jobs file, one line per check (`-f jobs.txt`) | `-e low` |
| Diagnose a failure | "run Y; if it fails, report the first failing assertion and the 20 lines before it" | `-e medium` |

## What a job may not do

- Decide anything. A worker reports `pass`, `fail` or `blocked` with evidence; the orchestrating
  session judges. A verdict without command output in `evidence` is a claim, not a result.
- Commit or push. Worktrees are detached and removed after the job; have it report the diff.
- Need the network, write outside the work root, or take more than the per-job timeout
  (default 900 s). If it does, that is a different fleet — one a human widens with `--yes`.

## Reading what comes back

A job passed only when its exit is 0, its stream has `turn.completed`, and its verdict is
`pass`. `blocked` is almost always a sandbox denial: the default read-only sandbox refuses
every write, `/tmp` included, so `pytest`, `cargo` and `jest` caches need `-s workspace-write`.
Before acting on a decisive result, re-run the single decisive command yourself.
