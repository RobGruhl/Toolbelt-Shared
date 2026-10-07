# youtube-transcript (`yt`) — the agent contract

## Read first

- **What:** read-only CLI that turns a YouTube URL or id into captions. Two backends: `ytdlp` (yt-dlp + `scripts/clean_vtt.py` → markdown) and InnerTube (the vendored `@danielxceron/youtube-transcript` library → segments with timestamps).
- **Auth:** none. No API key, no cookie, no cache. YouTube rate-limits by source IP (429); that is the only thing that can "expire".
- **First read:** `node yt.mjs ytdlp <url|id>` — markdown with a title/channel/date header.
- **Writes:** none against YouTube; no write code exists. `--out FILE` writes one local file and refuses an existing one without `--force`.
- **Live here?** `bin/toolbelt doctor youtube-transcript`. `yt-dlp` absent is a warn, not a fail — the InnerTube verbs still load.

```
node yt.mjs ytdlp  <url|id> [--lang en] [--out FILE]           markdown transcript via yt-dlp (the path that works today)
node yt.mjs fetch  <url|id> [--format F] [--lang en] [--out F]  InnerTube segments as text|timestamped|segments|json|srt|md
node yt.mjs search <url|id> <words…> [--context N]              segments containing the words, ±N context (max 5)
node yt.mjs stats  <url|id>                                     segments, words, duration, language
node yt.mjs batch  <url|id>… [--json]                           stats per video, max 20, 1.5 s apart
… --explain                                                     pre-flight: backend, video, output; no call
```

Exit codes: 0 ok · 1 no captions, 429, backend missing, or any video in a batch failed · 2 usage
(including a ceiling exceeded and an input that is not a YouTube id/URL).

## Status (2026-08-22)

The InnerTube library (1.2.6) answers `DisabledError` for every video tested, captioned or not —
it has fallen behind YouTube's page format. `fetch`/`search`/`stats`/`batch` therefore fail with
a message naming `ytdlp`; `fetch --format md` falls back to yt-dlp by itself and says
`[yt] degraded:` on stderr. Use `ytdlp` first. When the library is fixed (`npm update` and
re-test `node yt.mjs stats jNQXAC9IVRw`), delete this section.

## Backends

| | `ytdlp` | InnerTube (`fetch`, `search`, `stats`, `batch`) |
|---|---|---|
| Needs | `yt-dlp` on PATH (`brew install yt-dlp`), `python3` | `npm install` |
| Output | markdown paragraphs, `**[MM:SS]**` per ~45 s or speaker change (`>>`) | per-segment `{text, offset, duration, lang}` in six renderings |
| Captions | manual track if present, else auto (`--write-subs --write-auto-subs`), `<lang>` then `<lang>-orig` | whatever track YouTube serves for `--lang` |
| Metadata | title, channel, upload date, length in the header | id only |

yt-dlp works in a `mkdtemp` dir under the OS temp dir, deleted afterwards. The URL it receives is
rebuilt from the validated 11-character id, so caller input never reaches its argv. `--lang` takes
a code like `en` or `pt-BR`; `en.*` is deliberately not used because it matches YouTube's
auto-translated tracks and draws a 429.

## Ceilings and pre-flight

Code constants at the top of `yt.mjs`; raising one is a diff, not a flag:

| Constant | Value | Effect |
|---|---|---|
| `MAX_BATCH` | 20 | more ids to `batch` exits 2 |
| `BATCH_DELAY_MS` | 1500 | pause between videos in `batch` |
| `MAX_CONTEXT` | 5 | `--context` above it exits 2 |
| `TIMEOUT_MS` | 30 000 | per call on both backends; a timeout exits 1, no retry |

`--explain` prints the plan (verb, id, backend and whether yt-dlp is on PATH, language, format,
output path and whether it exists) and returns before any network code runs.

## Audit trail

One line to stderr before every network call: `[yt] <ISO time> verb=<v> backend=<innertube|yt-dlp>
target=<id>`. Never the transcript. Redirect stderr to keep it.

## What "empty" and errors mean

- `no captions via InnerTube … (DisabledError)` — today this means the library, not the video (see Status). Run `ytdlp`.
- `yt-dlp found no "<lang>" captions` — the video has no track in that language; `yt-dlp --list-subs <url>` shows what exists.
- `HTTP Error 429` from either backend — this IP is rate-limited; wait minutes, do not loop.
- `search` with 0 hits — substring match is case-insensitive over single segments; a phrase split across two segments does not match. Try a shorter word.
- Members-only, age-gated, private and in-progress live videos fail with yt-dlp's own message; report it, do not retry.

Auto-captions are ~60-70 % accurate and carry no punctuation or speaker names; `>>` marks a
speaker change, not who. Say so when the user plans to quote someone.

## Legacy skill

`~/.claude/skills/yt-transcript` is the earlier yt-dlp path: its `SKILL.md` shells out to
yt-dlp by hand and its `scripts/clean_vtt.py` is the file vendored here as
`scripts/clean_vtt.py`. `node yt.mjs ytdlp <url> --out <file>` does its steps 1-5 in one command.
The skill should point here and be retired; the router is `skills/toolbelt`.

## Also in this directory

`lib/transcript.js`, `examples/01-07` and `docs/01-03` are the hello-* workshop as vendored:
a reusable InnerTube client and runnable examples (`node examples/01-basic-transcript.js <id>`).
They share the library's current breakage. `yt.mjs` is self-contained and does not import `lib/`.
