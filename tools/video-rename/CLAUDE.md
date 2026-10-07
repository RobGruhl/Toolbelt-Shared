# video-rename — the agent contract

## Read first

- **What:** a CLI that renames the operator's own video files to `YYYY-MM-DD__short_slug.ext`
  from a Claude vision read of sampled frames (optionally plus a Whisper transcript). The date
  is the file's mtime, the slug is a 3–8 word model title. Every rename is logged and
  reversible.
- **Auth:** `ANTHROPIC_API_KEY` in the environment, else `~/.config/toolbelt/video-rename.env`
  (mode 600, enforced — a looser file is refused). Needed only by `analyze` and by `rename`
  without `--plan`. The key is billed to the operator's own account.
- **First read:** `poetry run video-rename analyze <file-or-dir> --explain` — lists the files,
  model, frames and an approximate cost; no API call, no key needed.
- **Writes:** `rename` previews by default and renames only with `--yes`; `undo --yes` renames
  back. There is no TTY prompt: the write is private and reversible, so the gate is the flag
  (SENSIBILITIES #2). **Never pass `--yes` on your own** — show the plan, get the user's yes
  on those names, then re-run with `--plan <file> --yes` so nothing is paid twice.
- **Live here?** `bin/toolbelt doctor video-rename` — Python 3.13, poetry, ffmpeg, the key
  (warn), and the `transcribe` binary (warn; optional).

```bash
cd tools/video-rename
poetry run video-rename analyze ~/Downloads --explain                # free pre-flight
poetry run video-rename analyze ~/Downloads -r --haiku --res low     # paid: proposes, saves a plan
poetry run video-rename rename ~/Movies/clip.mov                      # paid preview + saved plan
poetry run video-rename rename --plan ~/.local/share/video-rename/plans/<ts>.json --yes   # free: rename from the plan
poetry run video-rename rename ~/Movies/clip.mov --yes                # paid + rename in one go (a human typed this)
poetry run video-rename undo                                          # preview the last rename's reversal
poetry run video-rename undo --last 3 --yes                           # reverse the last three
poetry run video-rename log                                           # live renames; --all includes undone
```

Exit codes: `0` done or previewed · `1` one or more files errored (the rest were processed) ·
`2` usage, no key, a loose key file, or a ceiling exceeded.

## Verbs and tiers

| Verb | Tier | Gate | You may |
|---|---|---|---|
| `analyze PATHS` | read, **paid** | — | run when the user asked for names; it writes nothing but a plan file under `~/.local/share/video-rename/plans/` |
| `analyze … --explain`, `rename … --explain` | read, free | — | run freely |
| `rename PATHS` | write-gated | flag | run without `--yes`: same paid read as `analyze`, prints the plan and the `--plan … --yes` re-run |
| `rename --plan FILE` | write-gated | flag | run without `--yes` to preview a saved plan at no cost |
| `rename … --yes` | write-gated | flag | only after the user approved the specific names in the plan |
| `undo [--last N]` | write-gated | flag | run without `--yes` freely; with `--yes` when the user asked to reverse |
| `log` | read | — | run freely |
| delete, move across directories, overwrite | never | — | no code path exists |

The `VERBS` table in `src/video_analysis/cli.py` is the contract; `tests/test_safety.py` fails
when the manifest's `verbs[]` disagrees with it.

## How a rename actually happens

`rename` (and `analyze`) discovers files — extensions in `config.VIDEO_EXTS`, skipping names
that already match `YYYY-MM-DD__` unless `--include-renamed` — then, per file: samples
`--frames` frames with PyAV, resizes to `--res`, sends them in one Claude call, and computes
the new name with `build_new_name` (same directory, lowercase extension, `_2`/`_3` suffix if
the name is taken). `apply_rename` refuses an existing target outright and, through
`check_same_directory`, any destination whose resolved parent differs from the source's — so a
plan or log entry, however it was written, can only change a file's name, never its directory.
After each rename the filesystem is re-read: if the
destination is missing or the source remains, the line is reported as `RE-READ MISMATCH` and
counted as an error. Each rename appends a record to `renames.jsonl`, which is what `undo`
replays (newest first, skipping records already undone, refusing when the original name is
now taken).

Plans are JSON (`{"tool": "video-rename", "model", "entries": [{from, to, summary, tags}]}`),
written mode 600. `rename --plan` checks each source still exists, that each target stays in
the source's directory, and applies nothing else from the file — a plan is data, not
instructions.

## Ceilings and cost

Code constants in `src/video_analysis/config.py` (SENSIBILITIES #3 — raising one is a diff):

| Constant | Value | Effect |
|---|---|---|
| `MAX_FRAMES` | 16 | `--frames` above it exits 2 |
| `DEFAULT_MAX_FILES` | 25 | a run that finds more files exits 2 before any call and names `--max-files` |
| `MAX_FILES` | 200 | `--max-files` above it exits 2 |

Cost: one call per file. At the default (`sonnet`, 8 frames, 512 px) `--explain` estimates
roughly $0.006 of uncached input per file; `--haiku --res low` is a few tenths of a cent.
The estimate uses `INPUT_USD_PER_MTOK` in `config.py` — an order-of-magnitude guard, not a
bill; the audit line carries the token counts the API actually reported. The system prompt
is cache-marked, so a batch on one model pays the cache write once; alternating models per
file defeats that.

## Audit trail

Every paid call and every rename/undo writes one line to stderr **and** appends it to
`~/.local/share/video-rename/audit.log` (dir 700, file 600):

```
[video-rename audit] 2026-08-22T05:04:11Z verb=analyze target="~/Downloads/IMG_4821.mov" model="claude-sonnet-4-6" frames=8 calls=1 input_tokens=1930 cache_read=380 output_tokens=61 transcript=false
[video-rename audit] 2026-08-22T05:04:12Z verb=rename target="~/Downloads/IMG_4821.mov" to="~/Downloads/2026-08-20__dog_catching_frisbee_beach.mov" plan="~/.local/share/video-rename/plans/20260822-050411.json"
```

Never the key, never a frame, never the transcript. `--explain` writes no audit line because
nothing ran. `VIDEO_RENAME_HOME` relocates the whole state dir (tests use a temp dir).

## Degraded modes

- **No `transcribe` binary:** `--transcribe` prints one yellow line and the run continues
  visual-only. The binary is looked for at `{TOOLBELT}/tools/transcription/.venv/bin/transcribe`
  (`TOOLBELT` from the environment, else the root this tool sits in), then on `PATH`;
  `toolbelt setup transcription` provides it. A transcription that fails on one file degrades
  that file only. Transcripts are truncated to 2000 characters before they reach the prompt.
- **One bad video** (zero-length, unreadable, bad JSON twice from the model) is reported and
  the batch continues; exit 1 at the end. `rename --yes` still renames the files that
  analyzed cleanly.
- **Empty result:** "No videos found" means nothing with a video extension was under the paths
  *that did not already look renamed* — `--include-renamed` widens it.

## Quirks

- macOS screen-recording filenames contain non-breaking spaces (U+00A0). Pass a directory or
  a shell glob rather than retyping the name; `Path.iterdir()` handles them.
- `looks_renamed` is strict: zero-padded date and a double underscore. `IMG_2024_06_12.MOV`
  is treated as unlabeled.
- The decoder is PyAV (FFmpeg bindings) because eva-decord has no Python 3.13 wheels; PyAV
  ≥ 17 is required against Homebrew ffmpeg 8.x. If both are ever imported, `import av` first.
- `--include-renamed` is what upstream called `--force`; it was renamed so `--force` keeps its
  belt meaning (a gate bypass) and this flag, which only widens discovery, does not read as one.
- The Python package keeps its upstream name `video_analysis`; the CLI is `video-rename`
  (`analyze-video` remains as an alias of the same app).

## Install footprint

`toolbelt setup video-rename` creates `.venv/` inside this directory (poetry, in-project) and
`~/.config/toolbelt/` for the key file. Runtime state goes to `~/.local/share/video-rename/`.
Nothing else outside the tree is touched; ffmpeg comes from Homebrew.
