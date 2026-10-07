#!/usr/bin/env node
// print — the belt's CUPS front door for the printers on this Mac (IPP Everywhere / AirPrint).
//
// Reads are free: printers, status, jobs, options, and `send --explain`. `send` is preview-first:
// it prints the exact lp command, the page and sheet count, the raster it will push at the
// printer and every warning, then exits 0; only --yes prints (the flag tier — paper and toner
// are the operator's own, so the flag prevents the accidental job and never refuses the
// deliberate one). Ceilings are code constants. `cancel <job>` and `resume` are the recovery
// direction and are ungated; `cancel --all` and `unstick` also cancel jobs the operator did not
// submit, so they take --yes.
//
// SENSIBILITIES: #1 read-first · #2 flag tier for private spend · #3 ceilings in code ·
// #5 --explain / preview · #7 audit line per job · #8 timeouts and plain failures.
//
// Exit codes: 0 ok or previewed · 1 CUPS/printer failure · 2 usage, or a ceiling.

import { parseArgs } from 'node:util';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, closeSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  run, lpstatPrinters, lpstatDevices, lpstatJobs, ipp, groupJobs, resolveUri,
} from './lib/cups.mjs';

// ---- ceilings (code constants — SENSIBILITIES #3) ----------------------------
export const MAX_COPIES = 5;            // per send
export const MAX_SHEETS = 60;           // pages x copies per send; refused above, not lowered
export const MAX_FILES = 5;             // per send
export const RASTER_SLOW_MB = 15;       // uncompressed per-page raster above this is a multi-minute Wi-Fi transfer: say so, so nobody cancels early
export const WATCH_INTERVAL_S = 5;      // after --yes: how often the watchdog polls the printer
export const MAX_WATCH_S = 900;         // …and for how long before it hands over to `print status`
export const RUNAWAY_GRACE = 1;         // printer pages completed may exceed the plan by this many before the job is killed
const VERSION = '0.1.0';

export const HOME = process.env.PRINT_HOME || path.join(homedir(), '.local', 'state', 'print');
export const AUDIT = path.join(HOME, 'audit.log');
export const HOSTS = path.join(HOME, 'hosts.json');   // resolved dnssd → ipp URIs, so status is not a 3s Bonjour wait

/** Tiny on-disk cache of resolved printer URIs. Entries are dropped when the printer stops answering. */
export function hostCache(file = HOSTS) {
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { data = {}; }
  const save = () => { try { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); } catch { /* cache only */ } };
  return {
    get: (name) => data[name]?.uri ?? null,
    set: (name, uri) => { data[name] = { uri, at: new Date().toISOString() }; save(); },
    drop: (name) => { delete data[name]; save(); },
  };
}

// The agent-reachable surface as data; the manifest's verbs[] must match this table (tested).
export const VERBS = {
  printers: 'read',
  status: 'read',
  jobs: 'read',
  options: 'read',
  send: 'write-gated',      // flag: preview → --yes
  cancel: 'write',          // one job: ungated (recovery). --all: flag
  unstick: 'write-gated',   // flag
  resume: 'write',          // ungated (recovery)
};

// Paper sizes: CUPS media name → inches. Anything else is passed through to lp untouched and
// the raster estimate says "unknown media".
export const MEDIA = {
  letter: { name: 'Letter', w: 8.5, h: 11 },
  legal: { name: 'Legal', w: 8.5, h: 14 },
  a4: { name: 'A4', w: 8.27, h: 11.69 },
  a5: { name: 'A5', w: 5.83, h: 8.27 },
  '4x6': { name: 'na_index-4x6_4x6in', w: 4, h: 6 },
  '5x7': { name: 'na_5x7_5x7in', w: 5, h: 7 },
};
export const QUALITY = { draft: 3, normal: 4, high: 5 };
export const QUALITY_DPI = { draft: 300, normal: 600, high: 600 };   // a named quality carries its resolution explicitly; never 1200
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.bmp', '.heic', '.webp']);

function fail(msg, code = 1) {
  console.error(`print: ${msg}`);
  process.exit(code);
}

