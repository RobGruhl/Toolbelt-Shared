---
name: ask-the-oracle
description: Consult GPT-5.5 Pro for deep code analysis that takes 10-20 minutes of extended reasoning. Use this skill whenever the user asks for architecture review, security audit, debugging complex issues, comprehensive code review, performance analysis, or expert-level analysis across multiple files. Also use when the user says "ask the oracle", "deep dive", "deep analysis", "expert analysis", "consult the oracle", or wants a second opinion from another model. Do NOT use for simple questions you can answer directly.
allowed-tools: Read, Grep, Glob, Bash, AskUserQuestion, Skill
---

# Ask the Oracle

Consult GPT-5.5 Pro as an "Oracle" for complex code questions requiring 10-20 minutes of deep reasoning.

This skill is a symlink into the Toolbelt (`tools/oracle/`); the tool's contract is `tools/oracle/CLAUDE.md`. The one rule that matters here: **`--yes` is the human's approval of a specific estimate and file set. Never add it on your own.** A `submit` without it exits 7 (`CONFIRMATION_REQUIRED`) from an agent shell — that is the preview, not an error to work around.

## JSON API

All `--json` output uses a versioned envelope:

```json
// Success
{ "schemaVersion": 1, "ok": true, "command": "estimate", "data": { ... } }

// Error
{ "schemaVersion": 1, "ok": false, "command": "submit", "error": { "code": "COST_LIMIT_EXCEEDED", "message": "...", "details": {} } }
```

Always check `ok` first. On success, read `data`. On failure, read `error.code` and `error.message`.

## Instructions

### Phase 1: Understand and Select Files

1. Capture the user's question -- what do they want to know, what problem are they solving?
2. Use Glob to identify relevant files matching the question scope
3. Ask user to confirm file selection using AskUserQuestion -- present count, let them refine

### Phase 2: Estimate Cost

Run the estimate command to get structured data:

```bash
cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js estimate --json <patterns>
```

Parse the JSON envelope. On success, read from `data`:
- `data.fileCount`, `data.tokenCount` -- scope metrics
- `data.estimate` -- cost breakdown
- `data.limitCheck` -- whether cost is within limits
- `data.sensitiveFiles` -- files that will be sent to a third party
- `data.tokenCheck` -- token limit check: `withinLimit`, `headroom`, `message`
- `data.artifactPath` -- path to pre-packed artifact (pass to submit to avoid double-packing)
- `data.sidecarPath` -- path to artifact sidecar manifest (metadata for fast reuse)
- `data.contextHash` -- hash to validate the cached artifact

If `data.sensitiveFiles` is non-empty, warn the user that those files will be sent to a third party.

### Phase 3: Confirm with User

1. GPT-5.5 Pro pricing: $30/M input, $180/M output. Typical cost: $2-10.
2. If cost > $5 warn the user. If cost > configured limit, don't proceed without approval.
3. Confirm with user: show estimated cost, remind them it takes ~10-20 minutes.

### Phase 4: Submit and Auto-Poll

Submit the question, reusing the packed artifact from estimate:

```bash
cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js submit --yes --json \
  --artifact=<artifactPath> --context-hash=<contextHash> \
  <patterns> -- "<question>"
```

The `--artifact` and `--context-hash` flags reuse the packed context from estimate, avoiding a second Repomix pass.
The `--yes` flag is the record that the user approved this estimate in Phase 3 — pass it only then. Without it (and with no terminal) the command exits 7 with `error.code = "CONFIRMATION_REQUIRED"`, `error.details.preview` (the estimate) and `error.details.rerun` (the exact `--yes` command): show those to the user and ask; do not retry on your own.
Every send appends an audit line to `tools/oracle/data/audit.log`; a send the provider rejected appends a `verb=submit-failed` line.

Parse the envelope. On success, read `data.requestId`.

Tell the user immediately:
> "Oracle consultation submitted to GPT-5.5 Pro (Request ID: <id>). Polling every minute for completion."

Then **immediately** invoke the `/loop` skill via the Skill tool to auto-poll, passing the request ID and project root in the loop prompt so each tick has the context it needs:

```
Skill({
  skill: "loop",
  args: "1m Check Oracle status for request <requestId>. Run `cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js status --json <requestId>` and parse the envelope. If data.status is 'completed', run retrieve (see Phase 6), present results, then call CronList to find the job whose prompt mentions '<requestId>' and CronDelete to stop the loop. If data.status is 'failed' or 'cancelled', report briefly and stop the loop the same way. Otherwise (queued/in_progress), report status in one line and let the next tick fire."
})
```

The loop is session-only — it dies when Claude exits. That is the right scope: the user is waiting for results in this session anyway.

### Phase 5: Check Status (per loop tick or on demand)

Whether fired by a /loop tick or by the user asking, status is checked the same way:

```bash
cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js status --json <requestId>
```

