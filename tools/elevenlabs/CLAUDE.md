# elevenlabs (`agent-voice`) — the agent contract

## Read first

- **What:** ElevenLabs text-to-speech for Claude Code, on your own account: a `127.0.0.1:7888`
  server that streams TTS into `ffplay`, a CLI, and a Stop hook that speaks the last line of
  each turn's summary. Every TTS call is paid per character.
- **Auth:** `security add-generic-password -s ELEVENLABS_API_KEY -a "$USER" -w` (the Keychain
  is the preferred store). Also honored, in order: `$ELEVENLABS_API_KEY`,
  `~/.config/toolbelt/elevenlabs.env` (mode 600 enforced), an in-tree `.env` (deprecated,
  warns). The key is never printed; `status` reports only its source.
- **First read:** `poetry run agent-voice status` (exit 1 means the server is down — that is
  state, not an error).
- **Writes:** `speak` (paid; `--yes` above 400 chars, refused above 1000), `voice-add`
  (creates a voice; `--yes` required), `setup` (writes `~/.claude`; `--yes` required),
  `music` (paid; `--yes` required, refused above 120 s). Each has `--dry-run`/preview. No delete verb exists.
- **The rule:** never pass `--yes` on your own. Preview, show the human, then re-run with the
  flag once they approve that specific text, voice, or install. The flag records a person's
  yes; it does not replace one (SENSIBILITIES #2).
- **Live here?** `bin/toolbelt doctor elevenlabs`.

## Running it

All commands from `tools/elevenlabs/` via `poetry run agent-voice …` (or `toolbelt run
elevenlabs -- …`).

```
status [--json]                       server health, key source, ffplay, hook state
serve                                 the server, foreground, 127.0.0.1 only
speak "text" [-a agent] [-t tag]      via the running server; --dry-run plan; --yes above 400 chars
stop                                  halt playback
voices [--limit N] [--json]           the account's voices (read; ceiling 100)
voice-add NAME sample.mp3 … --yes     instant voice clone into your account; --dry-run first
setup [--project] [--uninstall] --yes install/remove the Stop hook; previews without --yes
music "prompt" --out DIR [--seconds N] [--name STEM] [--vocals] --yes
                                      Eleven Music (music_v2_5) track → DIR/STEM.mp3; previews without --yes
```

`music` needs a paid ElevenLabs plan and bills by track length. It is instrumental unless
`--vocals`, since a soundtrack under picture is the common case; the API rejects a seed
alongside a prompt, so there is no `--seed`. The audit line records how far the account's
usage counter moved, which is the actual charge; the counter can lag the call, and a move of 0
is logged as `not-yet-reported` — check the ElevenLabs usage page for the settled figure.

Exit codes: 0 ok (or previewed) · 1 server down / API failure · 2 usage, a ceiling hit, or a
missing `--yes`.

| Verb | Tier | Gate | What the gate shows |
|---|---|---|---|
| `status`, `voices`, `serve`, `stop` | read | none | — |
| `speak` | write-gated, paid | `--yes` above `CONFIRM_CHARS`; refused above `MAX_CHARS` | `--dry-run`: server, agent, voice id, model, char count, both ceilings |
| `voice-add` | write-gated | `--yes` always | the plan: name, sample files, total bytes, "occupies a voice slot; undo in the UI" |
| `setup` | write-gated, private | `--yes` always | the settings file and whether it changes, the exact Stop entry, the script action (create / overwrite / unchanged / delete) |
| `music` | write-gated, paid | `--yes` always; refused above `MAX_MUSIC_SECONDS` (120) | the plan: model, seconds, instrumental, prompt, output path, key source |
| voice delete / edit / share | never | no verb | — |

## Ceilings and the audit trail

Constants in `agent_voice/config.py` — raising one is a diff, not a flag (SENSIBILITIES #3):

| Constant | Value | Enforced where |
|---|---|---|
| `MAX_CHARS` | 1000 | `SpeakRequest` (HTTP 422 before any TTS), `speaker.py`, CLI exit 2 |
| `CONFIRM_CHARS` | 400 | CLI `speak` asks for `--yes` above it |
| `HOOK_CHARS` | 200 | `scripts/agent-voice-hook.sh` truncates the summary line |

Every TTS call, voice creation and hook install writes one line to stderr and appends it to
`~/.local/state/agent-voice/audit.log` (dir 700, file 600; `AGENT_VOICE_AUDIT_LOG` overrides):

```
[agent-voice audit] 2026-08-22T20:11:04.512Z verb=speak agent=default voice=nPczCjzI2devNBz1zQrb model=eleven_flash_v2_5 chars=87
```

`grep chars= ~/.local/state/agent-voice/audit.log | awk -F'chars=' '{s+=$2} END {print s}'` is
the month's spend in characters. The server runs in the background, so the log file — not
stderr — is the trail that survives.

## The hook

`scripts/agent-voice-hook.sh` is copied to `~/.claude/hooks/agent-voice-hook.sh` and named in
`~/.claude/settings.json` under `hooks.Stop` by `setup --yes` — the second `toolbelt setup
elevenlabs` step, confirmed at a terminal. It is the only path in this tool that writes
outside the tool directory; `poetry install` and every other verb stay inside it. The hook
reads the Stop JSON on stdin, takes the last non-empty line of `transcript_summary` (200
chars max), and POSTs it to `/speak` with a 2 s timeout in the background. It always exits 0:
with the server down it is a silent no-op.

**The server is the switch.** The hook stays installed; `serve` running means narration is on,
not running means off. `status` says which. The doctor's `hook-installed` check passes only
when the installed copy is byte-identical to `scripts/agent-voice-hook.sh` — after editing
the script, re-run `setup --yes`.

## Configuration

First found wins: `./.agent-voice.yaml`, then `~/.config/agent-voice/config.yaml`, then the
defaults (port 7888, voice `nPczCjzI2devNBz1zQrb` "Brian", model `eleven_flash_v2_5`,
`pcm_24000`). `voices:` maps an `agent_type` (the `-a` flag / request field) to
`{voice_id, model_id, tags}`; unknown types use `default_voice_id`. `AGENT_VOICE_PORT`
overrides the port for the server, the CLI and the hook alike.

## Quirks

- `eleven_flash_v2_5` ignores audio tags (`[calm]`, `[whispers]`); tags work only on
  `eleven_v3`, which is ~4x slower to first audio. Set `model_id` per voice if you need them.
- The server requests `pcm_24000` (s16le, 24 kHz, mono) and `ffplay` is started with
  `-f s16le -ar 24000 -ch_layout mono`; the two must match. ffmpeg 8 removed `-ac`.
- `optimize_streaming_latency=4` trades a little quality for first-chunk speed.
- `/speak` returns at once and plays in a background task; a new request stops the current
  playback. `stop` kills the `ffplay` process. Orphaned `ffplay … s16le` processes after a
  crashed server are safe to kill.
- `voices` pages through the v2 search endpoint; it lists what the account can use, including
  premade voices, not only clones.
- A `voice-add` sample set is at most 25 files (ElevenLabs' IVC limit); creation counts
  against the plan's voice slots and is undone in the ElevenLabs UI.

## Storage

| Path | Mode | Holds |
|---|---|---|
| Keychain item `ELEVENLABS_API_KEY` | — | the key (preferred) |
| `~/.config/toolbelt/elevenlabs.env` | 600 (enforced) | optional `ELEVENLABS_API_KEY=` line |
| `~/.config/agent-voice/config.yaml` | — | global voice config, no secrets |
| `~/.local/state/agent-voice/audit.log` | 600 | the audit trail |
| `~/.claude/hooks/agent-voice-hook.sh` | 755 | the installed hook copy (`setup`) |
