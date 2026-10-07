# Ask the Oracle (`tools/oracle`)

Deep code analysis by sending a Repomix pack of your code to OpenAI GPT-5.5 Pro and waiting
10–20 minutes for its extended reasoning. Vendored into the Toolbelt from
[RobGruhl/ask-the-oracle](https://github.com/RobGruhl/ask-the-oracle); the belt owns this copy.

> "If I actually have 20 minutes, I will copy-paste my entire repo and I go to GPT Pro, the
> Oracle, for like some questions." — Andrej Karpathy

**The contract an agent reads is [CLAUDE.md](CLAUDE.md).** This file is the quick start.

## Setup

```bash
bin/toolbelt setup oracle      # npm install here; links ~/.claude/skills/ask-the-oracle → this dir
bin/toolbelt doctor oracle     # Node ≥ 18, deps, key reachable, skill linked, api.openai.com up
```

The key is your own OpenAI API key: `export OPENAI_API_KEY=…`, or store it once in the
Keychain with `security add-generic-password -s OPENAI_API_KEY -a "$USER" -w`. No config file
is required; a `.oraclerc` in a project overrides the defaults (`.oraclerc.example`).

## Use

In Claude Code: "ask the oracle to review the auth flow for security issues". The skill runs
`estimate`, shows you the cost and the files, asks, then submits with `--yes` and polls.

From a shell, in the project you want analyzed:

```bash
node ~/Toolbelt/tools/oracle/oracle.js estimate "src/**/*.js"                   # free: tokens, cost, sensitive files
node ~/Toolbelt/tools/oracle/oracle.js submit "src/**/*.js" -- "Review this"    # preview → yes → request id
node ~/Toolbelt/tools/oracle/oracle.js status <id>
node ~/Toolbelt/tools/oracle/oracle.js retrieve <id>
node ~/Toolbelt/tools/oracle/oracle.js ask "src/**/*.js" -- "Review this"       # submit + wait + present
```

`submit`/`ask` ask for a typed `yes` at the terminal; `--yes` skips the question when a human
has already read the estimate. From a pipeline or under `--json` they exit 7 with the `--yes`
command instead of sending. Default ceiling $10 per request.

## Cost

$30/M input, $180/M output (gpt-5.5-pro). A module is cents to a dollar or two; a large pack
reaches the ceiling. The estimate is input plus a heuristic output; reasoning tokens are not
predictable and show in the actual cost on `retrieve`.

## Where things land

`data/` (gitignored, mode 600): `artifacts/` packs, `history/` answers and request manifests,
`audit.log` one line per send (and one `submit-failed` line per attempt the provider rejected). Nothing is written to `/tmp` or to the analyzed project unless
its `.oraclerc` sets `ui.historyPath`.

License: MIT.
