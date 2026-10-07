# print — the agent contract

## Read first

- **What:** the CUPS printers on this Mac (AirPrint / IPP Everywhere queues — today a Brother
  MFC-L2750DW mono laser, the default, and an Epson ET-3950 colour inkjet), driven through
  `lp`/`lpstat`/`cancel`/`cupsenable` and each printer's own IPP endpoint via `ipptool`.
  One Node file, no dependencies.
- **Auth:** none. Anything on the LAN may print; the belt adds no credential.
- **First read:** `node print.mjs printers` — every queue, what the printer itself answers
  (state, paper, supplies, formats, resolutions), no side effects.
- **Writes:** `send` **previews** — printer, files with page counts, sheets, media, dpi /
  quality / colour, the uncompressed raster per page, the exact `lp` line, and anything the
  printer is complaining about — then exits 0. `--yes` prints. `cancel <job>` and `resume` are
  ungated recovery. `cancel --all` and `unstick` preview, then `--yes`.
- **The rule:** show the user the preview and never pass `--yes` on your own. When the user
  approves a specific preview in the conversation (the file, the printer, the sheets), re-run
  that same command with `--yes`.
- **Live here?** `bin/toolbelt doctor print`.
- **Doctrine:** [docs/printing-notes.md](docs/printing-notes.md) — how a job reaches an
  AirPrint printer, which `lp -o` options are honoured, the ipptool incantations, Brother and
  Epson specifics, with sources. Read it before diagnosing anything the tool does not name.

```bash
node print.mjs printers                                  # queues + what each printer reports
node print.mjs status                                    # default printer: CUPS queue, the printer's queue, one-line diagnosis
node print.mjs send sign.png                             # preview: printer defaults, fit to page, mono on the Brother
node print.mjs send sign.png --yes                       # print it; the watchdog reports pages and kills a runaway
node print.mjs send doc.pdf --duplex --pages 1-4 -n 2    # preview a 2-copy duplex excerpt
node print.mjs send photo.jpg -p EPSON --paper photographic-glossy -q high --color --yes
node print.mjs cancel Brother_MFC_L2750DW_series-102     # one job, no gate
node print.mjs unstick Brother --yes                     # everything on that printer, on the Mac and inside the printer
```

Exit codes: `0` done or previewed · `1` CUPS/printer failure · `2` usage, or a ceiling.

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| `printers`, `status`, `jobs`, `options`, `send` (bare) | read | run freely |
| `send … --yes` | write-gated, flag | only after the user approved that preview |
| `cancel <job>` | write, ungated | run when a job is stuck or the user asks; it is re-sendable |
| `resume <printer>` | write, ungated | run when CUPS shows the queue disabled/paused |
| `cancel --all --yes`, `unstick … --yes` | write-gated, flag | after showing the preview — these cancel other people's jobs too |

## Ceilings and defaults (code constants in print.mjs)

| Constant | Value | Effect |
|---|---|---|
| `MAX_COPIES` | 5 | `--copies` above it exits 2 |
| `MAX_SHEETS` | 60 | pages × copies (duplex halves it) above it exits 2; use `--pages` |
| `MAX_FILES` | 5 | files per `send` |
| `QUALITY_DPI` | draft 300 · normal 600 · high 600 | a named `--quality` always carries an explicit resolution — never 1200 |
| `RASTER_SLOW_MB` | 15 | an image page whose raster exceeds this is announced as a multi-minute transfer |
| `WATCH_INTERVAL_S` / `MAX_WATCH_S` | 5 / 900 | the watchdog's poll and how long it stays |
| `RUNAWAY_GRACE` | 1 | printer pages beyond the planned sheets before the job is killed |

**Defaults are the printer's own.** `send` passes no `printer-resolution` or `print-quality`
unless `--dpi`/`--quality` is given, and when it is, the preview warns: on the Brother
MFC-L2750DW a draft/300 dpi image job printed as ~200 pages of binary garbage while the same
queue at its defaults prints correctly. Images get `fit-to-page` and a mono printer gets
`print-color-mode=monochrome`; that is all.

**The watchdog.** After `--yes`, `send` polls CUPS and the printer every 5 s. It reports the
printer's page counter as it changes and returns when the job has left both queues. If the
printer's pages exceed the planned sheets by more than `RUNAWAY_GRACE`, it cancels the job in
CUPS, sends `cancel-job` to the printer, runs `cupsdisable` so the spooler cannot re-feed it,
audits `verb=runaway`, and exits 1 saying so; re-enable with `print resume`. `--no-watch`
skips it — only for a job you will watch yourself.

Why the raster matters: the Brother accepts only `image/urf`/`image/pwg-raster`, so CUPS
rasterizes on the Mac and streams a bitmap. Letter at 600 dpi mono is ~34 MB a page; over this
Wi-Fi that is a 2–5 minute transfer during which the printer shows `job-incoming` and 0 pages.
That is normal — do not cancel it. Text pages compress to nothing and print in seconds.

## Reading `status`

```
Brother_MFC_L2750DW_series (default)  cups:printing — Connected to printer.
  printer: state processing [media-empty-warning, media-needed-warning, paused]
  cups queue:
    Brother_MFC_L2750DW_series-102  0.5 MB  robgruhl  Sat Aug 29 13:59:19 2026
  printer queue:
    #329  processing  [job-incoming,job-printing]  trashcan.jpg  pages printed 0
  problem: job 329 ("trashcan.jpg") is still being received — a large raster takes minutes over Wi-Fi …
```

`problem:` is the tool's diagnosis (`diagnose()`): paper out, jam, cover open, toner, a job
still being received (wait), paused, asleep. `pages printed` is the printer's own page counter
— if it climbs past what the job should be, the job is printing garbage: `unstick` it now. A printer that does not answer IPP is off or in Deep Sleep — **AirPrint cannot wake
a Brother from Deep Sleep; tap its panel** — and CUPS holds the job until it answers.

## Quirks

- Resolving a `dnssd://` queue to its `ipp://host:631/ipp/print` takes a 3 s Bonjour wait
  (`ippfind`); the result is cached in `~/.local/state/print/hosts.json` and re-resolved when
  the cached host stops answering. A printer that is off shows as "not reachable".
- `cancel` on the Mac does not reach a job the printer already holds; `unstick` sends
  `cancel-job` to the printer too. The printer can keep a cancelled job in `processing` for
  ~2 minutes; if it never drops it, power-cycle the printer.
- The `ipptool` bundled `get-jobs.test` reports `[FAIL]` on Brother firmware while still
  returning the job list; the tool reads the attributes and ignores the verdict.
- `fit-to-page` is what works on this Mac; `print-scaling=fit` is the PWG spelling — passing
  both makes CUPS ignore the first. The tool passes only `fit-to-page`.
- Audit: `[print audit] <ts> verb=send printer=… job=… files=… sheets=… options=…` on stderr
  and in `~/.local/state/print/audit.log` (dir 700, file 600).

## Verb inventory

| Verb | Tier | Gate |
|---|---|---|
| `printers`, `status [printer]`, `jobs`, `options <printer>` | read | — |
| `send <file…>` | write-gated, private spend | preview → `--yes` |
| `cancel <job-id…>` | write, ungated | — (audited) |
| `cancel --all` | write-gated | preview → `--yes` |
| `unstick <printer>` | write-gated | preview → `--yes` |
| `resume <printer>` | write, ungated | — (audited) |
| queue admin (`lpadmin`), printer web settings, firmware | never | no verb exists |
