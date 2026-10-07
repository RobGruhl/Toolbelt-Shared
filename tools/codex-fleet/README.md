# codex-fleet — Luna test fleets

`bin/codex-fleet` fans out N headless Codex workers, each a stateless `codex exec --ephemeral`
process on `gpt-5.6-luna`, and rolls their structured verdicts (`pass|fail|blocked` +
evidence, `share/verdict.schema.json`) into `summary.json` for the orchestrating session to
judge. Each job prompt carries an executable acceptance criterion — a command whose exit
status decides the verdict.

`CLAUDE.md` is the contract: flags, tiers, the `--yes` gate on widened fleets, ceilings, cost,
how to read results. `docs/test-fleet.md` is the prompt-writing guide. `RESEARCH.md` is the
ecosystem survey the design came from.

```bash
bin/codex-fleet -n 10 -e low "Run 'pytest' once. Acceptance check: exit status."   # flake hunt, read-only
bin/codex-fleet -f jobs.txt -C /path/to/repo                                       # distinct jobs
bin/codex-fleet -f jobs.txt -w -s workspace-write                                  # previews; add --yes to run
```

Requirements: Codex CLI (`brew install codex`, logged in with `codex login`), `jq`, git.
`toolbelt setup codex-fleet` links `/opt/homebrew/bin/codex-fleet` at this copy so the bare
name is on PATH; `toolbelt doctor codex-fleet --smoke` runs the offline contract tests.
