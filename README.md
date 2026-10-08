# Toolbelt

A starter kit for a **toolbelt**: one repository that holds the command-line tools you and your
coding agent use to reach the systems at your company, the contract that keeps those tools safe,
and a doctor that takes a machine from unzip to working. You are reading the kit; the copy you
just unzipped is **your belt**.

**The Why, in one sentence:** the official MCP servers are correct but conservative — an LLM
round-trip per read, interactive-only registration, a server to babysit — so a belt vendors more
permissive, headless-capable tools and makes them safe **by contract instead of by timidity**.
The contract is [SENSIBILITIES.md](SENSIBILITIES.md): thirteen patterns with read-first and
human-gated writes at the core. The recurring design move is **narrowing-as-safety**: a tool
drops the write verbs it does not need to earn a hard byte or row ceiling; a read-only tool has
no write code to misuse. Permissiveness is earned by politeness and gates, never assumed.

The kit ships two example tools whose only job is to be copied and then deleted —
`tools/example-readonly` (CLI `exr`, a read-only tool) and `tools/example-write` (CLI `exw`, a
tool with one gated write) — and one real vendored tool, `tools/slack`, as a worked instance of a
read-first tool with tiered writes against a system most companies have. Everything that
describes them — the belt table below, [SYSTEMS.md](SYSTEMS.md), [docs/RISK.md](docs/RISK.md) —
is rendered from their `toolbelt.json` manifests, which is how every tool you add will be
described too.

## Quickstart

Setting this belt up on your own Mac for your own texts, mail and calendar? Follow
[docs/PERSONAL-SETUP.md](docs/PERSONAL-SETUP.md) instead of this section, or paste
[docs/SETUP-WITH-CLAUDE.md](docs/SETUP-WITH-CLAUDE.md) into Claude Code and let it walk you through.

Requirements: Node >= 18 (`brew install node` on macOS; `winget install OpenJS.NodeJS.LTS` on
Windows, where every `./bin/toolbelt` below is `bin\toolbelt.ps1`). The doctor has no
dependencies beyond Node. Optional: `pipx install detect-secrets` for the pre-commit secret gate
`setup toolbelt` offers.

```sh
cd toolbelt-starter                 # wherever you unzipped it
git init && git add -A && git commit -m "toolbelt: starter kit 0.1.0"
./bin/toolbelt setup toolbelt       # pre-commit secrets hook, router skill link, offered read-tier permissions — every step asks first
./bin/toolbelt doctor               # pre-flight: platform, runtimes, deps, auth state (metadata only), manifest integrity — exit 0; warnings on the placeholder connector and optional tokens are expected
./bin/toolbelt list                 # what's in the belt
```

On Windows the entry point is `bin\toolbelt.ps1` with the same verbs (`bin\toolbelt.ps1 doctor`).
A fresh kit's doctor exits 0 with warnings, not all-green: the placeholder connector URL is
unreachable by design, the optional GitHub token is absent, and the router skill is not linked
until `setup toolbelt` has run at a terminal.

Then try the two examples. Each tool's `CLAUDE.md` is its agent contract; its `## Read first`
block names the first read to try and every write's gate:

```sh
./bin/toolbelt doctor example-readonly --smoke
./bin/toolbelt doctor example-write --smoke
cat tools/example-readonly/CLAUDE.md
cat tools/example-write/CLAUDE.md   # the write verb: preview first, then a loud flag; from an agent it stages and you `toolbelt approve`
```

Or conversationally, once `setup toolbelt` has linked the router skill into your coding
agent: say *"set up my tools"* and the agent walks you through every doctor fix.

## What's in the belt