// ---- argument parsing (pure) -------------------------------------------------

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      printer: { type: 'string', short: 'p' },
      copies: { type: 'string', short: 'n' },
      dpi: { type: 'string' },
      quality: { type: 'string', short: 'q' },
      media: { type: 'string', short: 'm' },
      pages: { type: 'string' },
      tray: { type: 'string' },
      paper: { type: 'string' },
      title: { type: 'string', short: 't' },
      gray: { type: 'boolean', default: false },
      color: { type: 'boolean', default: false },
      duplex: { type: 'boolean', default: false },
      'short-edge': { type: 'boolean', default: false },
      fit: { type: 'boolean', default: false },
      'no-fit': { type: 'boolean', default: false },
      landscape: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'no-watch': { type: 'boolean', default: false },
      explain: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  if (values.version) return { version: true };
  const [verb, ...rest] = positionals;
  if (!verb) throw new Error('no verb — one of: ' + Object.keys(VERBS).join(', '));
  if (!(verb in VERBS)) throw new Error(`unknown verb "${verb}" — one of: ${Object.keys(VERBS).join(', ')}`);
  const o = { verb, args: rest, json: values.json, yes: values.yes, explain: values.explain, printer: values.printer, all: values.all };
  if (verb === 'send') {
    if (!rest.length) throw new Error('send needs at least one file');
    if (rest.length > MAX_FILES) throw new Error(`send takes at most ${MAX_FILES} files per call (a code constant in print.mjs)`);
    if (values.gray && values.color) throw new Error('--gray and --color are exclusive');
    if (values.fit && values['no-fit']) throw new Error('--fit and --no-fit are exclusive');
    o.copies = parseCopies(values.copies);
    o.dpi = parseDpi(values.dpi);
    o.quality = parseQuality(values.quality);
    o.media = values.media ?? 'letter';
    o.pages = values.pages ? parsePages(values.pages) : null;
    o.tray = values.tray ?? null;
    o.paper = values.paper ?? null;
    o.title = values.title ?? null;
    o.watch = !values['no-watch'];
    o.colorMode = values.gray ? 'monochrome' : values.color ? 'color' : null;
    o.sides = values.duplex ? (values['short-edge'] ? 'two-sided-short-edge' : 'two-sided-long-edge') : null;
    o.fit = values['no-fit'] ? false : values.fit ? true : null;   // null = decide per file type
    o.landscape = values.landscape;
  }
  if (verb === 'cancel' && !rest.length && !values.all) throw new Error('cancel needs a job id (e.g. Brother_MFC_L2750DW_series-102) or --all');
  if ((verb === 'unstick' || verb === 'resume') && !rest.length && !values.printer) throw new Error(`${verb} needs a printer name (or --printer)`);
  return o;
}

export function parseCopies(raw) {
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) throw new Error(`--copies must be a positive integer, got "${raw}"`);
  const n = Number(raw);
  if (n > MAX_COPIES) throw new Error(`--copies ${n} exceeds the ${MAX_COPIES} ceiling (MAX_COPIES in print.mjs — raising it is a deliberate edit, not a flag)`);
  return n;
}
export function parseDpi(raw) {
  if (raw === undefined) return null;
  const n = Number(String(raw).replace(/dpi$/i, ''));
  if (![150, 300, 600, 1200].includes(n)) throw new Error(`--dpi must be 150, 300, 600 or 1200, got "${raw}"`);
  return n;
}
export function parseQuality(raw) {
  if (raw === undefined) return null;
  const q = String(raw).toLowerCase();
  if (!(q in QUALITY)) throw new Error(`--quality must be draft, normal or high, got "${raw}"`);
  return q;
}
export function parsePages(raw) {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(raw)) throw new Error(`--pages must look like 1-3,5 got "${raw}"`);
  return raw;
}

/** Number of pages a --pages range selects, capped at total when known. */
export function countRange(range, total) {
  let n = 0;
  for (const part of range.split(',')) {
    const [a, b] = part.split('-').map(Number);
    n += b ? Math.max(0, b - a + 1) : 1;
  }
  return total ? Math.min(n, total) : n;
}

// ---- file inspection (pure over a buffer) -----------------------------------

/** Best-effort page count: PDFs by counting /Type /Page objects (not /Pages); images are one
 *  page; text is estimated at 60 lines a page; anything else is unknown (null). */