Report `data.status`: `queued`, `in_progress`, `completed`, `failed`, or `cancelled`.

If you were fired by a loop tick (the prompt mentions a specific requestId), see Phase 4 for the cancellation logic — terminal states must call CronDelete to stop further ticks.

### Phase 6: Retrieve and Present Results

When status is `completed`:

```bash
cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js retrieve --json <requestId>
```

Read `data.output`, `data.usage`, and `data.cost`.

Summarize key findings, highlight actionable recommendations, show cost/time, ask about follow-ups.

### Error Handling

All errors return an envelope with `ok: false`. Check `error.code`:

| Code | Exit | Meaning |
|------|------|---------|
| CONFIG_NOT_FOUND | 2 | (no longer raised — a missing `.oraclerc` means built-in defaults) |
| CONFIG_INVALID | 2 | Config validation failed |
| CONFIG_PARSE_ERROR | 2 | JSON parse error in `.oraclerc` |
| NO_PROVIDER | 2 | No providers configured |
| VALIDATION_ERROR | 3 | Missing patterns/question, no files matched |
| COST_LIMIT_EXCEEDED | 3 | Cost exceeds configured limit -- suggest reducing file scope |
| CONTEXT_TOO_LARGE | 3 | Input tokens exceed provider's context window -- reduce file scope |
| PROVIDER_ERROR | 4 | API error from provider -- check API key, connectivity |
| TIMEOUT | 5 | Polling exceeded maxWaitMinutes (only with `--cancel-on-timeout`) |
| REMOTE_FAILED | 6 | Provider returned failed |
| REMOTE_CANCELLED | 6 | Provider returned cancelled |
| CONFIRMATION_REQUIRED | 7 | `submit`/`ask` ran without `--yes` and no human was at a terminal — nothing sent; `details.rerun` is the approved command |
| DECLINED | 8 | a human at the terminal answered anything but `yes` — nothing sent (human mode only, no envelope) |

To cancel: `node ${CLAUDE_SKILL_DIR}/scripts/oracle.js cancel <requestId>`

## Multi-Source Workflow

When a question involves code from a different repository, design documents, research notes, or other prose alongside code, use `--source-dir` and `--extra-context`:

### `--source-dir=<path>`
Pack code files from a directory other than the current working directory.

### `--extra-context=<file>` (repeatable)
Prepend additional files (design docs, research, prose) before the packed code. Can be specified multiple times.

### Examples

**Cross-repo analysis** — analyze code in another project:
```bash
cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js estimate --json \
  --source-dir=$HOME/Projects/other-repo "src/**/*.cs"
```

**Code + design docs** — include design documents alongside code:
```bash
cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js ask --yes --json \
  --source-dir=$HOME/Projects/target-repo \
  --extra-context=$HOME/Projects/target-repo/docs/architecture.md \
  --extra-context=$HOME/Projects/target-repo/docs/design-decisions.md \
  "src/**/*.ts" -- "Evaluate this architecture"
```

**Extra-context only** — no code, just documents for analysis:
```bash
cd <project-root> && node ${CLAUDE_SKILL_DIR}/scripts/oracle.js ask --yes --json \
  --extra-context=/tmp/research-notes.md \
  --extra-context=/tmp/technical-spec.md \
  -- "Analyze these documents and identify gaps"
```

### Workflow for multi-source questions
1. Write any prose/research to temporary files (e.g., `/tmp/research.md`)
2. Use `--source-dir` to point at the target codebase
3. Use `--extra-context` (repeatable) for each supplementary document
4. File patterns still work normally (resolved against `--source-dir`)
5. Extra-context content is prepended before packed code in the context sent to the provider
6. Token counting and cost estimation cover the full combined context

## Important Notes

- **Cost**: Typically $0.05-$2 per request depending on codebase size and response length
- **Time**: 10-20 minutes (GPT-5.5 Pro extended reasoning)
- **Privacy**: Code is sent to OpenAI (retained per their policy)
- **What stays local**: packed artifacts, history and the audit log live under `tools/oracle/data/` (mode 600, gitignored), not in the project and not in /tmp. See `tools/oracle/CLAUDE.md`.
- **History**: `tools/oracle/data/history/` (a project's `.oraclerc` `ui.historyPath` relocates it)
- **Config**: optional `.oraclerc` in the project root (see `tools/oracle/.oraclerc.example`). Without one: gpt-5.5-pro, key from `$OPENAI_API_KEY` or the Keychain, $10 per-request ceiling. Supports `//` and `#` comments.

## Configuration

A `.oraclerc` in the project root overrides the defaults (it is optional):

```json
{
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "apiKey": "$OPENAI_API_KEY",
      "model": "gpt-5.5-pro",
      "enabled": true
    }
  },
  "limits": {
    "maxCostPerRequest": 10.00,
    "warnCostThreshold": 5.00
  }
}
```

