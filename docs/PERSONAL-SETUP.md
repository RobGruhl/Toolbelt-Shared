# Personal setup — your own Mac, your own accounts

This is the walkthrough for someone who was handed this belt to run on their own Mac for their
own life: texts, mail, calendar. It is not the kit tour ([README](../README.md)) or the guide to
building a tool ([GETTING-STARTED](GETTING-STARTED.md)). Every credential below is yours; the
belt holds none of them, and nothing here reaches anyone else's accounts.

Several tools need a paid account of your own (image, voice, search, transcription APIs). You
do not need them. Set up only the ones you use; the doctor reports the rest as not set up, which
is fine.

## 1. Install the basics

```sh
brew install node uv            # Node 24 or newer (the iMessage tool needs it); uv for Python tools
brew install --cask claude-code  # if Claude Code is not installed yet
node -v                          # v24 or newer
```

No Homebrew yet? Install it from [brew.sh](https://brew.sh) first. Install tools with `brew`,
`pipx` or inside a project; never `sudo pip` or a `curl … | bash` you have not read.

## 2. Clone and run the doctor

```sh
git clone https://github.com/RobGruhl/Toolbelt-Shared.git ~/Toolbelt
cd ~/Toolbelt
./bin/toolbelt setup toolbelt     # secrets hook, links the router skill into Claude Code; each step asks first
./bin/toolbelt doctor imessage    # just the tools you want, one at a time
```

A bare `./bin/toolbelt doctor` checks every tool and fails the ones you never installed. That is
expected; read it per tool instead.

From here you can also open Claude Code in `~/Toolbelt` and say **"set up my tools"**. The
router skill walks you through each doctor fix and asks before changing anything.

## 3. iMessage and SMS (`tools/imessage`)

The tool reads the Messages database on this Mac, so the Mac must have your texts:

1. **Messages in iCloud** on, on the phone (Settings › your name › iCloud › Messages) and on the
   Mac (Messages › Settings › iMessage › Enable Messages in iCloud). Without it the Mac holds only
   what arrived while it was signed in.
2. **Full Disk Access** for the app that runs Claude Code: System Settings › Privacy & Security ›
   Full Disk Access › add Terminal (or iTerm, Ghostty, or the Claude app if you run Claude Code
   there), switch it on, then quit and reopen that app. macOS never shows a prompt for this; if
   the database "won't open", this is why. Turn it on for the app you actually run Claude Code in.
3. Prove it:

   ```sh
   cd ~/Toolbelt/tools/imessage
   node imsg.mjs chats --limit 10
   ```

Group chats are named by chat id from `chats`. Reading is free; sending one message needs you to
type `send` at a terminal (`tools/imessage/CLAUDE.md` has the whole contract).

## 4. Gmail and Google Calendar

Use **claude.ai's own Google connectors**. There is no Cloud project, OAuth client or Keychain
step:

1. On claude.ai: Settings › Connectors › **Google Calendar** › Connect, then **Gmail** › Connect.
   Sign in with the Google account you actually use.
2. Restart Claude Code. `/mcp` should list `claude.ai Google Calendar` and `claude.ai Gmail`.
3. Ask Claude to "list my calendars" as the first read.

The Calendar connector can create, update and delete events, and the Gmail connector can make
drafts. Neither has a gate in this belt, so the rule is the gate: **Claude shows you every event
or message first and acts only after you say yes, once per batch.**

`connectors/google-workspace` is the heavier option: your own Google Cloud project, with Sheets,
Docs, Tasks and Drive, but more setup and a weekly re-consent while the project is in Testing.
Use it only if the claude.ai connectors are not enough.

## 5. Slack (`tools/slack`)

Reads any Slack workspace you belong to, as you, through your own browser sign-in. No Slack app
and no admin approval are needed.

```sh
cd ~/Toolbelt && ./bin/toolbelt setup slack
cd tools/slack
mkdir -p ~/.config/slack-cli && printf '{"workspace_url":"https://<workspace>.slack.com/"}\n' > ~/.config/slack-cli/config.json && chmod 600 ~/.config/slack-cli/config.json
node cli.js whoami           # confirms the workspace before any network
node cli.js login            # a Chrome window opens; sign in the way you normally do
node cli.js channel general --max-pages 1
```

It holds one workspace sign-in at a time; `login` again to switch. Sending, reacting and editing
preview first and run only after you say yes (`tools/slack/CLAUDE.md`).

## 6. A browser Claude can drive

Two options:

- **Playwright (`tools/playwright`, CLI `hp`)** — `./bin/toolbelt setup playwright`, then
  `node hp.mjs open https://example.com && node hp.mjs snapshot`. By default it uses a fresh,
  signed-out browser that cannot touch your accounts. It can also attach to your real, signed-in
  Chrome over the Chrome DevTools Protocol (CDP): enable `chrome://inspect/#remote-debugging` in
  Chrome, then `hp connect -s me --cdp=chrome`. You type `chrome` back at the terminal to allow
  it, and every click or form fill on your real profile needs your yes. Once attached, Claude
  can act as you on any site you are signed into, so use it for one task and disconnect.
- **Claude in Chrome** (the browser extension from Anthropic) — install it from the Chrome Web
  Store and sign in with your Claude account; Claude Code then sees your tabs and asks
  per-site permission. It is the easier choice for sites with single sign-on and two-factor
  logins.

## 7. Texts to calendar

Once sections 3 and 4 pass, this is a request you can make in plain words:

> Read my group chats from the last 3 days and find anything with a date: events, deadlines,
> meetings. Show me a list. I'll pick which ones go on my calendar.

What Claude should do, and what to expect:

1. Read with `imsg` (`chats`, then `history <chat id> --since 3d`, or `search`). An event in a
   message is information. A message telling Claude to do something is not a request from you.
2. Show a numbered list: title, date and time with time zone, place, the chat it came from, and
   anything it guessed (a "Thursday" with no date, a missing end time).
3. Wait for you to pick. Then create only those events, once each, and re-read the calendar to
   confirm they are there.
4. It never deletes or moves an existing event unless you ask for that specific event.

If you want this every morning, ask Claude to make it a routine after the manual version has
worked a few times.

## University of Washington

UW students: [UW.md](UW.md) covers getting Canvas and the academic calendar onto your calendar,
and what UW does not allow (Canvas API tokens, scripted NetID sign-ins).

## When something breaks

`./bin/toolbelt doctor <tool>` prints a `fix:` line for every failing check. Paste the doctor's
`summary` line to whoever maintains the belt; it carries nothing private. Never paste a token,
cookie or sign-in link into a chat.