export function inspectFile(file, buf) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf' || buf.subarray(0, 5).toString() === '%PDF-') {
    const n = (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
    return { kind: 'pdf', pages: n || null };
  }
  if (IMAGE_EXT.has(ext)) return { kind: 'image', pages: 1 };
  if (ext === '.txt' || ext === '.md' || ext === '.log' || ext === '') {
    const lines = buf.toString('utf8').split('\n').length;
    return { kind: 'text', pages: Math.max(1, Math.ceil(lines / 60)) };
  }
  return { kind: 'other', pages: null };
}

// ---- the plan (pure) ---------------------------------------------------------

/**
 * Turn parsed options + inspected files into the exact lp invocation and the numbers the
 * human needs to judge it. `printerInfo` (optional) carries what the printer told us:
 * {colorSupported, resolutions, formats} — used for defaults and warnings only.
 */
export function buildPlan(o, files, printerInfo = {}) {
  const warnings = [];
  const anyImage = files.some((f) => f.kind === 'image');
  const mediaKey = String(o.media).toLowerCase();
  const media = MEDIA[mediaKey] ?? { name: o.media, w: null, h: null };
  const quality = o.quality ?? null;
  // A named quality always carries an explicit resolution: on a driverless queue print-quality
  // alone picks the printer's first/middle/last supported resolution, so "high" on a
  // 300/600/1200 printer means a 1200 dpi raster (~134 MB a page). QUALITY_DPI caps that.
  const dpi = o.dpi ?? (quality ? QUALITY_DPI[quality] : null);
  const colorMode = o.colorMode ?? (printerInfo.colorSupported === false ? 'monochrome' : null);
  const fit = o.fit ?? anyImage;
  if (dpi || quality) warnings.push('resolution/quality overrides are the risky path on an AirPrint queue: the Brother MFC-L2750DW printed a draft/300 dpi image job as ~200 pages of binary garbage; the watchdog cancels a runaway, but only after the first extra sheet');
  const opts = [];
  opts.push(`media=${media.name}`);
  if (o.tray) opts.push(`media-source=${o.tray}`);
  if (o.paper) opts.push(`media-type=${o.paper}`);
  if (dpi) opts.push(`printer-resolution=${dpi}dpi`);
  if (quality) opts.push(`print-quality=${QUALITY[quality]}`);
  if (colorMode) opts.push(`print-color-mode=${colorMode}`);
  if (o.sides) opts.push(`sides=${o.sides}`);
  if (fit) opts.push('fit-to-page');
  if (o.landscape) opts.push('landscape');
  if (o.pages) opts.push(`page-ranges=${o.pages}`);

  const args = ['-d', o.printer];
  if (o.copies > 1) args.push('-n', String(o.copies));
  args.push('-t', o.title ?? path.basename(files[0].path));
  for (const x of opts) args.push('-o', x);
  args.push(...files.map((f) => f.path));

  // pages → sheets
  let pages = 0; let unknown = false;
  for (const f of files) {
    if (f.pages == null) { unknown = true; continue; }
    pages += o.pages ? countRange(o.pages, f.pages) : f.pages;
  }
  const perCopy = o.sides ? Math.ceil(pages / 2) : pages;
  const sheets = perCopy * o.copies;
  if (unknown) warnings.push('page count unknown for at least one file — the sheet estimate is a floor');

  // raster estimate: what CUPS will push to an IPP Everywhere printer (uncompressed)
  const effDpi = dpi ?? printerInfo.defaultDpi ?? 600;
  const channels = colorMode === 'monochrome' ? 1 : (printerInfo.colorSupported === false ? 1 : 3);
  const rasterMB = media.w ? +((media.w * effDpi) * (media.h * effDpi) * channels / 1e6).toFixed(1) : null;
  if (rasterMB == null) warnings.push(`media "${media.name}" is not in the size table — no raster estimate`);
  else if (rasterMB > RASTER_SLOW_MB && anyImage) warnings.push(`~${rasterMB} MB of raster per page at ${effDpi} dpi: a photo or halftone page this size takes several minutes to transfer over Wi-Fi and the printer shows 0 pages until it has all of it — that is normal; do not cancel early`);
  if (printerInfo.resolutions && dpi && !printerInfo.resolutions.includes(dpi)) warnings.push(`printer reports resolutions ${printerInfo.resolutions.join('/')} dpi, not ${dpi}`);
  if (sheets > MAX_SHEETS) throw new Error(`${sheets} sheets exceeds the ${MAX_SHEETS} ceiling (MAX_SHEETS in print.mjs); use --pages or split the job`);

  return { args, opts, media, dpi: effDpi, dpiExplicit: !!dpi, quality, colorMode, sides: o.sides, fit, pages, sheets, unknownPages: unknown, rasterMB, warnings, copies: o.copies };
}

