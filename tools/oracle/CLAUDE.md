# oracle — the agent contract

## Read first

- **What:** Ask the Oracle. Packs the files you name with Repomix and sends the pack to OpenAI
  GPT-5.5 Pro (Responses API, background mode) for a 10–20 minute deep analysis, billed to the
  operator's own OpenAI account. The `ask-the-oracle` Claude Code skill is a symlink into this
  directory (`skills/ask-the-oracle/`); its `SKILL.md` is the step-by-step for an agent session.
- **Auth:** `$OPENAI_API_KEY` in the environment, else the macOS Keychain generic password
  with service `OPENAI_API_KEY` (`security add-generic-password -s OPENAI_API_KEY -a "$USER" -w`).
  Resolved on the first network call only; `estimate`, `list` and `cleanup` never touch it.
  No `.oraclerc` is required — without one the tool runs on built-in defaults and says so.
- **First read:** `node oracle.js estimate "src/**/*.js"` — packs, counts tokens, prices, lists
  sensitive files, makes no network call.
- **Writes:** `submit` and `ask` are the paid send. They print the estimate, the file list and
  the sensitive-file warning, then take a typed `yes` on `/dev/tty` or an explicit `--yes`. With
  no terminal, or under `--json`, they exit 7 and print the `--yes` re-run; nothing is sent.
  `cancel` stops the operator's own in-flight request and is ungated.
- **Ceiling:** $10.00 per request and a $5.00 warning, in code (`DEFAULT_LIMITS`); a project's
  `.oraclerc` may set other values. Above the ceiling the send is refused before any network.
- **Live here?** `bin/toolbelt doctor oracle` — Node ≥ 18, `npm install`, the key reachable,
  the skill symlink in place.

```bash
node oracle.js estimate "src/**/*.js"                            # dry run: cost, tokens, files, sensitive files
node oracle.js estimate --json "src/**/*.js"                     # the same as an envelope (artifactPath + contextHash for reuse)
node oracle.js submit "src/**/*.js" -- "Review the auth flow"    # preview → yes at /dev/tty → request id
node oracle.js submit --yes --json --artifact=<p> --context-hash=<h> "src/**/*.js" -- "…"   # a human approved the preview
node oracle.js status <requestId>                                # one poll
node oracle.js retrieve <requestId>                              # the answer, saved to data/history/
node oracle.js ask "src/**/*.js" -- "…"                          # submit + wait + present; detaches on timeout
node oracle.js submit --yes --continue=<requestId> -- "Follow-up"   # multi-turn; the server re-bills the earlier context
node oracle.js list                                              # recent request manifests
node oracle.js cleanup                                           # prune packed artifacts older than 24h
```

Exit codes: `0` done · `1` unknown error · `2` config · `3` validation, cost ceiling, or
context too large · `4` provider/API (the attempt is audited as `verb=submit-failed`) · `5`
timeout (`--cancel-on-timeout` only) · `6` remote failed/cancelled · `7` confirmation required —
nothing sent, the `--yes` re-run is in the message (and in `error.details.rerun` under `--json`)
· `8` declined — a human at `/dev/tty` answered anything but `yes`; nothing sent.

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| `estimate`, `status`, `retrieve`, `list`, `cleanup` | read | run freely |
| `submit`, `ask` | write-gated (flag) | run **without** `--yes`: it previews, then exits 7 with the re-run — show the user the estimate, the file list and any sensitive files |
| `submit --yes`, `ask --yes` | — | only after the user, in the conversation, approved *that* estimate and file set — the approval names the files and the cost, not the verb |
| `cancel <id>` | write, ungated | run when the user asks, or when a request the user no longer wants is still billing |

