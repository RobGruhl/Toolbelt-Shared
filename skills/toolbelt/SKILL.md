---
name: toolbelt
description: >
  Read, write, or change anything through a tool in this belt — come here first; also "set up
  my tools", "run the doctor", "why isn't X working", "get me ready on a new machine". This
  skill routes you to the one tool and its contract; it does not do the work itself.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[tool] — e.g. /toolbelt exr, /toolbelt (everything)"
---

# Toolbelt — the front door

The belt is the repository this skill is symlinked from; `$TOOLBELT` is its root (if unset, ask
where it was cloned and set it). Nothing in this file is the authoritative list of tools: the
lists are derived from the manifests and read by command, so they are never stale there.

## Route

1. **Which tool?** `"$TOOLBELT/bin/toolbelt" list` — every entry, one line each. If the user
   named a *system* rather than a tool, `SYSTEMS.md` at the repo root maps system → preferred
   tool → first read verb → doctor id. The routing table below is the short form.
2. **Is it live here?** `"$TOOLBELT/bin/toolbelt" doctor <tool> --json`. Read `summary` and the
   failing checks' `fix`. A tool that passes is ready; a tool that was never set up is a quiet
   skip; **a tool that was working and now fails auth is a stop-and-tell** — report which tool,
   what the doctor said, and its fix line verbatim, then wait. Do not work around it unless the
   user has said "best effort" this session.
3. **Read the contract.** `tools/<tool>/CLAUDE.md` (or `connectors/<name>/CLAUDE.md`) is the
   agent contract: its `## Read first` block carries the auth path that works, the first read to
   try, and every write's gate. Read it before the first call, not after.
4. **Act with the tool's own CLI** from its directory. `toolbelt` itself is the belt's plumbing —
   `"$TOOLBELT/bin/toolbelt" --help` is the verb list.

## The rules

- **Read the contract first.** The manifest's `verbs[]` says which tier each verb is; the
  contract says how to call it. Improvising the invocation is how writes happen by accident.
- **Never supply `--yes` or `--force` yourself.** Those flags are the human's acknowledgement.
  Preview (`--explain` or `--dry-run`, whichever the tool's `CLAUDE.md` names), show the user, and let them say the word; only then
  pass the flag, and say in your response that you did.
- **A `tty` / `typed-echo` gate is one you cannot satisfy.** When a tool stages the write
  instead of failing, relay the one line it prints — `toolbelt approve <tool> <code>` — and
  stop. The terminal is the confirmation; do not ask for it again in chat, do not retry the call.
- **Auth failure is stop-and-tell.** Report the tool, the doctor's detail, and its `fix` line
  verbatim. Browser logins and key minting are the human's; never ask for, echo, or store a
  token value.
- **An empty result is unknown, not silence.** "No rows" from a tool that may not be authorized,
  scoped, or pointed at the right place is a question, not an answer. Say what was asked, what
  came back, and what would settle it.
- **Re-read after every write.** A platform's 200 is a claim. Read the record back with the
  tool's own read verb and report what is actually there.
- **Report the doctor's paste-able summary line** when something fails — it carries platform,
  node version, and counts, and nothing private, so the user can hand it to whoever maintains
  the belt.

## The gates are in the tools, not here

Every verb's tier is in its manifest (`verbs[]`: `read`, `write-gated` with its gate, `write`
ungated, `never`) and summarized in `docs/RISK.md`. Honor them as the tool enforces them:

- **`tty` / `typed-echo`** — a human at a real terminal. Hand the human the exact command, or
  the `toolbelt approve` line a staging tool prints.
- **`flag`** — preview first, get approval, then `--yes`/`--force`. The approval is yours to
  collect; the flag is the user's to authorize.
- **`containment`** — the write is bounded by where it can land (an isolated profile, an
  allowlist, a named destination), not by a prompt. Stay inside the default boundary; widen
  only when asked, with the tool's own flag, and say what you widened.
- **`write` (ungated)** — the manifest says so and `docs/RISK.md` names it: show the exact
  command or payload, get approval, run once, read the result back.
- Off-hours and cost gates print their own override; do not pre-empt them.

## Diagnose and fix

`doctor --json` (everything), `doctor --core --json` (the first-week profile), or one tool. Fix
in leverage order — runtime → deps → system → auth → mcp/files — one failure at a time: say what
is wrong in a sentence, show `fix.command` verbatim, ask before anything that mutates, run,
re-check.

- **Installs**: prefer `"$TOOLBELT/bin/toolbelt" setup <tool>` in the user's terminal (confirmed
  per step, with what yes and no each do). A fresh clone starts with `setup toolbelt`.