export function renderPlan(plan, o, files, preview) {
  const lines = [];
  lines.push(preview ? 'print send — PREVIEW, nothing sent' : 'print send');
  lines.push(`  printer:   ${o.printer}`);
  for (const f of files) lines.push(`  file:      ${f.path}  (${f.kind}, ${f.pages ?? '?'} page${f.pages === 1 ? '' : 's'}, ${(f.bytes / 1e6).toFixed(1)} MB)`);
  lines.push(`  media:     ${plan.media.name}${o.tray ? `  tray ${o.tray}` : ''}`);
  lines.push(`  copies:    ${plan.copies}  (ceiling ${MAX_COPIES})`);
  lines.push(`  sheets:    ${plan.sheets}${plan.unknownPages ? '+' : ''}  (ceiling ${MAX_SHEETS})${plan.sides ? `  ${plan.sides}` : ''}`);
  lines.push(`  raster:    ${plan.dpi} dpi${plan.dpiExplicit ? '' : ' (printer default)'}${plan.quality ? `, quality ${plan.quality}` : ''}${plan.colorMode ? `, ${plan.colorMode}` : ''}${plan.fit ? ', fit to page' : ''}${plan.rasterMB != null ? ` — ~${plan.rasterMB} MB/page uncompressed` : ''}`);
  lines.push(`  command:   lp ${plan.args.map(shq).join(' ')}`);
  for (const w of plan.warnings) lines.push(`  warning:   ${w}`);
  if (preview) lines.push('\nRe-run with --yes to print. The flag is for a human who has read this preview.');
  return lines.join('\n');
}
export function shq(s) { return /^[A-Za-z0-9_./=:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ---- audit (SENSIBILITIES #7) ------------------------------------------------

export function audit(fields, { home = HOME, file = AUDIT } = {}) {
  const line = `[print audit] ${new Date().toISOString()} ` + Object.entries(fields).map(([k, v]) => `${k}=${/[\s"]/.test(String(v)) ? JSON.stringify(String(v)) : v}`).join(' ');
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
    appendFileSync(file, line + '\n');
  } catch { /* the audit line still reaches stderr */ }
  console.error(line);
}

// ---- diagnosis (pure) --------------------------------------------------------

/** Turn printer attrs + its job list into one human sentence about what is wrong, if anything. */
export function diagnose(attrs, printerJobs) {
  const reasons = [].concat(attrs['printer-state-reasons'] ?? []).map(String);
  const has = (re) => reasons.some((r) => re.test(r));
  if (has(/media-empty|media-needed/)) return 'out of paper — load the tray; the current job resumes on its own';
  if (has(/media-jam/)) return 'paper jam — clear it at the printer';
  if (has(/toner-empty|marker-supply-empty/)) return 'toner/ink empty';
  if (has(/cover-open|door-open/)) return 'a cover is open';
  if (has(/offline|shutdown/)) return 'printer reports offline';
  const incoming = (printerJobs ?? []).find((j) => /incoming/.test(String(j.reasons)));
  if (incoming) return `job ${incoming.id} ("${incoming.name}") is still being received — a large raster takes minutes over Wi-Fi; pages print only once it has all arrived. Give it 5 minutes before \`print unstick\``;
  if (has(/paused|stopped/)) return 'printer paused';
  if (/sleep/i.test(String(attrs['printer-state-message'] ?? ''))) return 'printer asleep (it wakes for the next job)';
  return null;
}

// ---- verbs -------------------------------------------------------------------

async function resolvePrinter(name) {
  const { printers, default: dflt } = await lpstatPrinters();
  if (!printers.length) fail('no printers configured in CUPS (System Settings > Printers & Scanners)');
  const target = name ?? dflt ?? printers[0].name;
  const p = printers.find((x) => x.name === target || x.name.toLowerCase().startsWith(String(target).toLowerCase()));
  if (!p) fail(`no printer "${target}" — have: ${printers.map((x) => x.name).join(', ')}`, 2);
  const devices = await lpstatDevices();
  return { ...p, isDefault: p.name === dflt, device: devices[p.name] ?? null, uri: await liveUri(p.name, devices[p.name]) };
}

/** Resolve and verify: a cached URI that no longer answers is dropped and re-resolved once. */
async function liveUri(name, deviceUri) {
  const cache = hostCache();
  let uri = await resolveUri(name, deviceUri, cache);
  if (uri && cache.get(name) === uri) {
    const probe = await ipp(uri, 'get-printer-attributes.test');
    if (probe.attrs['printer-state'] === undefined) { cache.drop(name); uri = await resolveUri(name, deviceUri, cache); }
  }
  return uri;
}

async function printerFacts(uri) {
  if (!uri) return { reachable: false };
  const r = await ipp(uri, 'get-printer-attributes.test');
  const a = r.attrs;
  if (a['printer-state'] === undefined) return { reachable: false };
  const res = [].concat(a['printer-resolution-supported'] ?? []).map((s) => Number(String(s).replace(/dpi.*/, ''))).filter(Boolean);
  const dres = String(a['printer-resolution-default'] ?? '').replace(/dpi.*/, '');
  const markers = [].concat(a['marker-names'] ?? []).map((n, i) => `${n} ${[].concat(a['marker-levels'] ?? [])[i] ?? '?'}%`);
  return {
    reachable: true,
    state: String(a['printer-state']),
    reasons: [].concat(a['printer-state-reasons'] ?? []),
    message: a['printer-state-message'] ?? null,
    formats: [].concat(a['document-format-supported'] ?? []),
    resolutions: res,
    defaultDpi: Number(dres) || null,
    colorSupported: a['color-supported'] === undefined ? null : String(a['color-supported']) === 'true',
    mediaDefault: a['media-default'] ?? null,
    mediaReady: [].concat(a['media-ready'] ?? []),
    markers,
    queued: a['queued-job-count'] ?? null,
    attrs: a,
  };
}

async function printerJobs(uri) {
  if (!uri) return [];
  const r = await ipp(uri, 'get-jobs.test');
  return groupJobs(r.groups);
}

async function cmdPrinters(o) {
  const { printers, default: dflt } = await lpstatPrinters();
  const devices = await lpstatDevices();
  const rows = await Promise.all(printers.map(async (p) => {
    const uri = await liveUri(p.name, devices[p.name]);
    const facts = await printerFacts(uri);
    return { ...p, isDefault: p.name === dflt, device: devices[p.name] ?? null, uri, ...facts };
  }));
  if (o.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    console.log(`${r.isDefault ? '*' : ' '} ${r.name}  cups:${r.state}${r.reason ? ` (${r.reason})` : ''}`);
    console.log(`    device:   ${r.device ?? '?'}`);
    if (!r.reachable) { console.log('    printer:  not reachable over IPP (off, asleep too deeply, or not an ipp:// queue)'); continue; }
    console.log(`    printer:  state ${r.state}${r.reasons.length ? ` [${r.reasons.join(', ')}]` : ''}${r.message ? ` — ${r.message}` : ''}`);
    console.log(`    accepts:  ${r.formats.join(', ')}  ·  ${r.resolutions.join('/')} dpi${r.defaultDpi ? ` (default ${r.defaultDpi})` : ''}  ·  ${r.colorSupported === false ? 'mono' : r.colorSupported ? 'color' : 'color?'}`);
    console.log(`    media:    default ${r.mediaDefault}; loaded ${r.mediaReady.join(', ') || '?'}${r.markers.length ? `  ·  supplies ${r.markers.join(', ')}` : ''}`);
  }
}

async function cmdStatus(o) {
  const p = await resolvePrinter(o.args[0] ?? o.printer);
  const [facts, pjobs, cjobs] = await Promise.all([printerFacts(p.uri), printerJobs(p.uri), lpstatJobs()]);
  const mine = cjobs.filter((j) => j.printer === p.name);
  const problem = facts.reachable ? diagnose(facts.attrs, pjobs) : 'printer not reachable over IPP';
  if (o.json) { console.log(JSON.stringify({ printer: p, facts: { ...facts, attrs: undefined }, printerJobs: pjobs, cupsJobs: mine, problem }, null, 2)); return; }
  console.log(`${p.name}${p.isDefault ? ' (default)' : ''}  cups:${p.state}${p.reason ? ` — ${p.reason}` : ''}`);
  if (facts.reachable) console.log(`  printer: state ${facts.state}${facts.reasons.length ? ` [${facts.reasons.join(', ')}]` : ''}${facts.message ? ` — ${facts.message}` : ''}`);
  else console.log('  printer: not answering IPP — off, in Deep Sleep (AirPrint cannot wake a Brother from it: tap its panel), or not an ipp queue');
  console.log(`  cups queue: ${mine.length ? '' : 'empty'}`);
  for (const j of mine) console.log(`    ${j.id}  ${(j.bytes / 1e6).toFixed(1)} MB  ${j.user}  ${j.submitted}`);
  console.log(`  printer queue: ${pjobs.length ? '' : 'empty'}`);
  for (const j of pjobs) console.log(`    #${j.id}  ${j.state}  [${j.reasons}]  ${j.name}  pages printed ${j.progress ?? '?'}`);
  if (problem) console.log(`  problem: ${problem}`);
}

async function cmdJobs(o) {
  const jobs = await lpstatJobs();
  if (o.json) { console.log(JSON.stringify(jobs, null, 2)); return; }
  if (!jobs.length) { console.log('no jobs queued in CUPS'); return; }
  for (const j of jobs) console.log(`${j.id}  ${(j.bytes / 1e6).toFixed(1)} MB  ${j.user}  ${j.submitted}`);
}

async function cmdOptions(o) {
  const p = await resolvePrinter(o.args[0] ?? o.printer);
  const r = await run('lpoptions', ['-p', p.name, '-l']);
  if (!r.ok) fail(`lpoptions: ${r.stderr.trim()}`);
  console.log(r.stdout.trim());
}

async function cmdSend(o) {
  const p = await resolvePrinter(o.printer);
  o.printer = p.name;
  const files = o.args.map((f) => {
    const abs = path.resolve(f);
    if (!existsSync(abs) || !statSync(abs).isFile()) fail(`no such file: ${f}`, 2);
    const buf = readFileSync(abs);
    return { path: abs, bytes: buf.length, ...inspectFile(abs, buf) };
  });
  const facts = await printerFacts(p.uri);
  let plan;
  try { plan = buildPlan(o, files, facts); } catch (e) { fail(e.message, 2); }
  if (facts.reachable) {
    const problem = diagnose(facts.attrs, await printerJobs(p.uri));
    if (problem) plan.warnings.push(`printer says: ${problem}`);
  } else if (p.uri) plan.warnings.push('printer did not answer IPP — off or in Deep Sleep (tap the panel to wake a Brother; AirPrint cannot); CUPS holds the job until it answers');
  const preview = !o.yes;
  console.log(renderPlan(plan, o, files, preview));
  if (preview) return;
  const r = await run('lp', plan.args);
  if (!r.ok) { audit({ verb: 'send', printer: p.name, result: 'error', detail: r.stderr.trim() }); fail(`lp: ${r.stderr.trim() || r.stdout.trim()}`); }
  const id = (/request id is (\S+)/.exec(r.stdout) || [])[1] ?? '?';
  audit({ verb: 'send', printer: p.name, job: id, files: files.map((f) => path.basename(f.path)).join(','), sheets: plan.sheets, copies: plan.copies, options: plan.opts.join(',') });
  console.log(`\nsent: ${id}`);
  if (!o.watch || !p.uri) { console.log(`watch it with: print status ${p.name}`); return; }
  const title = o.title ?? path.basename(files[0].path);
  const verdict = await watchJob(p, id, title, plan.sheets);
  if (verdict.runaway) fail(verdict.message);
  console.log(verdict.message);
}

/**
 * The runaway guard. Poll CUPS and the printer until the job is gone from both (done) or the
 * printer's own page counter exceeds what the preview promised — then cancel it in CUPS, cancel
 * it inside the printer, disable the queue so the spooler cannot re-feed it, and say so. A
 * printer that keeps a job at job-incoming for a long time is transferring, not runaway.
 */
async function watchJob(p, cupsId, title, sheets) {
  const limit = sheets + RUNAWAY_GRACE;
  const t0 = Date.now();
  let lastPages = null;
  while ((Date.now() - t0) / 1000 < MAX_WATCH_S) {
    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_S * 1000));
    const [cjobs, pjobs] = await Promise.all([lpstatJobs(), printerJobs(p.uri)]);
    const inCups = cjobs.some((j) => j.id === cupsId);
    const mine = pjobs.filter((j) => j.name === title);
    const pages = Math.max(0, ...mine.map((j) => Number(j.progress) || 0));
    if (pages !== lastPages) { console.log(`  ${Math.round((Date.now() - t0) / 1000)}s: cups ${inCups ? 'sending' : 'done'}, printer ${mine.length ? `${mine[0].reasons}, ${pages} page(s) printed` : 'no job'}`); lastPages = pages; }
    if (pages > limit) {
      for (const j of mine) await ipp(p.uri, 'cancel-job.test', { 'job-id': j.id });
      await run('cancel', [cupsId]);
      await run('cupsdisable', ['-r', 'print: runaway job cancelled', p.name]);
      audit({ verb: 'runaway', printer: p.name, job: cupsId, planned: sheets, printed: pages, result: 'cancelled+disabled' });
      return { runaway: true, message: `RUNAWAY: the printer reports ${pages} pages for a ${sheets}-sheet job — cancelled on the Mac and inside the printer, and the queue is disabled. If it keeps printing, power-cycle the printer. Re-enable with: print resume ${p.name}` };
    }
    if (!inCups && !mine.length) return { runaway: false, message: `done: ${pages || sheets} page(s) reported by the printer in ${Math.round((Date.now() - t0) / 1000)}s` };
  }
  return { runaway: false, message: `still in progress after ${MAX_WATCH_S}s — the watchdog is no longer watching; check with: print status ${p.name}` };
}