<!-- belt-table:begin — derived from toolbelt.json manifests; edit hits/surface there, then bin/toolbelt readme --write -->
| | Tool | Hits | Surface |
|---|---|---|---|
| 🔧 | `tools/caffeinate` (`caff`) | macOS power management (caffeinate / pmset, this machine only) | CLI `caff` + `lib/caffeinate.sh`. `status`/`assertions` are free. `start`, `stop`, `run` preview and exit 0 until re-run with `--yes` (flag tier: own process, reversible). Every `start` carries a timeout (default 1h, 8h code ceiling, no forever). `stop` signals only a PID recorded in its own registry that `ps` still reports as caffeinate; there is no stop-all/pkill verb. Audit line to stderr and data/audit.log on every mutation. |
| 🔧 | `tools/claude-ding` | Claude Code hooks on this Mac (afplay; local audio only) | two bash scripts the hooks in ~/.claude/settings.json run; every verb is read tier — a script picks a WAV and plays it through afplay; no file, setting, or network is touched. CLAUDE_DING_MUTE=1 is the dry run, CLAUDE_DING_VOLUME the only knob |
| 🔧 | `tools/codex-fleet` (`codex-fleet`) | OpenAI Codex CLI (ChatGPT plan, or the operator's OPENAI_API_KEY with --api) | bash CLI. Default fleets run workers in Codex's read-only sandbox and bill the ChatGPT plan; `--explain` prints the plan and launches nothing; `-w` / `-s workspace-write` / `-s danger-full-access` / `--net` preview and exit 0 until re-run with `--yes`; `--api` is the loud flag for metered billing; MAX_JOBS=50 and MAX_CONCURRENCY=16 are code constants; an audit line per fleet to stderr and data/audit.log |
| 🔧 | `tools/elevenlabs` (`agent-voice`) | ElevenLabs (TTS API, your own account) | CLI + a 127.0.0.1 HTTP server. `speak` is paid per character: refused above MAX_CHARS=1000 (code constant, server-side 422), `--yes` above 400 chars, every TTS call writes an audit line with the char count to stderr and ~/.local/state/agent-voice/audit.log. `voices` reads. `voice-add` creates a voice in the account only with `--yes`. `setup` writes ~/.claude (hook + settings) only with `--yes` after a preview; no delete verb exists; plus Eleven Music composition (`music`, paid, --yes) |
| 🔧 | `tools/example-readonly` | GitHub (public API) | read-only CLI; GET only, no write code exists |
| 🔧 | `tools/example-write` (`exw`) | a local notes file + a simulated shared board | CLI. Reads are free. `note add`/`note rm` touch only the operator's private file and run at once, printing their own undo. `board post` treats shared-board.txt as something other people see: at a terminal it previews and exits 0 until re-run with --yes; with no terminal (an agent) it stages the payload under ~/.local/share/exw/pending/ and reports `toolbelt approve example-write <code>`. `board clear` makes the operator type the word "clear" on /dev/tty; --force skips the word only where /dev/tty opens, never from a pipeline; there is no --yes. Every write prints an audit line to stderr and then re-reads the file and reports the diff. |
| 🔧 | `tools/firecrawl` | the public web via Firecrawl (api.firecrawl.dev) | read-only CLI (`fc`) and `lib/firecrawl.js`; search/scrape/batch run at once under in-code ceilings (20 results, 20 URLs, 1s delay floor); `crawl` previews its page/credit estimate and runs only with an explicit `--yes`, hard-capped at 50 pages in code; an audit line per HTTP request; no write, extract, map, webhook or account verb exists |
| 🔧 | `tools/gmail-filters` (`gmf`) | Gmail filters (local plan + importable XML) | local-only CLI; no Gmail API client, no OAuth, no write scope; `plan` writes a 600-mode plan file, `export` writes approved rows only as mailFilters.xml the operator imports by hand; one non-zero-touch message blocks a sender; trash needs a policy match plus a second approval; never overwrites, never writes into `/`, `$HOME` or the belt; `--live` counts via read-only `gmh list`; `unsub-plan` classifies unsubscribe methods from export headers; `unsubscribe` sends RFC 8058 one-click POSTs only for an operator-signed approval list, previewing until the operator's `--yes`; audit log |
| 🔧 | `tools/gmail-harvest` (`gmh`) | Gmail API (bulk / byte-exact export) | read-only CLI; scope gmail.readonly only, GET only, no write code exists; `export` writes .eml files only to a directory the operator names (never `/`, `$HOME`, or the belt); 5000-message ceiling in code, `--explain` pre-flight, audit log; `links` prints exact hrefs from one exported .eml (local, no network) |
| 🔧 | `tools/hot-bag` | this Mac's power management (`pmset disablesleep`) + thermal/battery/tether telemetry | CLI. `status`/`report` are free. `start`/`on` previews the plan and takes a typed "yes" on /dev/tty before `sudo pmset -a disablesleep 1`; there is no --yes; with no terminal it stages and prints `toolbelt approve hot-bag <code>`. `stop`/`off` and `doctor` restore sleep and are deliberately ungated. The watchdog's exit trap attempts a passwordless restore and audits the outcome; every pmset mutation is one line in ~/.local/state/hot-bag/audit.log |
| 🔧 | `tools/imessage` (`imsg`) | this Mac's Messages database (~/Library/Messages/chat.db) and local Contacts; Messages.app via AppleScript for send | CLI. Reads open chat.db and the Contacts stores read-only (node:sqlite `readOnly`): `chats`, `history`, `search`, `whois`, `watch`, and `export` to a new 600-mode JSONL file. `send` previews the resolved recipient, service, prior history and text, then needs the word "send" typed at /dev/tty; `--yes` skips the word only where /dev/tty opens. With no terminal (an agent) the message is staged under ~/.local/share/imessage/pending/ and goes out only through `toolbelt approve imessage <code>`. After a send the tool re-reads chat.db until the outgoing row appears. No delete, edit, unsend, attachment or bulk-send verb exists. |
| 🔧 | `tools/nordvpn` | NordVPN (via Tunnelblick on this Mac) | CLI. `status`/`servers`/`countries`/`configs` read; `connect`/`disconnect` print a preview and exit 0 until re-run with `--yes` (flag tier: the tunnel is this machine's own and reversible), then append to `data/audit.log`; no account, billing, or server-side verb exists |
| 🔧 | `tools/openai-image` (`oimg`) | OpenAI Images API + Responses API (paid, the operator's own key) | CLI only. `models` is free. `generate`/`edit`/`responses` preview (model, size, quality, n, estimated cost, output files) and exit 0; `--yes` runs the paid call; output is contained in `--out`, never overwritten; n <= 4 and an estimated $2.00 per call are code constants; an audit line per image on stderr and in ~/.local/share/openai-image/audit.log; a 24h hard ask: when real spend (audit-log tokens at TOKEN_RATES) over the last 24h plus this call would pass $50 (+ human allowances), --yes stops with exit 3 and the caller asks the operator; after they acknowledge an amount, `oimg allow --usd N --note "<their words>" --yes` raises the line for 24h; `spend` reports real spend for free |
| 🔧 | `tools/oracle` | OpenAI (Responses API, gpt-5.5-pro) — the operator's own API key | CLI + the `ask-the-oracle` Claude Code skill (a symlink into this dir). `estimate`, `status`, `retrieve`, `list`, `cleanup` are free reads; `submit`/`ask` are the paid send: estimate + file list + sensitive-file warning first, then yes on /dev/tty or an explicit `--yes` a human supplied; with no terminal (or `--json`) exit 7 and the `--yes` re-run, nothing sent. Code-level $10 per-request ceiling; audit line per send to data/audit.log; packed source and history stay under data/ (mode 600), never /tmp |
| 🔧 | `tools/outlook-harvest` (`omh`) | Microsoft Graph mail (personal Outlook.com / Hotmail; bulk / byte-exact export) | read-only CLI; Graph permission Mail.Read only, GET only, no write code exists; device-code sign-in (phone-friendly); `export` writes .eml files only to a directory the operator names (never `/`, `$HOME`, or the belt); index.jsonl in gmh's shape (gmf unsub-plan, gmh links and jev-test read it unchanged); 5000-message ceiling in code, `--explain` pre-flight, audit log |
| 🔧 | `tools/perplexity` (`pplx`) | Perplexity API (web search) | read-only CLI `pplx search` / `pplx agent` + importable `lib/perplexity.js`; both endpoints only read the web; spend bounded by code ceilings (20 results, 4096 output tokens), `--explain` prices a call before it is made, one audit line per paid request |
| 🔧 | `tools/playwright` (`hp`) | any web page (an open-world browser); optionally a running Chrome over CDP | CLI `hp` + `lib/playwright.js`. Reads (snapshot/screenshot/pdf/console/network/storage reads) are free. Page actions and navigations (open/goto/reload/go-back/go-forward included) run free on the isolated profile and need the loud bare `--attached-writes` on any attached session; `open` on an attached session is refused. `connect` to a real profile (`--cdp=chrome`, a foreign endpoint, `--extension`) makes the human type the target back at /dev/tty, or stages for `toolbelt approve playwright <code>`; an endpoint `launch-debug` opened (tool-owned profile) attaches ungated, but page actions on it need --attached-writes like any attached session. No verb prints a cookie or token value; `kill-all`, `delete-data`, `cookie-get`'s value-printing siblings beyond the listed set are not exposed |
| 🔧 | `tools/print` | the local CUPS daemon (lp/lpstat/cancel/cupsenable) and each printer's own IPP endpoint (ipptool/ippfind) — the operator's paper and toner | CLI only. `printers`/`status`/`jobs`/`options` are free. `send` previews (printer, files, pages → sheets, media, dpi/quality/color, the uncompressed raster per page, the lp line, printer-reported problems) and exits 0; `--yes` runs lp and a watchdog that cancels the job on the Mac and inside the printer and disables the queue if the printer's page count passes the plan; 5 copies / 60 sheets / 5 files per call are code constants; resolution/quality are the printer's own unless asked, and asking warns. `cancel <job>` and `resume` are ungated recovery; `cancel --all` and `unstick` preview then take --yes. An audit line per send/runaway/cancel/unstick/resume on stderr and in ~/.local/state/print/audit.log |
| 🔧 | `tools/repo-integrity` | this repo | doctor-run contract checks: `safeguards[]` and `verbs[]` gate claims verified against code, `auth.principal` honesty (service exceptions and ungated writes named on every run), README / SYSTEMS.md / RISK.md freshness against the manifests, every lockfile directory covered by dependabot.yml or excluded with a reason, no registry credential literal in a tracked file, every skill naming only paths and verbs that exist |
| 🔧 | `tools/runway-ai` (`rwy`) | Runway Dev API (api.dev.runwayml.com; paid, the operator's own credits) | CLI only. `models`, `balance`, `usage`, `task` read. `image`/`video`/`audio` preview (endpoint, model, ratio, duration, credits, output paths) and exit 0; `--yes` submits the task, waits for it, and downloads every output into `--out`; 120 credits per call and 4 images per call are code constants; an audit line per paid task on stderr and in ~/.local/share/runway-ai/audit.log |
| 🔧 | `tools/slack` | Slack | MCP read tools + CLI (search, export, read-only file download); `send`/`react`/`edit`/`invite`/`add-emoji` preview then confirm at /dev/tty or `--yes` after a human approved the preview; `upload-file.mjs` is `--yes`-only; `create-channel` requires typing the channel name back with no `--yes`; no delete/kick/archive verb exists |
| 🔧 | `tools/spiral-book` | the local filesystem (one book project directory) | CLI + a Claude Code skill that routes through it. `check`/`plan`/`build`/`impose` are reads (build and impose regenerate derived files inside the named project); `scaffold` is containment-gated (creates files only under the named dir, refuses to touch existing ones, `--force` replaces template files and still never a chapter); `clean` deletes generated files only with `--yes`. Nothing reaches the network or a credential. |
| 🔧 | `tools/transcription` (`transcribe`) | local whisper.cpp (Voice Mode :2022); OpenAI speech-to-text on opt-in | CLI only. `run <file>` is local and free. `run --backend openai` sends the audio off-host and bills your OpenAI account: ffprobe duration → estimate → refused above `--max-usd` (default $1.00) without `--yes`; `--explain` prints the plan and calls nothing; every request appends a line to ~/.local/state/toolbelt/transcribe.log. No write to any shared system exists. |
| 🔧 | `tools/typesafe-jev` (`jev`) | TypeSafe API (api.typesafe.ai; paid per input token, the operator's own key) | CLI only. `models` lists the names the key may send (free); `ask` POSTs one evaluation to /v1/systemone under code ceilings (96 KB state, 200 KB request, 32 questions, 255 options, 2–10 levels) with the model pinned to jev-1.13.0; `--explain` shows the request and its estimated cost without calling; `usage` totals the local audit log. No write exists on the service |
| 🔧 | `tools/video-rename` | local video files + the Anthropic API (paid, the operator's own key) | CLI. `analyze` samples frames, asks Claude, prints the plan and saves it (paid; audit line per call; --explain estimates cost with no call). `rename` previews by default and renames only with --yes — or replays a saved plan with `--plan FILE --yes` at no API cost; never overwrites; audit line per rename. Every rename lands in renames.jsonl and `undo --yes` reverses it. In-code ceilings on frames (16) and files per run (25 default, 200 max). |
| 🔧 | `tools/youtube-transcript` (`yt`) | YouTube (public captions) | read-only CLI; two read backends (InnerTube scrape, `yt-dlp --skip-download`); writes only a local file the operator names with `--out`, never over an existing one without `--force`; no YouTube write code exists |
| 🔌 | `connectors/blender` | Blender (3D modeling, scenes, rendering via blender-mcp) | MCP stdio server (`uvx blender-mcp`) connecting to Blender's socket on localhost:9876; scene/object inspection and viewport screenshots (read); arbitrary Blender Python execution and 3D modeling/assets (ungated write) |
| 🔌 | `connectors/example-mcp` | <Your hosted MCP> | registration only (`toolbelt register example-mcp`, `--write` to merge into ~/.claude.json) — the server's tools appear in-session as mcp__example-mcp__<tool>; no belt code, no belt write path |
| 🔌 | `connectors/google-workspace` | Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks, Apps Script) | registration only (`toolbelt register google-workspace`) — `uvx workspace-mcp==1.25.0 --tool-tier core` runs locally (pinned: verbs[] is a classification of exactly that release) on the operator's OAuth grant and its 45 core tools appear in-session as mcp__google-workspace__<tool>; 25 reads, 20 ungated writes (send_gmail_message, manage_event, modify_sheet_values, update_script_content, …) with no belt code to gate them; the contract is the gate |
| 🎓 | `skills/toolbelt` | this repo | router skill + `toolbelt setup toolbelt` (hooks, detect-secrets, skill symlink, offered read-tier permission profile) |
<!-- belt-table:end -->

## Make it yours

[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) is the literal walkthrough: copy
`tools/example-readonly`, rename it, write the manifest and the `CLAUDE.md`, go green under the
doctor, re-render the derived docs, commit. It continues with how to add a write verb at the
right tier and how to add a connector for an MCP server that runs elsewhere.

Once you have a real tool, delete the examples — they are scaffolding, not a roster. Four
places name them, and repo-integrity fails until all four agree:

```sh
git rm -r tools/example-readonly tools/example-write
# then, by hand: remove the two example rows from skills/toolbelt/SKILL.md's routing table,
# drop /tools/example-readonly and /tools/example-write from .github/dependabot.yml, and
# retarget evals/cases/staged-write-hands-approve.json (and its row in evals/README.md) at your own gated tool
./bin/toolbelt readme --write
./bin/toolbelt systems --write
./bin/toolbelt risk --write
./bin/toolbelt doctor repo-integrity
```

Keep `tools/repo-integrity`. It is the check that the manifests do not lie. It fails on: a
`safeguards[]` entry or a `write-gated` verb that claims a `tty`/`typed-echo` gate with no gate
in the code; `auth.principal: "none"` on an entry that declares secret env vars or credential
caches; a derived table (README, `SYSTEMS.md`, `docs/RISK.md`) that drifts from the manifests; a
lockfile directory absent from `.github/dependabot.yml`; a package-registry credential literal in a
tracked file; a skill naming a path or a `toolbelt` verb that does not exist. It warns, by name,
on every `service` principal and every ungated `write` verb. (A credential file sitting in the
tree is caught by `toolbelt doctor toolbelt` — the skill's `secrets.no_tree_secrets` check — and a
`service` principal with no `principal_exception` is a manifest validation error.) An
over-claimed safeguard is more dangerous than an honest "this writes, no gate," because it stops
the next reader from looking.

## The doctor

`bin/toolbelt` is the belt's plumbing (`bin/toolbelt --help` is the full verb list):

| Verb | What it does |
|---|---|
| `list` | every entry, one line each, with its first safeguard |
| `doctor [tool] [--json] [--smoke] [--core]` | pre-flight checks for all tools or one; `--smoke` also runs each tool's `smoke_test` |
| `auth [tool]` | the once-a-day ritual: live-probe every credential, re-arm what needs no human, batch the sign-ins |
| `setup <tool> [--yes]` | guided install; every step is explained and TTY-confirmed and says what yes and no each mean. `--yes` asks once for all steps instead of once per step; a terminal is still required |
| `approve <tool> <code>` | the human's confirm of a write an agent staged — opens `/dev/tty`, shows the exact payload |
| `register <tool> [--write]` | print (or write) the MCP registration for a tool or connector |
| `run <tool> -- <verb …>` | run a tool's `entrypoints.cli` from its directory and log tool + verb + date to this belt's local usage log |
| `usage [--days N]` | what this machine ran, from that log — never shared |
| `readme` / `systems` / `risk` / `creds` `[--write\|--check]` | render README's belt table, `SYSTEMS.md`, `docs/RISK.md`, `docs/CREDENTIALS.md` from the manifests |
| `ask <sketch>` | draft an access request from a sketch's access path; prints it, sends nothing |
| `meter` | the per-session token cost of the always-injected surface (CLAUDE.md files, skill descriptions, MCP schemas), ranked |
| `inspire <tool>` | what a tool's `origin` repo has done since you snapshotted it — a read-only glance, nothing is pulled |

`toolbelt doctor` is deterministic: platform, runtimes, per-tool deps, auth and token state
(metadata only — it never reads a credential), MCP registration, live stdio handshakes. `--json`
for machines, color for humans. Every failure carries a fix command that respects the
[install-hygiene rules](SENSIBILITIES.md#10-install-hygiene): brew, pipx, poetry, npm-local; never
a global `pip` or `curl | bash`.

Exit codes: `0` ok · `1` a check failed · `2` usage · `3` internal error · `4` inconclusive — every
check that ran passed, but some check has no implementation on this platform
(`summary.unimplemented` in the JSON), so the run is not green.

The doctor's own state (the last version it ran as, the `run` usage log) lives outside the tree
under `~/.cache/toolbelt/<hash of this repo's path>/`, so two belts on one machine never share it.

macOS is the tested platform. Windows runs through `bin\toolbelt.ps1`: the belt's verbs work
(`approve`, `run`, `setup` and `auth` spawn through `cmd /c`), but most checks have no win32
implementation yet and report `skip`, so the doctor exits `4` (inconclusive) rather than
pretending. Linux is best-effort and runs the darwin implementations.

## Docs

- [SENSIBILITIES.md](SENSIBILITIES.md) — the design philosophy; the acceptance bar for every tool
- [CLAUDE.md](CLAUDE.md) — the agent contract: the Why plus the invariants to hold when editing this repo
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to add a tool, and the gates a review rejects on
- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) — building your first real tool, step by step
- [docs/MANIFEST.md](docs/MANIFEST.md) — the `toolbelt.json` schema and the built-in check library
- [docs/VENDORING.md](docs/VENDORING.md) — how outside code gets in (tracked files only, through the secret gate); your belt owns it from there
- [SYSTEMS.md](SYSTEMS.md) — system → preferred tool → first read → doctor id (derived; `toolbelt systems --write`)
- [docs/RISK.md](docs/RISK.md) — principal, read-only, destructive, gates, worst case per entry (derived; `toolbelt risk --write`)
- [docs/CREDENTIALS.md](docs/CREDENTIALS.md) — where each tool's key lives, the lookup order, how to set it, and how to find one you already have (derived; `toolbelt creds --write`)
- [sketches/](sketches/) — research dossiers for the systems your belt does not reach yet; build the next tool from its sketch
- [evals/](evals/) — standing task fixtures: the net under any edit to a contract an agent reads
- [CHANGELOG.md](CHANGELOG.md) — what each release changed and what a clone must re-run
- [LICENSE](LICENSE) — MIT
