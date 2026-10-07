# transcription

Audio → text. Local whisper.cpp (Metal, `:2022`) by default: free, private, timestamps, no
size cap. `--backend openai` is an explicit, paid, audited alternative on your own key. The
agent contract — gates, ceilings, audit line, model choice — is [CLAUDE.md](CLAUDE.md).

```bash
poetry install
poetry run transcribe run ~/recording.mp3                       # local
poetry run transcribe run ~/video.mp4 -t -f srt -o subs.srt     # subtitles
poetry run transcribe run ~/call.m4a --backend openai --explain  # estimate, no call
poetry run transcribe check                                     # backends + month spend
```

| Command | Does |
|---|---|
| `run <file>` | transcribe; `--preset`, `--language`, `--prompt`, `-t`, `-f txt/json/srt/vtt`, `-o` |
| `run … --backend openai [-m model] [--max-usd N] [--yes]` | paid cloud call; refuses above the ceiling without `--yes` |
| `run … --explain` | pre-flight: plan, bytes, duration, estimate; nothing sent |
| `check` | local health, key source (never the value), month-to-date estimate |
| `spend [--month YYYY-MM]` | sum of `est_usd` from `~/.local/state/toolbelt/transcribe.log` |
| `presets` | `configs/*.yaml`: default, gaming, high_quality |

Requirements: macOS, Python 3.13+, Poetry, `ffmpeg` (`brew install ffmpeg` — ffprobe prices
the call; ffmpeg shrinks files over 25 MB), the Voice Mode whisper.cpp service for the local
backend (`mcp__voice-mode__service whisper start`; setup in
[docs/01-whisper-cpp-setup.md](docs/01-whisper-cpp-setup.md)).

Local performance (large-v3-turbo on Apple Silicon): ~6–8 min per hour of audio.