async function cmdCancel(o) {
  if (o.all) {
    const jobs = await lpstatJobs();
    if (!o.yes) {
      console.log(`print cancel --all — PREVIEW: would cancel ${jobs.length} CUPS job(s)${jobs.length ? ':\n  ' + jobs.map((j) => `${j.id} (${j.user})`).join('\n  ') : ''}\nRe-run with --yes.`);
      return;
    }
    const r = await run('cancel', ['-a']);
    audit({ verb: 'cancel', target: 'all', count: jobs.length, result: r.ok ? 'ok' : 'error' });
    if (!r.ok) fail(`cancel -a: ${r.stderr.trim()}`);
    console.log(`cancelled ${jobs.length} job(s)`);
    return;
  }
  for (const id of o.args) {
    if (!/^[A-Za-z0-9_.-]+-\d+$/.test(id)) fail(`"${id}" is not a CUPS job id like Printer_Name-102`, 2);
    const r = await run('cancel', [id]);
    audit({ verb: 'cancel', target: id, result: r.ok ? 'ok' : 'error' });
    if (!r.ok) fail(`cancel ${id}: ${r.stderr.trim()}`);
    console.log(`cancelled ${id}`);
  }
}

async function cmdUnstick(o) {
  const p = await resolvePrinter(o.args[0] ?? o.printer);
  const [cjobs, pjobs, facts] = await Promise.all([lpstatJobs(), printerJobs(p.uri), printerFacts(p.uri)]);
  const mine = cjobs.filter((j) => j.printer === p.name);
  const problem = facts.reachable ? diagnose(facts.attrs, pjobs) : null;
  const lines = [`print unstick ${p.name}${o.yes ? '' : ' — PREVIEW, nothing changed'}`];
  lines.push(`  cups jobs to cancel:    ${mine.length ? mine.map((j) => j.id).join(', ') : 'none'}`);
  lines.push(`  printer jobs to cancel: ${pjobs.length ? pjobs.map((j) => `#${j.id} (${j.reasons})`).join(', ') : 'none'}${p.uri ? '' : '  (no direct IPP path)'}`);
  lines.push(`  then:                   cupsenable ${p.name}`);
  if (problem) lines.push(`  note:                   ${problem}`);
  if (!o.yes) lines.push('Re-run with --yes. Jobs are re-sendable; this cancels everyone\'s jobs on this printer.');
  console.log(lines.join('\n'));
  if (!o.yes) return;
  for (const j of mine) { const r = await run('cancel', [j.id]); audit({ verb: 'unstick', printer: p.name, target: j.id, result: r.ok ? 'cancelled' : 'error' }); }
  for (const j of pjobs) { const r = await ipp(p.uri, 'cancel-job.test', { 'job-id': j.id }); audit({ verb: 'unstick', printer: p.name, target: `printer#${j.id}`, result: r.passed === false ? 'refused' : 'cancel-sent' }); }
  const e = await run('cupsenable', [p.name]);
  audit({ verb: 'unstick', printer: p.name, target: 'cupsenable', result: e.ok ? 'ok' : 'error' });
  // A cancelled printer-side job can linger a minute or two in "processing" before the printer drops it.
  const after = await printerJobs(p.uri);
  console.log(after.length ? `printer still lists ${after.map((j) => '#' + j.id).join(', ')} — it drops a cancelled job within ~2 minutes; if it does not, power-cycle the printer` : 'printer queue empty');
}

async function cmdResume(o) {
  const p = await resolvePrinter(o.args[0] ?? o.printer);
  const r = await run('cupsenable', [p.name]);
  audit({ verb: 'resume', printer: p.name, result: r.ok ? 'ok' : 'error' });
  if (!r.ok) fail(`cupsenable: ${r.stderr.trim()}`);
  console.log(`${p.name} enabled`);
}

function usage() {
  return `print ${VERSION} — CUPS printers on this Mac, preview-first

  print printers [--json]                      every queue: CUPS state, what the printer itself reports, formats, dpi, paper, supplies
  print status [printer] [--json]              both queues (CUPS + the printer's own), progress, and a one-line diagnosis
  print jobs [--json]                          CUPS jobs
  print options <printer>                      lpoptions -l for the queue
  print send <file…> [options]                 PREVIEW the exact lp command, sheets, raster size, warnings; --yes prints
      -p/--printer <name>   -n/--copies N (≤${MAX_COPIES})   --dpi 150|300|600|1200   -q/--quality draft|normal|high
      -m/--media letter|legal|a4|a5|4x6|5x7    --gray | --color   --duplex [--short-edge]   --fit | --no-fit
      --landscape   --pages 1-3,5   --tray tray-1   --paper stationery|photographic-glossy   -t/--title "…"   --no-watch   --yes
  print cancel <job-id…> | --all [--yes]       one job: ungated recovery. --all previews, then --yes
  print unstick <printer> [--yes]              cancel everything on that printer (CUPS and on-device), cupsenable; previews first
  print resume <printer>                       cupsenable a queue CUPS stopped

Defaults in code: the printer's own resolution and quality (overrides warn); images fit to page. After --yes a watchdog\nwatches the printer's page counter and kills the job on both sides if it passes the planned sheets (--no-watch to skip).
Ceilings: ${MAX_COPIES} copies, ${MAX_SHEETS} sheets, ${MAX_FILES} files per send. Audit: ${AUDIT}`;
}

async function main() {
  let o;
  try { o = parseCli(process.argv.slice(2)); } catch (e) { console.error(`print: ${e.message}\n`); console.error(usage()); process.exit(2); }
  if (o.help) { console.log(usage()); return; }
  if (o.version) { console.log(VERSION); return; }
  if (o.explain && o.verb === 'send') o.yes = false;
  const table = { printers: cmdPrinters, status: cmdStatus, jobs: cmdJobs, options: cmdOptions, send: cmdSend, cancel: cmdCancel, unstick: cmdUnstick, resume: cmdResume };
  await table[o.verb](o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e.message));
}
