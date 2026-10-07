# transcription (`transcribe`) — the agent contract

## Read first

- **What:** audio → text. Default backend is the local whisper.cpp service on `:2022`
  (Voice Mode, `ggml-large-v3-turbo`, Metal): free, private, no size cap. `--backend openai`
  is the paid, off-host alternative on the operator's own OpenAI key.
- **Auth:** none for local. For openai, in order: `$OPENAI_API_KEY` → Keychain item
  `OPENAI_API_KEY` (`security add-generic-password -s OPENAI_API_KEY -a "$USER" -w`) →
  `~/.config/toolbelt/transcription.key` (mode 600 enforced). `poetry run transcribe check`
  says which source it found without printing the key.
- **First read:** `poetry run transcribe run <file>` — from `tools/transcription/`.
- **Writes:** none to any shared system. The paid path is the conspicuous verb: estimate
  first, `exit 2` above the ceiling without `--yes`, one audit line per request.
- **The rule:** never pass `--backend openai` or `--yes` on your own. Run `--explain`, show
  the user the estimate, and let the approval name the file and the dollar figure. The flag
  is always honored by the code — which is exactly why the contract has to hold here
  (SENSIBILITIES #2).
- **Live here?** `bin/toolbelt doctor transcription`.

## Commands

```bash
poetry run transcribe run <file>                         # local, free; stdout
poetry run transcribe run <file> -o out.txt -f srt -t    # timestamps → srt/vtt (local)
poetry run transcribe run <file> --preset gaming         # presets: default, gaming, high_quality
poetry run transcribe run <file> --prompt "Claude, MCP"  # vocabulary hint (both backends)
poetry run transcribe run <file> --backend openai --explain          # plan + estimate, no call
poetry run transcribe run <file> --backend openai                    # paid; refuses over $1.00
poetry run transcribe run <file> --backend openai --max-usd 3 --yes  # human-approved spend
poetry run transcribe run <file> --backend openai -m gpt-4o-transcribe-diarize   # speaker labels
poetry run transcribe check                              # both backends + month-to-date spend
poetry run transcribe spend [--month 2026-08]            # sum of est_usd from the audit log
poetry run transcribe presets
```

Exit codes: `0` done or pre-flighted · `1` file/key/backend/API failure · `2` usage, or the
cost gate (ceiling exceeded or duration unknown, no `--yes`).

| Verb | Tier | Gate |
|---|---|---|
| `run` (local), `run --explain`, `check`, `spend`, `presets` | read | none |
| `run --backend openai` | write-gated (paid, egress) | the flag; estimate vs `--max-usd`; `--yes` past it |
| `run --paragraphs` | write-gated (spends your Claude plan) | the flag |
| realtime, translations, batch | never | no code path |

## The paid path, exactly

1. `ffprobe` reads the duration before any byte is uploaded. `est_usd = ceil(sec/60) × rate`,
   rates in `spend.RATES_USD_PER_MIN` dated `RATES_AS_OF` (2026-08-22). No ffprobe → the
   estimate is unknown and the run needs `--yes`.
2. `est_usd > --max-usd` (`DEFAULT_MAX_USD = 1.00`, about 3.7 h at the default model) → exit 2
   with the figure and the `--yes` re-run. Nothing uploaded. `--yes` is honored from anyone;
   the contract, not the code, keeps an agent from supplying it.
3. Files over 25 MB are re-encoded once to 16 kHz mono 32 kbps mp3 in the temp dir (≈4 h fits);
   still over → refused with the `ffmpeg -f segment` command. The tool never splits silently.
4. One multipart `POST https://api.openai.com/v1/audio/transcriptions`, key in the bearer
   header only. Errors surface the API's message; the key is never in any output.
5. Audit line appended to `~/.local/state/toolbelt/transcribe.log` (dir 700, file 600) for
   every request on either backend, success or error:
   `ts | principal=last4=XXXX | endpoint=openai | model=… | file=… sha256=… bytes=… duration_s=… | usage=type=duration seconds=N | billed_minutes=N | est_usd=… | request_id=… | chunk=1/1 | status=ok`.
   Local lines carry `principal=local` and `est_usd=0.0000`. `transcribe spend` and the
   doctor sum the month; the doctor warns past $10.

### Model choice (openai)

| Model | $/hr | Use when |
|---|---|---|
| `gpt-transcribe` (default) | 0.27 | plain text; best accuracy per dollar |
| `gpt-4o-transcribe-diarize` | 0.36 | speakers matter — segments come back as `[speaker] text`; `chunking_strategy=auto` is set for you |
| `whisper-1` | 0.36 | you need `srt`/`vtt`/segment timestamps from the cloud (`-t`); the only cloud model that returns them |
| `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | 0.36 / 0.18 | previous generation |

`-t` with `gpt-transcribe` is accepted but yields no segments: `srt`/`vtt` output collapses
to one cue. Use local (segments for free) or `whisper-1`. Local gives no diarization.

## When to leave local

Local is right by default: free, private, timestamps included. Reach for openai when the
service on `:2022` is down and the user would rather pay than wait, when the audio is noisy
or multilingual and local quality is not enough, or when speakers must be labelled. The local
failure panel names `--backend openai` as the degraded mode; naming it is not permission to
use it.

## Quirks

- The local service ignores the `model` form field; the tool sends `whisper-1` for
  compatibility and logs the real model name `ggml-large-v3-turbo`.
- Presets (`configs/*.yaml`) carry `base_url`/`timeout` for the local backend only; `--backend`
  and `--model` are CLI flags, not preset keys.
- `--paragraphs` shells out to the operator's `claude --print` with a text-only prompt, 50
  lines per call, no permission bypass. Transcript text is untrusted input; it never reaches
  a tool-capable session. Failure falls back to the raw text with a warning.
- `rich` output goes to stderr; the transcript alone goes to stdout, so `> file` and `-o`
  give the same bytes.
- `transcribe` is a Poetry console script: on PATH only inside `poetry run` / the `.venv`.
  A caller shelling out to it (video-analysis) needs `tools/transcription/.venv/bin` on
  PATH or the absolute path `tools/transcription/.venv/bin/transcribe`.
