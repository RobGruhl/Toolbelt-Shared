# video-rename

Rename video files to `YYYY-MM-DD__short_description.ext` from a Claude vision read of sampled
frames (PyAV), optionally with a Whisper transcript from the belt's `tools/transcription`.
`analyze` proposes; `rename --yes` renames; `undo` reverses. The agent contract, tiers, ceilings
and audit trail are in [CLAUDE.md](CLAUDE.md).

## Quick start

```bash
cd tools/video-rename
poetry env use /opt/homebrew/bin/python3.13 && poetry install   # or: toolbelt setup video-rename
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > ~/.config/toolbelt/video-rename.env && chmod 600 ~/.config/toolbelt/video-rename.env

poetry run video-rename analyze ~/Downloads/IMG_4821.mov --explain   # free pre-flight
poetry run video-rename analyze ~/Downloads/IMG_4821.mov             # paid: proposes a name, saves a plan
poetry run video-rename rename --plan <plan printed above> --yes     # renames, no second call
poetry run video-rename undo --yes                                   # puts it back
```

## Usage

```
video-rename analyze PATH... [options]          propose names (paid), save a plan, rename nothing
video-rename rename  PATH... [options] [--yes]  preview (paid) / rename with --yes
video-rename rename  --plan FILE [--yes]        preview / apply a saved plan, no API call
video-rename undo    [--last N] [--yes]         reverse the most recent renames
video-rename log     [--limit N] [--all]        the rename log

  -r, --recursive       Walk directories.
  --transcribe          Include an audio transcript (tools/transcription's `transcribe`).
  --model TEXT          haiku | sonnet | opus | <full Claude model id>   [default: sonnet]
  --haiku / --sonnet / --opus
  --res TEXT            low (256) | medium (512) | high (768) | <px>      [default: medium]
  --frames N            Frames sampled per file                          [default: 8, max 16]
  --max-files N         Files per run                                    [default: 25, max 200]
  --include-renamed     Also process files already named YYYY-MM-DD__…
  --explain             Pre-flight: files, model, cost estimate; no API call, no key needed.
```

## Tests

```bash
VIDEO_RENAME_HOME=$(mktemp -d) poetry run pytest -q
```

No test hits the API. The fixture `tests/fixtures/tiny.mp4` is a 3-second testsrc pattern;
regenerate with `ffmpeg -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=10" -c:v libx264 -pix_fmt yuv420p tests/fixtures/tiny.mp4`.
