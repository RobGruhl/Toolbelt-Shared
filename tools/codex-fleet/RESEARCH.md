# Claude Code + GPT-5.6 Luna test fleets — ecosystem research

Compiled 2026-08-16 from an 8-agent research workflow (190 web lookups; 26 of
29 load-bearing claims verified against primary sources) plus live testing on
this machine. Facts below are current as of that date.

## Economics

- GPT-5.6 Luna API pricing: **$0.20/M input, $0.02/M cached input, $1.20/M
  output**, 1.05M context — after the July 30, 2026 80% price cut (launched
  July 9 at $1/$6). Terra $2/$12, Sol $5/$30. Long-context trap: requests over
  272K input tokens price the whole request at 2× input / 1.5× output.
  (developers.openai.com model pages)
- Anthropic comparison: Haiku 4.5 $1/$5, Sonnet 5 $2/$10 (introductory price
  made permanent Aug 10, 2026), Opus 5 $5/$25, Fable 5 $10/$50. Luna is ~5×
  cheaper than Haiku on input, ~4.2× on output, and its cached-input rate is
  5× cheaper than Haiku's cache reads. Haiku's context is 200K vs Luna's 1.05M.
- On ChatGPT **plan credits** Luna costs 5 in / 0.5 cached / 30 out credits
  per M vs Sol's 125 / 12.5 / 750 — switching fleet work Sol→Luna stretches
  the same plan **~25×**. All Codex surfaces (CLI, cloud, IDE) share one pool.
- OpenAI provisions Luna as the volume model: at API Tier 5 it gets 30K RPM /
  180M TPM vs Sol/Terra's 15K / 40M. A 10–30 worker fleet pushes with the
  grain.
- Reasoning effort is the dominant cost variable: Luna at `max` burns ~9×
  more output tokens (~13.5× total cost) than effort `none` for roughly
  +93% on the Artificial Analysis index. Measured cost per coding task
  (DeepSWE, Aug 13): Luna max $0.61/trial at 67%±4% resolution vs Sol max
  $8.39 at 73%±3%. A run-tests-and-diagnose fleet job at low/medium effort
  costs ~$0.01–0.03 at API rates; measured locally: ~33K input (half cached),
  ~250 output, 10–60s.
- No published benchmark isolates run-tests/verify-diff work for Luna vs
  Haiku 4.5; nearest proxies are DeepSWE (Luna) and vendor-reported SWE-bench
  (Haiku 73.3%). The community consensus role for Luna is "bounded, fully
  specified work with executable acceptance criteria."

## Ecosystem (who is doing this)

- **OpenAI officially ships a Claude Code plugin** (`openai/codex-plugin-cc`,
  ~March 2026, 25.9K stars): /codex:review, /codex:adversarial-review,
  /codex:rescue, with --background. Cross-vendor blessing is asymmetric:
  Anthropic's advisor tool accepts Claude models only; nothing Anthropic-native
  routes to GPT. Bash-wrapped `codex exec` and MCP are the sanctioned lanes.
- **fable-advisor** (DannyMac180): Opus/Fable orchestrate, Luna is the routine
  lane "where specs fully determine outcomes," Fable does mandatory final
  review; explicit vendor-diversity rationale ("models from one family share
  blind spots").
- **cc-orchestrator** (p3nchan): the clearest orchestration playbook — file
  blackboard over MCP/tmux, chunk work under ~25 min, verify by three signals
  (exit code 0 + turn.completed event + expected sidecar file on disk).
- **OrcaRouter Luna-max playbook**: Luna for "test execution and verification
  against defined criteria," mechanical refactors, test writing; bad at
  exploratory/vague work. Failure modes: instruction drift on procedural
  briefs (write outcome-based prompts), ~136s time-to-first-token at max
  effort, ~2× output verbosity.
- **Flake-hunting prior art (OpenWISP)**: agent + parallel bash harness ran a
  suite 25+ times per pass, took a race-condition crash from ~7% reproduction
  to 0 in 90+ runs — "a very patient pair of hands on a spare machine."
- **Cautionary reports**: agents "enshrine bugs in the tests" without an
  independent judge; overloaded staging amplifies flakiness into a
  self-reinforcing loop ("agents can't iterate against a test suite that lies
  to them"); orchestration overhead is real (one report: Claude orchestrator
  spent ~8× the tokens of its Codex workers). Fix determinism before scaling
  worker count.
- Three projects named in earlier ChatGPT-sourced research could **not be
  found**: "Coredo," "multimodels-mcp," "Better-Fullstack" routing policies.
  Treat that thread's specifics as unverified; its architecture conclusions
  match what the verifiable sources say anyway.

## Mechanics that matter (verified locally on codex-cli 0.147.0)

- Headless worker: `codex exec -m gpt-5.6-luna -c model_reasoning_effort=low
  -s read-only --ephemeral --json -o out.txt --output-schema schema.json "..."`.
  exec is implicitly non-interactive in 0.147 (`-a/--ask-for-approval` and
  `--full-auto` no longer exist on exec; `--approve-for-me` is the new opt-in).
- `--json` emits JSONL events; `turn.completed` carries exact
  `usage.{input,cached_input,output}_tokens`. Exit 0 alone is not proof of
  work (codex#19309) — require exit 0 AND turn.completed AND the sidecar file.
- Sandbox: `read-only` blocks all writes including /tmp (fine for unittest,
  breaks pytest/cargo/jest caches); `workspace-write` adds workdir + /tmp;
  network is off by default, enable with
  `-c sandbox_workspace_write.network_access=true`. Worktree gitdirs sit
  outside the writable root, so workers can't `git commit` in linked worktrees.
- No built-in exec timeout, and codex's internal shell-tool timeout orphans
  child processes (codex#4337) — supervisors must kill the process tree.
- `git worktree add --detach` checks out HEAD: uncommitted changes are NOT in
  the worktree unless explicitly applied.
- Auth: ChatGPT-plan OAuth vs API key; an exported OPENAI_API_KEY silently
  overrides OAuth for billing (codex#15151). `CODEX_API_KEY` is an exec-scoped
  alternative for CI. Parallel `codex exec --ephemeral` workers show no
  `~/.codex` contention (5 workers = 1 worker wall clock, verified locally).
- Codex's native subagents (spawn_agent / spawn_agents_on_csv) filter Luna
  out (marked multi_agent_version v1); plain parallel `codex exec` processes
  sidestep this entirely.
- Claude Code's native fleet machinery (20-way subagent concurrency,
  `isolation: worktree`, background agents, dynamic workflows) is strong but
  Anthropic-models-only; Haiku is the in-family cheap lane at 4–5× Luna's
  price. The Codex lane wins on unit price and vendor diversity, not features.

## What was built from this

`codex-fleet` (this repo's `bin/`, symlinked onto PATH; usage in `CLAUDE.md`):
a ~200-line bash wrapper + verdict schema. Design choices trace directly to
findings above: three-signal pass rule, process-tree timeout kill, dirty-diff
propagation into worktrees, plan-billing default with OPENAI_API_KEY stripped,
structured verdicts with mandatory evidence, and guidance that the
orchestrating Claude re-runs decisive checks itself before acting.
