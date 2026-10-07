# imessage (`imsg`) — agent guidance

## Read first

- **What:** iMessage and SMS on this Mac. Reads query `~/Library/Messages/chat.db` read-only and name handles from the local Contacts stores. `send` delivers one text message through Messages.app as the operator's signed-in Apple ID, behind a `/dev/tty` gate.
- **Auth:** no credential. Reads need **Full Disk Access** for the terminal app running the tool (System Settings › Privacy & Security › Full Disk Access). Sending needs that terminal's **Automation** permission for Messages; macOS asks the first time a send runs, and until it is granted osascript fails with `-1743`.
- **First read:** `node imsg.mjs chats --limit 10`
- **Writes:** `send` only. It previews; the message goes out only after a human types `send` at the controlling terminal, or runs `toolbelt approve imessage <code>` for a send you staged. `export` writes a new local file and nothing else.
- **Live here?** `bin/toolbelt doctor imessage` — Node ≥ 24 (built-in `node:sqlite`), chat.db readable, Contacts readable.

```bash
node imsg.mjs chats --limit 20                    # recent conversations: id, last activity, label
node imsg.mjs history "Pat Example" --since 7d  # one person's 1:1 threads (iMessage + SMS merged)
node imsg.mjs history 123 --limit 100             # a chat by id (groups included)
node imsg.mjs search "flight" --since 30d         # case-insensitive, newest first
node imsg.mjs whois "+1 206 555 0100"             # handle ↔ contact ↔ chats
node imsg.mjs watch --chat 123 --for 600          # print new messages as they arrive
node imsg.mjs export "Pat Example" --out ~/private/pat.jsonl
node imsg.mjs send "Pat Example" "running 10 min late" --explain   # the preview, nothing sent
node imsg.mjs send "Pat Example" "running 10 min late"             # agent: staged for approve
```

Exit codes: `0` done or previewed · `1` declined, failed or unverified · `2` usage or ambiguous recipient · `3` staged, waiting for a human (or approve declined) · `4` a gate needed a terminal and none was there.

Add `--json` to any read for one object per line: `rowid, guid, date (UTC ISO), from_me, from, handle, service, kind (message|reaction|event), text, chat`, plus `attachments[]`, `edited`, `unsent`, `delivered` and `error` where they apply.

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| `chats`, `history`, `search`, `whois`, `watch` | read | run when the user's request needs them — the output is their private messages, so read what the task needs, not whole histories |
| `export … --out <file>` | read (writes a new 600 file) | run when the user asked for an export; bulk work goes through the file, not your context |
| `send … --explain` | — | run freely: prints the preview and sends nothing |
| `send <who> <text>` | write-gated, tty | run **without** `--yes` when the user asked you to send that message; it stages and prints the approve command — hand that to the user |

**Never pass `--yes` or `--stage` yourself, and never retype a staged message to "try again".** A sent message reaches a real person as the operator and this tool cannot recall it. `--yes` exists for a human at a terminal; with no terminal the tool stages regardless, and the contract is what stops you passing it where a terminal happens to be attached.

## Targets

- **A chat id** from `chats` (`123` or `chat:123`) — the only way to name a group. Bare numbers of 1–6 digits are chat ids; anything with 7+ digits is a phone number.
- **A phone number or email** — every one-to-one chat with that handle. iMessage, SMS and RCS threads with one person are separate chats in the database; reads merge them.
- **A contact name** — must match exactly one contact (every word, case-insensitive). Two matches is an error listing both; narrow the name or use the handle. Handles not in Contacts print raw.

`send` resolves the same way and refuses ambiguity. An existing conversation is sent to by its chat guid, so Messages keeps that thread's service. A handle with no conversation goes to it as a new iMessage; pass `--service sms` for a phone without iMessage. The preview says **NEW conversation** when there is no prior history. Treat that line, and a surprising name next to a number, as a reason to stop and check with the user.

## The staged send

With no controlling terminal (most headless harnesses) `send` does not ask. It stages:

```
staged — a human confirms with: toolbelt approve imessage k3x9q2
```

Give the user that one line. In a real terminal it re-resolves the recipient, shows the full preview, asks for the typed word `send`, delivers once and deletes the record. The record is `~/.local/share/imessage/pending/<code>.json` (dir 700, file 600): it holds the recipient and the text and expires after 15 minutes. Do not ask for confirmation in chat, do not stage the same message twice, and do not read the pending file back. `toolbelt approve imessage --list` shows what is waiting; `--discard <code>` drops one unsent.

If `send` prompts instead of staging, your shell has the operator's terminal attached. The rule does not change: show the preview and let them answer; never answer the prompt or add `--yes`.

## After a send

The tool re-reads chat.db until the outgoing row appears: `sent to … — re-read confirms message <rowid>`. **`RE-READ MISMATCH`** means Messages accepted the script but no matching row appeared within 20 s. Stop and tell the user to look in Messages.app before anything is sent again. A `delivered: false` or `error` on the row (visible in `history --json`) means the message did not reach the recipient.

Every send and staging appends one line to `~/.local/share/imessage/audit.log` (600) and stderr: time, handle, chat, service, character count, sha256 prefix, result. The text itself is never logged; it is already in chat.db.

## Reading faithfully

- **Most text is in `attributedBody`.** On current macOS `message.text` is NULL for nearly every row. The tool decodes the typedstream archive (`lib/typedstream.mjs`), anchoring on the `NSString` class entry, and strips U+FFFC attachment placeholders. A row with neither prints as empty text with its attachments.
- **Reactions are rows.** A tapback is its own message (`kind: reaction`, e.g. "loved a message"). Group renames and membership changes are `kind: event`.
- **Empty is unknown.** `search` reports how many rows it scanned and says when it hit the 250,000-row ceiling. No hits for a name can mean the contact is not in Contacts: try the number.
- **Times** are stored as nanoseconds since 2001-01-01 UTC. JSON carries UTC ISO; the human view prints local time.
- **Attachments** are listed with their path under `~/Library/Messages/Attachments/`. The tool never opens, copies or sends them.

## Why the gate looks the way it does

- **`/dev/tty`, not stdin.** Whoever spawns the process owns its stdin and can pipe an answer into it; a child process cannot forge the controlling terminal. `echo send | imsg send …` therefore stages instead of sending.
- **A typed word, not `y`.** Typing `send` after reading the recipient, the NEW/existing line and the text proves the preview was read. `y`, `yes`, `Send` and Enter all abort.
- **Argv, not source.** Recipient and text reach AppleScript as `on run argv` arguments behind a sentinel, so no message content can alter the script (quotes, `-e`, newlines and emoji pass through verbatim).
- **No bulk, no attachments, no delete.** One recipient and one confirmation per message; a file path in a send could leak any local file; history is never opened writable.
