# Set up the belt with Claude Code

Paste everything below the line into Claude Code (any directory) and it will install this belt
into `~/Toolbelt` and walk you through every tool. It takes an hour or two at your own pace; you
can stop anywhere and say "continue the toolbelt setup" later.

---

You are setting up my personal toolbelt: the public repo https://github.com/RobGruhl/Toolbelt-Shared,
installed at `~/Toolbelt`. Walk me through installing and validating every tool in it, one at a
time, on this Mac.

**Start**

1. If `~/Toolbelt` doesn't exist, `git clone https://github.com/RobGruhl/Toolbelt-Shared.git ~/Toolbelt`.
   If it exists, check that its `origin` is that repo and `git pull`. If it's something else,
   stop and ask me.
2. Read, in order: `~/Toolbelt/CLAUDE.md`, `docs/PERSONAL-SETUP.md`, `docs/UW.md`,
   `skills/toolbelt/SKILL.md`, and skim `SENSIBILITIES.md`. Before you touch a tool, read that
   tool's own `CLAUDE.md`. Those files are the rules; this prompt doesn't replace them.
3. Run `./bin/toolbelt list` and show me the tools grouped as in the plan below, with one line on
   what each does for me.

**Rules for the whole setup**

- **You never pass `--yes`, `--force` or `--attached-writes` yourself, and you never answer a
  confirmation prompt for me.** Show me the preview; I decide.
- **`toolbelt setup <tool>` needs a real terminal and refuses to run from your shell.** Give me
  the exact command to paste into a separate Terminal window, wait for me to say it's done, then
  run the doctor yourself to check.
- **Never ask me to paste an API key, password, token or sign-in link into this chat**, and never
  print one. Keys go into the 600-mode file or Keychain item the tool's `CLAUDE.md` names, using
  a command I run myself (for example the `pbpaste` one-liner in PERSONAL-SETUP.md §8).
- **Installs:** Homebrew for system tools and runtimes (`brew install …`), and each tool's own
  local `npm`/`poetry` environment through `toolbelt setup`. No `sudo`, no global `pip`, no
  `npm install -g` for libraries, no `curl … | bash`. Homebrew's own installer from brew.sh is the
  one exception, and I run it.
- **Nothing that costs money or sends anything to another person** without showing me the preview
  first and getting my yes for that specific thing.
- **One tool at a time, smallest step first.** If something fails twice, stop and show me the
  doctor's `fix:` line and its `summary` line. Don't work around a failure.
- Don't edit the repo's files to make a check pass. If a tool seems broken, tell me and keep a
  note for my dad.

**Plan**

*Phase 0, prerequisites.* Check, and give me the `brew` commands for anything missing:
Homebrew, git, Node 24 or newer, `uv`, Python 3.13 (`brew install python@3.13`), `pipx` then
`pipx install poetry`, ffmpeg, and Google Chrome. Then Phase 1.

*Phase 1, the belt itself.* Have me run `./bin/toolbelt setup toolbelt` in Terminal, then run
`./bin/toolbelt doctor repo-integrity` and `./bin/toolbelt doctor toolbelt`. Explain the
summary line. Failures for tools we haven't set up yet are expected.

*Phase 2, the ones I want first, in this order:*
1. `imessage`: Messages in iCloud on, Full Disk Access for the app I'm running you in, restart
   that app, then `node imsg.mjs chats --limit 10`. Show me only chat names and dates, not
   message text.
2. Gmail and Google Calendar through claude.ai's connectors (PERSONAL-SETUP §4). I connect them in
   claude.ai settings; you confirm with a calendar read. Use my personal Google account, not my
   @uw.edu one (UW.md).
3. UW feeds (UW.md §1): walk me through subscribing to my Canvas Calendar Feed and the UW
   academic calendar in Google Calendar. I add them in the browser; you check they show up.
4. `slack`: ask me which workspace first.
5. `playwright`: isolated browser smoke test, then explain CDP attach to my real Chrome without
   doing it. Also tell me how to install Claude in Chrome.
6. `openai-image` (PERSONAL-SETUP §8): API billing is separate from my ChatGPT Plus. Walk me
   through billing, verification and the key file, then preview one `low` image, show me the
   preview, and only run it if I say yes.
7. `codex-fleet`: it bills my ChatGPT Plus plan, no API key needed. Check that the Codex CLI is
   installed and signed in, then do the smoke test only.
8. `elevenlabs` (PERSONAL-SETUP §9): Keychain key, install, ask me about the narration hook,
   then one short `speak` after I say yes.
9. `perplexity` (PERSONAL-SETUP §10): API credit with auto top-up off, the key file, then one
   `search --explain` and one real search after I say yes.

*Phase 3, everything else.* For each remaining tool, tell me in one line what it does and what
it needs (a paid account, an app registration, a device), and ask: set up now, skip, or later.
Set up the ones I pick the same way. Expect these:
- **Free and local:** `youtube-transcript`, `transcription` (local whisper by default), `print`,
  `caffeinate`, `hot-bag`, `claude-ding`, `spiral-book`, `example-readonly`, `example-write`
  (the examples teach how the gates work), `gmail-filters`.
- **Need my own paid API key:** `firecrawl`, `runway-ai`, `oracle`
  (OpenAI), `video-rename` (Anthropic API, separate from my Claude subscription).
- **Need an account or app registration:** `nordvpn` (a NordVPN account), `outlook-harvest` (a
  Microsoft app registration), `gmail-harvest` and the `google-workspace` connector (my own Google
  Cloud OAuth client; skip these unless the claude.ai connectors aren't enough), `blender`
  (Blender installed).
- **Skip:** `example-mcp` (a placeholder) and `repo-integrity` (done in Phase 1).

**Validate each tool the same way**

1. `./bin/toolbelt doctor <tool> --smoke`: read the checks, explain any warning in plain words.
2. The "first read" from the tool's `CLAUDE.md` `## Read first`, a read only.
3. One line to me: ✅ ready, ⚠️ ready with a caveat (which), or ⏭️ skipped (why).

**Finish**

1. A table of every tool: status, what's left, and the one command or click to finish it.
2. Run a real "texts to calendar" pass (PERSONAL-SETUP §7): read my group chats from the last 3
   days, list anything with a date, and create only the events I pick, in my personal Google
   Calendar. Re-read the calendar afterwards to confirm.
3. Tell me how to update later (`cd ~/Toolbelt && git pull`, then `./bin/toolbelt doctor`).
