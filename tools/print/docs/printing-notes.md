# Printing from the command line on this Mac — the doctrine

What is true about CUPS, AirPrint (IPP Everywhere) queues and the two printers in the house,
with the sources. `print.mjs` encodes the parts that can be encoded; this file is for the parts a
human still has to know. Researched 2026-08-29.

## How an AirPrint job actually reaches the printer

- macOS makes a **driverless queue** (`dnssd://…._ipp._tcp.local./?uuid=…`). The printer
  advertises `document-format-supported`; the Brother MFC-L2750DW lists only
  `image/urf`, `image/pwg-raster` and `application/octet-stream`. So **CUPS rasterizes every
  job on the Mac** (pdftopdf → pdftoraster → URF) and streams a full-page bitmap to the printer.
  The file size you hand `lp` is irrelevant; the raster size is everything.
- Raster size per Letter page, uncompressed 8-bit gray: **300 dpi ≈ 8.4 MB, 600 dpi ≈ 34 MB,
  1200 dpi ≈ 134 MB** (×3 for colour). URF compresses text pages to almost nothing and halftone
  or photo pages hardly at all (a 500 KB halftone JPEG renders to a 22 MB URF at 600 dpi).
  Over this house's Wi-Fi (190–400 ms ping to the Brother) a 600 dpi halftone page is a
  **2–5 minute transfer**, during which the printer reports `job-incoming` and
  `job-impressions-completed 0`. That is not a stall; nothing prints until the whole page has
  arrived. Cancelling at two minutes is the mistake. (Raster background:
  https://www.cups.org/doc/raster-driver.html, https://wiki.debian.org/CUPSAirPrint; the 64 MB
  family's AirPrint trouble with big jobs: https://discussions.apple.com/thread/254694529.)
- **Do not override resolution or quality on the Brother.** A job sent with
  `-o print-quality=3 -o printer-resolution=300dpi` came out as ~200 pages of binary garbage
  (the printer fed the stream to its text/PCL path) on 2026-08-29, while the same queue at its
  defaults printed a text page correctly. The URF CUPS produces at 300 dpi is valid
  (`cupsfilter -m image/urf` shows a proper `UNIRAST` header), so the fault is below CUPS —
  in what the backend sent or how the firmware detected it — and is not worth reproducing.
  `print.mjs` sends the printer's defaults unless told otherwise, warns when told otherwise,
  and watches the page counter after `--yes`.
- `job-impressions-completed` from the printer **is a page count** (RFC 8011 §5.3.18.2), not a
  transfer percentage. A rising count on a one-page job means the printer is printing garbage:
  cancel it in CUPS *and* inside the printer and disable the queue.
- On a driverless queue **`print-quality` alone chooses the resolution**: the generated PPD
  maps Draft/Normal/High to the first/middle/last of `printer-resolution-supported`
  (https://github.com/apple/cups/issues/5091). On a 300/600/1200 printer `print-quality=5`
  means a 1200 dpi raster. Always pass `printer-resolution=…dpi` alongside
  (https://github.com/apple/cups/issues/5090). `print.mjs` does this whenever a quality is
  named and never emits 1200.
- The printer reports `job-impressions-completed` as a rising number (64, 86 …) on a one-page
  job while receiving; it is transfer progress, not pages. Rely on `job-state` (9 = completed).

## `lp -o` options that an IPP Everywhere queue honours

Authoritative: https://www.cups.org/doc/options.html · https://www.cups.org/doc/man-lp.html

| Option | Values | Note |
|---|---|---|
| `media=` | `Letter`, `Legal`, `A4`, `na_letter_8.5x11in`, `Custom.WxHin` | CUPS maps the short names to PWG names |
| `media-source=` | `tray-1`, `manual` … from `lpoptions -l` / `media-source-supported` | |
| `media-type=` | `stationery`, `photographic-glossy`, … from `media-type-supported` | the Epson keys its quality on this |
| `print-quality=` | `3` draft, `4` normal, `5` high | pair with a resolution (above) |
| `printer-resolution=` | `300dpi`, `600dpi` | |
| `print-color-mode=` | `monochrome`, `color`, `auto` | |
| `sides=` | `one-sided`, `two-sided-long-edge`, `two-sided-short-edge` | the Brother advertises `DM1` (duplex) |
| `fit-to-page` | flag | works on this Mac for images and PDFs; `print-scaling=fit` is the PWG replacement (https://github.com/OpenPrinting/cups-filters/issues/108) — do not pass both (https://github.com/apple/cups/issues/6039) |
| `number-up=`, `page-ranges=`, `landscape`, `-n N`, `collate=true` | | filtered locally, work on any queue |
| `job-hold-until=` / `-H hold` | `indefinite`, `HH:MM` … | release with `lp -i JOB -H resume` |
| `document-format=` + `-o raw` | `image/urf` … | send a pre-rendered raster untouched |

A misspelled option name or value is **silently ignored**
(http://jeromebelleman.gitlab.io/posts/configuration/printeroptions/). `lpoptions -p Q -l`
shows the PPD spellings (`PageSize`, `Resolution`, `cupsPrintQuality`, `InputSlot`,
`MediaType`, `ColorModel`, `Duplex`); `-o` beats `~/.cups/lpoptions` beats `/etc/cups/lpoptions`
(https://www.cups.org/doc/man-lpoptions.html).

## Seeing what is going on

- `lpstat -t` everything; `-p -d` printers + default; `-v` device URIs; `-o` jobs;
  `-W completed -o Q` finished jobs; `-l -o Q` long form
  (https://www.cups.org/doc/man-lpstat.html).
- The printer's own opinion, bypassing cupsd — the bundled tests live in
  `/usr/share/cups/ipptool/` (https://www.cups.org/doc/man-ipptool.html):
  ```
  ippfind "Brother MFC-L2750DW series._ipp._tcp.local." -T 3           # dnssd name → ipp://host:631/ipp/print
  ipptool -T 8 -tv ipp://HOST:631/ipp/print get-printer-attributes.test  # printer-state(-reasons), urf-supported, media-ready, marker-levels
  ipptool -T 8 -tv ipp://HOST:631/ipp/print get-jobs.test                # what the printer holds; job-state-reasons job-incoming = still receiving
  ipptool -T 8 -t -d job-id=N ipp://HOST:631/ipp/print cancel-job.test   # cancel inside the printer (cancel on the Mac cannot reach it)
  ipptool -T 8 -t ipp://HOST:631/ipp/print cancel-current-job.test
  ```
  Job ids differ between cupsd and the printer. A cancelled printer-side job lingers as
  `processing` for up to ~2 minutes before the printer drops it; the next job waits behind it.
- Queue control: `cancel JOB`, `cancel -a Q`, `cupsdisable Q` / `cupsenable Q`
  (https://www.cups.org/doc/man-cupsenable.html), `lpmove JOB Q2`.
- Logs: `sudo cupsctl --debug-logging`, read `/var/log/cups/error_log` (grep `argv[5]` for the
  option string the filters got), then `--no-debug-logging`
  (https://www.papercut.com/kb/Main/HowToEnableDebugCUPS/). `cupsctl WebInterface=yes` opens
  http://localhost:631.
- Pre-render exactly what the printer would receive, and measure it:
  `cupsfilter -d Q -m image/urf -o printer-resolution=300dpi file.pdf > job.urf; ls -l job.urf`
  (https://www.cups.org/doc/man-cupsfilter.html).

## Brother MFC-L2750DW

- Online User's Guide: https://support.brother.com/g/s/id/htmldoc/mfc/cv_mfcl2750dw/use/html/ ·
  PDF: https://download.brother.com/welcome/doc100802/cv_mfcl2750dw_use_oug_g.pdf
- Web Based Management at `http://<printer>/` (status without login at
  `/general/status.html`; the admin password is `initpass` or the `Pwd` label on the back:
  https://support.brother.com/g/b/faqend.aspx?c=us&lang=en&prod=mfcl2750dw_us_eu_as&faqid=faq00100808_000).
- **AirPrint cannot wake it from Sleep or Deep Sleep** — tap the panel first
  (https://support.brother.ca/app/answers/detail/a_id/153652/). Deep Sleep cannot be disabled;
  Sleep Time is `Settings > All Settings > General Setup > Ecology > Sleep Time` (max 50 min)
  (https://support.brother.com/g/b/faqend.aspx?c=us&lang=en&prod=mfcl2710dw_us_eu_as&faqid=faq00000110_514).
  Auto Power Off never fires while on a network. "Unable to print after Deep Sleep":
  https://help.brother-usa.com/app/answers/detail/a_id/153110/
- The AirPrint queue exposes only media, quality/resolution, colour mode, duplex, copies.
  Toner Save, Improve Toner Fixing / Reduce Paper Curl, Density, Quiet Mode and Skip Blank Page
  exist only in the Brother driver (https://support.brother.com/g/s/id/htmldoc/mfc/cv_mfcl2750dw/use/html/GUID-FE99E530-D964-4A0B-A534-DC086B2F4B85_40.html).
  Brother: do not use Toner Save for photos or greyscale art.
- Good print for a halftone poster: `print send poster.png --yes` at the printer's defaults,
  then wait the several minutes the raster takes; the watchdog reports when the page is out.

## Epson ET-3950

- Support hub: https://epson.com/Support/Printers/All-In-Ones/ET-Series/Epson-ET-3950/s/SPT_C11CL43201 ·
  User's Guide PDF: https://files.support.epson.com/docid/cpd6/cpd65798.pdf
- An inkjet with its own PDF/JPEG interpreter; large rasters are not the problem they are on
  the Brother. Quality is `media-type` + `print-quality`: plain = `stationery` + `4`; photo =
  `photographic-glossy` + `5`; borderless needs a borderless-capable media type and a
  `…_borderless` media name from `media-supported`
  (https://epson.com/faq/SPT_C11CL43201~faq-00004ff-et3950_series).
  `print send photo.jpg -p EPSON --paper photographic-glossy -q high --color`.
- "Waiting for printer" over AirPrint resolves to mDNS blocked, a stale queue (remove and
  re-add, or Reset printing system), or a power-cycle in the order router → printer → Mac
  (https://discussions.apple.com/thread/255052686).

## Making a print-ready file

Hand CUPS a page that already is the target size at ≤ 300 dpi, grey for the laser; scaling
then has nothing to do:

```
magick in.png -colorspace Gray -resize 2550x3300 -units PixelsPerInch -density 300 \
  -gravity center -background white -extent 2550x3300 -compress zip out-300.pdf   # Letter @ 300 dpi
sips -s dpiHeight 300 -s dpiWidth 300 --resampleWidth 2550 in.png --out out.png    # built-in alternative
```
`-units PixelsPerInch` precedes `-density`; `-compress zip` for flat/halftone art, `jpeg` for
photos (https://www.eugenesia.co.uk/2017/10/imagemagick-convert-image-to-pdf-without-losing-quality/).