- **Credentials**: `"$TOOLBELT/bin/toolbelt" auth` probes every credential live and batches the
  sign-ins. Narrate the human's steps, then re-check. A key reported missing is usually stored
  somewhere else: `docs/CREDENTIALS.md` lists each tool's lookup order and how to find an
  existing key by name (Keychain service, `.env` files) — search there before asking the human.
- **MCP registration**: `register <name>` previews; `--write` is the user's to run, at a
  terminal. Restart the client afterwards.
- **Smoke** (`doctor <tool> --smoke`) touches real systems — say so first.

## Routing table

| You need | Tool | First read | Contract |
|---|---|---|---|
| your company's Slack (read, export, gated send/react/edit/invite) | `slack` | `node cli.js whoami` | [tools/slack/CLAUDE.md](../../tools/slack/CLAUDE.md) |
| a read-only example of the shape (what a read-first tool looks like) | `exr` | `node exr.mjs --help` | [tools/example-readonly/CLAUDE.md](../../tools/example-readonly/CLAUDE.md) |
| a gated-write example (stage, `toolbelt approve`, `--yes` tier) | `exw` | `node exw.mjs --help` | [tools/example-write/CLAUDE.md](../../tools/example-write/CLAUDE.md) |
| a hosted MCP server (registration, tiers, no local code) | `example-mcp` | `toolbelt register example-mcp` | [connectors/example-mcp/CLAUDE.md](../../connectors/example-mcp/CLAUDE.md) |
| current web information, web search with citations, research questions | `perplexity` | `node pplx.mjs search "<query>"` | [tools/perplexity/CLAUDE.md](../../tools/perplexity/CLAUDE.md) |
| scrape or crawl a web page / site into markdown (paid; crawl is flag-gated) | `firecrawl` | `node fc.mjs scrape <url>` | [tools/firecrawl/CLAUDE.md](../../tools/firecrawl/CLAUDE.md) |
| a YouTube transcript or captions (no key; `yt-dlp` backend optional) | `youtube-transcript` | `node yt.mjs ytdlp <url-or-id>` | [tools/youtube-transcript/CLAUDE.md](../../tools/youtube-transcript/CLAUDE.md) |
| drive a browser: isolated profile by default, or attach to a running Chrome over CDP (real-profile writes are contained behind a flag) | `playwright` | `node hp.mjs --help` | [tools/playwright/CLAUDE.md](../../tools/playwright/CLAUDE.md) |
| transcribe audio/video — local whisper.cpp by default, OpenAI `gpt-transcribe` on opt-in with a spend ceiling | `transcription` | `poetry run transcribe run <file>` | [tools/transcription/CLAUDE.md](../../tools/transcription/CLAUDE.md) |
| generate or edit an image with OpenAI gpt-image-2 (paid: preview → `--yes`; output dir contained) | `openai-image` | `node gpt-image.mjs --help` | [tools/openai-image/CLAUDE.md](../../tools/openai-image/CLAUDE.md) |
| generate an image or video with Runway (Gen-4.5, Gen-4 Turbo, Muse; paid credits: preview → `--yes`; ≤120 credits per call; output dir contained) | `runway-ai` (`rwy`) | `node rwy.mjs balance` | [tools/runway-ai/CLAUDE.md](../../tools/runway-ai/CLAUDE.md) |
| a typed AI judgment code can act on — yes/no probability, pick one of a set, score on a scale — over text or JSON (TypeSafe Jev; paid per input token, state leaves the machine: `--explain` first) | `typesafe-jev` (`jev`) | `node jev.mjs models` | [tools/typesafe-jev/CLAUDE.md](../../tools/typesafe-jev/CLAUDE.md) |
| speak text aloud / ElevenLabs TTS server / the agent-voice Stop hook / compose a music track or soundtrack with Eleven Music (paid: preview → `--yes`) | `elevenlabs` | `poetry run agent-voice voices` | [tools/elevenlabs/CLAUDE.md](../../tools/elevenlabs/CLAUDE.md) |
| Gmail, Calendar, Drive, Sheets, Docs, Tasks, Apps Script (hosted MCP on your own OAuth grant; writes are ungated — show the payload, get a yes) | `google-workspace` | `toolbelt doctor google-workspace --json` | [connectors/google-workspace/CLAUDE.md](../../connectors/google-workspace/CLAUDE.md) |
| bulk / byte-exact / programmatic Gmail reads or export (raw `.eml` to disk + index, gmail.readonly only; bodies never enter context — use this, not the MCP content tools, for more than a handful) | `gmail-harvest` (`gmh`) | `node gmh.mjs whoami` | [tools/gmail-harvest/CLAUDE.md](../../tools/gmail-harvest/CLAUDE.md) |
| iMessage / SMS on this Mac: conversations, history, search, watch, JSONL export (read-only chat.db); send one message — `/dev/tty` gate, an agent's send is staged for `toolbelt approve imessage <code>` | `imessage` (`imsg`) | `node imsg.mjs chats --limit 10` | [tools/imessage/CLAUDE.md](../../tools/imessage/CLAUDE.md) |
| a digest of group chats: needs you, dates (calendar adds on pick), announcements; the rest skipped | recipe over `imessage` (+ `typesafe-jev` if the user recorded the data decision) | `node imsg.mjs chats --limit 200 --json` | [docs/recipes/group-chat-digest.md](../../docs/recipes/group-chat-digest.md) |
| an inbox digest: Jev sorts every message cheaply, Claude reads only what it flags; replies are drafts | recipe over the Gmail connector + `typesafe-jev` | `node jev.mjs models` | [docs/recipes/gmail-digest.md](../../docs/recipes/gmail-digest.md) |
| turn triage evidence into proposed Gmail filters and export the approved ones as an importable `mailFilters.xml` (no Gmail writes; a sender with any non-zero-touch mail is never proposed; the human imports) | `gmail-filters` (`gmf`) | `node gmf.mjs show --plan <plan.json>` | [tools/gmail-filters/CLAUDE.md](../../tools/gmail-filters/CLAUDE.md) |
| 3D modeling, scenes, rendering, object inspection via Blender (MCP socket server on localhost:9876) | `blender` | `toolbelt doctor blender --json` | [connectors/blender/CLAUDE.md](../../connectors/blender/CLAUDE.md) |
| rename / catalog video files by content (Claude vision + transcript); `--yes` renames, `undo --yes` reverts | `video-rename` | `poetry run video-rename analyze <path> --explain` | [tools/video-rename/CLAUDE.md](../../tools/video-rename/CLAUDE.md) |
| a cheap parallel Codex test fleet (repeat a suite, verify a diff, hunt flakes); any widening (`-w`, `-s workspace-write`) previews until `--yes` | `codex-fleet` | `codex-fleet -n 1 -e low --explain "Run 'true'. Acceptance check: exit status."` | [tools/codex-fleet/CLAUDE.md](../../tools/codex-fleet/CLAUDE.md) |
| a 10–20 min deep code analysis from GPT-5.5 Pro (paid send: estimate → `--yes`; the `/ask-the-oracle` skill is the conversational entry) | `oracle` | `node oracle.js estimate "src/**/*.js"` | [tools/oracle/CLAUDE.md](../../tools/oracle/CLAUDE.md) |
| print a file on this Mac's printers (Brother laser / Epson inkjet): preview → `--yes`; read both queues and diagnose a stuck job; `unstick` | `print` | `node print.mjs printers` | [tools/print/CLAUDE.md](../../tools/print/CLAUDE.md) |
| keep this Mac awake lid-closed for an unattended job, with thermal/battery telemetry (`start` is tty-gated; `stop` never is) | `hot-bag` | `./hot-bag status` | [tools/hot-bag/CLAUDE.md](../../tools/hot-bag/CLAUDE.md) |
| prevent sleep for one command / who holds a power assertion | `caffeinate` | `./caff status` | [tools/caffeinate/CLAUDE.md](../../tools/caffeinate/CLAUDE.md) |
| NordVPN on this Mac: status, servers, connect/disconnect (preview → `--yes`) | `nordvpn` | `poetry run nordvpn status --local` | [tools/nordvpn/CLAUDE.md](../../tools/nordvpn/CLAUDE.md) |
| a spiral-bound book from Markdown (scaffold, build PDF, impose for print; `/spiral-book` skill is the conversational entry) | `spiral-book` | `node spiral-book.mjs check` | [tools/spiral-book/CLAUDE.md](../../tools/spiral-book/CLAUDE.md) |
| Claude Code notification sounds (the hooks in `~/.claude/settings.json`) | `claude-ding` | `CLAUDE_DING_MUTE=1 sounds/play-random.sh` | [tools/claude-ding/CLAUDE.md](../../tools/claude-ding/CLAUDE.md) |
| a system the belt does not reach yet | sketch | `sketches/README.md` index → `toolbelt ask <sketch>` | [sketches/README.md](../../sketches/README.md) |

## Escalation

A check failing twice after its fix → the tool's `toolbelt.json` (`auth`, `safeguards`, `verbs`)
and its contract. "Why is this gated?" → `SENSIBILITIES.md`. Stuck → an issue on the repo.

## Doctor JSON, the parts you read

`summary {pass, warn, fail, skip}`, `ok` (false on any fail *or* when nothing could be checked on
this platform), `inconclusive`, `summary_line`, and per tool `status` plus
`checks[] {id, title, status, detail, fix?{description, command}}`. `warn` is tolerable —
explain, don't block. Auth checks report metadata only.
