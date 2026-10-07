# example-write (`exw`) — agent guidance

## Read first

- **What:** the worked example of every write tier. Two plain-text files under `~/.local/share/exw`: `notes.txt` is private and reversible; `shared-board.txt` stands in for a system other people see. Whether a gate sees a terminal depends on the harness: a process that inherits the operator's terminal session opens `/dev/tty` and gets the preview; one that does not stages.
- **Auth:** none — local files under the operator's home. Nothing to log in to, nothing to expire.
- **First read:** `node exw.mjs list`
- **Writes:** `note add`/`note rm` run at once and print their undo. `board post` previews; it writes only with `--yes` or after a human approves a staged copy. `board clear` takes the word `clear` typed on `/dev/tty`.
- **Live here?** `bin/toolbelt doctor example-write` — only Node >= 18 is needed.

```bash
node exw.mjs list                         # both files, numbered
node exw.mjs show 2                       # note 2
node exw.mjs note add 'call the vendor'   # writes now; prints "undo: exw note rm <n>"
node exw.mjs note rm 3
node exw.mjs board post 'deploy at 4' --explain   # the plan, nothing written
node exw.mjs board post 'deploy at 4'             # you: preview + the --yes re-run; agent: staged
node exw.mjs board clear --explain
```

Exit codes: `0` done or previewed · `1` declined or mistyped · `2` usage · `3` staged and waiting for a human (or approve declined) · `4` a gate needed a terminal and none was there.

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| `list`, `show <n>` | read | run freely |
| `note add <text>`, `note rm <n>` | write, private + reversible | run when the user asked for it; report the `wrote …` line and its undo verbatim |
| `board post <text>` | write-gated, shared | run **without** `--yes`; it stages and prints the approve command — hand that to the user |
| `board clear` | write-gated, destructive | run only `--explain`; the clear itself is the user's to type. `--force` exists for a human at a terminal — never pass it |
| any write verb `--explain` | — | run freely: it prints the plan and touches nothing |

**Never pass `--yes`, `--force`, or `--stage` on your own.** Those flags exist for a human who has read the preview. The code honors them from anyone, which is exactly why the contract has to hold here: a flag you add is indistinguishable from one the user typed, and the belt's safety rests on that distinction being real (SENSIBILITIES #2). If the user, in the conversation, approves a specific post you previewed, you may re-run that same `board post` with `--yes` — the approval must name the text, not the verb.

## The staged write

When your process has no controlling terminal (most headless harnesses), a bare `board post` does not preview — it stages:

```
staged — confirm with: toolbelt approve example-write k3x9q2
```

If it previews instead (exit 0, "Preview only"), your shell is attached to the operator's terminal: `/dev/tty` opened, so the tool treated the call as a human's. The rule does not change — show the preview, and still never add `--yes` yourself; `--stage` forces the staged path from a terminal if you want the approve flow regardless.

Give the user that one line. They run it in a real terminal; it shows the exact text and the target, asks for a typed `yes`, posts once, and deletes the record. The record is `~/.local/share/exw/pending/<code>.json` (dir 700, file 600), holds the post text only, and expires 15 minutes after staging. Do not retry the post, do not ask for confirmation in chat, and do not read the pending file back to "confirm" it yourself — the terminal is the confirmation. `toolbelt approve example-write --list` shows what is pending; `--discard <code>` drops one unexecuted.

## Why the gates look the way they do

- **`/dev/tty`, not stdin.** Whoever spawns the process owns its stdin and can pipe an answer into it. A child process cannot answer through its own stdin, a flag, or an environment value: `/dev/tty` opens only when a controlling terminal exists. That is why `echo clear | exw board clear` exits 4 instead of clearing. A caller that deliberately allocates a pseudo-terminal (`script`, `expect`, `pty.fork`) and types the word can pass the gate; that is a deliberate act, and the belt prevents the naive mistake, never the deliberate one (SENSIBILITIES #2).
- **Typed echo for the destructive verb.** Typing `clear` after seeing the line count proves the operator read the count; `y` proves only that a key was pressed. `Clear`, `yes`, and Enter all abort.
- **`--force` only at a terminal; no `--yes`.** A deliberate human is never refused: `--force` skips the typed word, but only where `/dev/tty` opens. From a pipeline the flag is indistinguishable from an agent's guess, so it exits 4 with the one command to run. The terminal test is about the harness, not the caller: a coding agent whose shell inherits the operator's session will open `/dev/tty`, get the prompt, and have its `--force` honored — which is why the contract above, not the terminal test, is what keeps you from passing it.
- **Read back after every write.** The audit line on stderr (`[exw audit] … verb= target= bytes= lines=`) is followed by a re-read of the file from disk and the diff. A write call returning is a claim; the re-read is the evidence. `RE-READ MISMATCH` means stop and tell the user.

## Windows

There is no `/dev/tty` on win32, and a console stdin is exactly what a spawner can feed, so the typed-echo tier does not accept it. `board clear` and `approve` refuse and tell: the file path to delete by hand, or the `board post … --yes` command for the user to type at a console. `toolbelt approve` itself runs through `cmd /c` on Windows, so the refusal text is what the human sees. `board post` previews when stdin is a console and stages otherwise. Everything else behaves the same.

## Adapting this tool

This is the template for a real write tool. Keep the shape and swap the targets: the private-file tier becomes "writes only the operator can see" (a draft, a personal setting), the shared-board tier becomes "other people will read this" (a message, a ticket comment), the destructive tier becomes "cannot be undone" (a delete, a channel create). The `VERBS` table in `exw.mjs` is the contract the manifest's `verbs[]` mirrors — the test suite fails if they disagree. `EXW_HOME` exists so tests never touch the real files.
