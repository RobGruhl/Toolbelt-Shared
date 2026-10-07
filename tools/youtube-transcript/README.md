# youtube-transcript (`yt`)

Read-only YouTube caption fetcher for the Toolbelt. No API key. The agent contract, verbs,
ceilings and current status are in [CLAUDE.md](CLAUDE.md).

```bash
cd tools/youtube-transcript && npm install
node yt.mjs ytdlp https://youtu.be/jNQXAC9IVRw            # markdown transcript via yt-dlp (brew install yt-dlp)
node yt.mjs fetch jNQXAC9IVRw --format srt --out zoo.srt  # InnerTube segments in six renderings
node yt.mjs search jNQXAC9IVRw elephants                  # where a word is said
node yt.mjs --help
```

`lib/transcript.js`, `examples/` and `docs/` are the original hello-youtube-transcript workshop
(a reusable client over `@danielxceron/youtube-transcript`):

| # | Example | What |
|---|---|---|
| 01 | `basic-transcript.js` | first 10 segments |
| 02 | `plain-text.js` | full text + word count |
| 03 | `timestamped-segments.js` | `[MM:SS] text` |
| 04 | `language-select.js` | a specific language |
| 05 | `batch-transcripts.js` | several videos with a delay |
| 06 | `transcript-search.js` | search with context |
| 07 | `export-srt.js` | `.srt` file |

Docs: [API reference](docs/01-api-reference.md) · [captions system](docs/02-captions-system.md) · [patterns](docs/03-patterns.md)