**Never add `--yes` on your own.** The code honors it from anyone — this is private spend on
the operator's account, and refusing a deliberate send would only push the work to an unguarded
path (SENSIBILITIES #2) — which is exactly why the contract has to hold here: a flag you add is
indistinguishable from one the user typed. The skill's flow is estimate (`--json`), show the
numbers, `AskUserQuestion`, then `submit --yes --json` reusing the artifact. An agent session's
shell usually has no controlling terminal, so a bare `submit` stages nothing and asks nothing:
it exits 7 and hands you the re-run.

The preview under `--json` is the `CONFIRMATION_REQUIRED` error envelope:
`error.details.preview` carries `fileCount`, `tokenCount`, `estimatedCost`, `sensitiveFiles`,
`files`, `artifactPath`, `contextHash`; `error.details.rerun` is the exact command with `--yes`.

## What leaves the machine, and what stays

- **Sent to OpenAI:** the packed content of every file the patterns match, plus any
  `--extra-context` files, plus the question. OpenAI retains it per their API policy. The
  sensitive-file warning matches filenames only (`.env`, `.pem`, `.key`, `.p12`, `.pfx`,
  `id_rsa`, `id_ed25519`, `.secret`, `credentials`); a token inside ordinary source is not
  caught. Narrow the patterns rather than trusting the list.
- **Kept under `tools/oracle/data/`** (dir 700, files 600, gitignored; `ORACLE_DATA_DIR`
  relocates it): `artifacts/` — the Repomix packs and their `.manifest.json` sidecars, pruned
  after 24 h by `cleanup` or on the next `estimate`; `history/` — `oracle-<id>.json`, a readable
  `<date>-<slug>.md`, and `manifest-<id>.json` per request; `audit.log` — one line per send and
  per cancel. A project's `.oraclerc` with `ui.historyPath` moves history next to that project
  instead (resolved against the cwd).
- **Audit line** (also on stderr): `<ts> verb=submit provider= model= est_cost= pack_tokens=
  files= sensitive= request= cwd=`. A provider call that fails (401, 429, network) writes the
  same fields as `verb=submit-failed … error=` (first line of the error), and a failed cancel
  as `verb=cancel-failed`, so every attempt is one grep whether or not it was billed. Never the
  question, the pack, or the key.

## Status (2026-08-22)

- The key on this machine is `$OPENAI_API_KEY` exported in the shell, which is what the doctor
  reports as the source. The belt's preferred home is the Keychain (`security
  add-generic-password -s OPENAI_API_KEY -a "$USER" -w`, then drop the export) so the value is
  not in every child process's environment; move it before the tool is shared.
- The interactive `/dev/tty` yes path has been exercised only through the code's shared
  `openSync('/dev/tty')` pattern and the mock-provider test of the `--yes` branch it feeds;
  try it once at a real terminal (`node oracle.js submit skills/ask-the-oracle/SKILL.md -- "test"`,
  answer `no`, expect exit 8).

## Configuration

`.oraclerc` in the **cwd** (the project being analyzed) overrides the built-in defaults;
`.oraclerc.example` here is the template and supports `//` and `#` comments. Nothing requires
it. The fields that matter:

| Key | Default | Meaning |
|---|---|---|
| `providers.openai.apiKey` | `$OPENAI_API_KEY` | a `$VAR` reference (env, then Keychain). A literal key works but puts plaintext in the project; do not |
| `providers.openai.model` | `gpt-5.5-pro` | pricing is pinned per model in `providers/openai.js` ($30/M in, $180/M out) |
| `providers.openai.maxWaitMinutes` | 120 | how long `ask` polls before detaching |
| `providers.openai.useBackgroundMode` | true | server-side queue + polling; `false` blocks on one HTTP call and times out on long reasoning |
| `limits.maxCostPerRequest` / `warnCostThreshold` | 10 / 5 | the ceiling and the warning; a limit above $25 is named in the warnings on every run |
| `repomix.*` | xml, compress, line numbers | what the pack looks like |
| `ui.historyPath` | `data/history` | relocate history (relative to the cwd) |

## Quirks

- **Cost is an estimate of input plus a heuristic output** (40 % of input, 200–8 000 tokens);
  reasoning tokens are billed as output and are not predictable. The actual cost prints on
  `retrieve`. Typical runs land at $0.05–$2; a large pack reaches the $10 ceiling.
- **Continuations cannot be estimated.** `--continue=<id>` chains to a stored response; the
  server replays the earlier context and bills it again as input. The preview says so; the
  gate still applies.
- **`ask` detaches on timeout**; the request keeps running and `status`/`retrieve` pick it up.
  `--cancel-on-timeout` is overridden to detach when the estimate is at or above the warn
  threshold, so a timer never throws away an expensive answer.
- **The `--artifact`/`--context-hash` pair** reuses the pack `estimate` wrote so the send does
  not pack twice; a hash mismatch silently re-packs. A bare `submit` without `--yes` packs once
  for the preview and reuses it for the send.
- **Polling** is 3 s with capped exponential backoff on 429/5xx. `Ctrl-C` during `ask`
  detaches, never cancels.
- **macOS only** in the belt: the Keychain path and `/dev/tty` are what the manifest claims;
  `ttyOpens()` returns false on win32, so a Windows caller always needs `--yes`.

## Layout

`oracle.js` at the root is a shim; the CLI is `skills/ask-the-oracle/scripts/oracle.js`
(presentation: `parseArgs`, `passSpendGate`, output) over `oracle-service.js` (the `Oracle`
class, `OracleError`/`EXIT_CODES`, `DEFAULT_CONFIG`/`DEFAULT_LIMITS`, `audit()`, the data-dir
helpers). `providers/openai.js` is the only provider; `base-provider.js` owns key resolution
(`_resolveApiKey`, `readKeychain`). `cost-calculator.js`, `repomix-wrapper.js`,
`config-validator.js` are what their names say. `npm test` runs `scripts/tests/run-tests.js`
(mock providers, no network, no key; `ORACLE_DATA_DIR` keeps it out of `data/`).
`checks/openai-key.mjs` is the doctor's presence-only key probe.
