# claude-ding — the agent contract

## Read first

- **What:** notification sounds for Claude Code. `sounds/` holds 17 synthesized 16-bit mono WAVs and two bash scripts; the hooks in `~/.claude/settings.json` run the scripts, which pick a WAV at random and play it through macOS `afplay`. Local audio only; nothing is written, nothing leaves the host.
- **Auth:** none.
- **First read:** `CLAUDE_DING_MUTE=1 sounds/play-random.sh` — prints `muted: <file>` and plays nothing. Without `CLAUDE_DING_MUTE` the script plays the file; that is the whole tool.
- **Writes:** none. Both verbs are read tier. No verb edits `settings.json`, copies sounds, or touches the network.
- **Knobs:** `CLAUDE_DING_VOLUME` (afplay volume, default `0.1` — the constant in each script) and `CLAUDE_DING_MUTE` (dry run).
- **Live here?** `bin/toolbelt doctor claude-ding --smoke`. macOS only (`afplay`).

```bash
CLAUDE_DING_MUTE=1 sounds/play-random.sh            # free: names the file, silent
sounds/play-random.sh                                # plays a celebratory sound at 0.1
CLAUDE_DING_VOLUME=0.3 sounds/play-random-question.sh # plays a question sound, louder, this once
```

## How it is wired

The hooks run `~/.claude/sounds/play-random.sh` (Stop) and `~/.claude/sounds/play-random-question.sh` (PostToolUse matchers `AskUserQuestion` and `ExitPlanMode`, and `PermissionRequest`). `toolbelt setup claude-ding` makes `~/.claude/sounds` a symlink to this tree's `sounds/`, so editing a script or a WAV here is the deployment — there is no second copy to keep in step. The scripts resolve their WAVs relative to their own location, so they work through the link and from the tool dir alike.

**What the install step changes outside the tree:** exactly one path. `~/.claude/sounds` becomes a link to `{TOOLBELT}/tools/claude-ding/sounds`; a real directory already there is renamed to `~/.claude/sounds.pre-toolbelt` and never deleted. `~/.claude/settings.json` is not read or written by anything in this tool — adding or removing the hook entries is the operator's edit (README shows the block).

The doctor warns when `~/.claude/sounds` does not resolve into this tree; the fix is the setup command.

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| either script with `CLAUDE_DING_MUTE=1` | read | run freely |
| either script unmuted | read | run when the user wants to hear a sound (it plays through the speakers — not a thing to do in a loop) |
| edit a script's sound list or the default volume | — | a normal edit in this tree; it is live at the next hook because of the symlink. Keep the default quiet: 0.1 was chosen on purpose |
| edit `~/.claude/settings.json` hooks | never | not this tool's verb; tell the user which block to change |

## Sounds

Celebratory rotation (`play-random.sh`): `claude-voila`, `claude-sparkle`, `claude-fanfare`, `claude-crab`. Question rotation (`play-random-question.sh`): `claude-question1`–`4`. The remaining files (`claude-happy1`–`4`, `claude-question5`–`8`, `claude-ding`) ship but are out of rotation; add a name to a script's `sounds=(…)` brace list to bring one in. README.md lists every file with a one-line description and the ffmpeg recipes that made them.

## Quirks

- `afplay` is macOS only; on Linux swap it for `paplay`/`aplay` in both scripts.
- A hook `timeout` of 5 s is in the settings block; every sound is under a second, so a timeout means the audio device was wedged, not the script.
- `$RANDOM` needs bash; the shebang is `#!/bin/bash`, do not change it to `sh`.
