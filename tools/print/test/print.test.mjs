// Unit tests for the pure parts of print. Nothing here runs lp, lpstat or ipptool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCli, parseCopies, parseDpi, parseQuality, parsePages, countRange, inspectFile, buildPlan, renderPlan,
  diagnose, audit, hostCache, VERBS, MAX_COPIES, MAX_SHEETS, MAX_FILES, RASTER_SLOW_MB,
} from '../print.mjs';
import { parseLpstatPrinters, parseLpstatDevices, parseLpstatJobs, parseIpptool, groupJobs, directIppUri, dnssdService } from '../lib/cups.mjs';

// ---- argument parsing --------------------------------------------------------

test('verbs and the send options', () => {
  assert.equal(parseCli(['printers']).verb, 'printers');
  const s = parseCli(['send', 'a.pdf', '-p', 'Foo', '-n', '2', '--dpi', '300', '-q', 'high', '--gray', '--duplex', '--pages', '1-3', '--landscape']);
  assert.equal(s.printer, 'Foo');
  assert.equal(s.copies, 2);
  assert.equal(s.dpi, 300);
  assert.equal(s.quality, 'high');
  assert.equal(s.colorMode, 'monochrome');
  assert.equal(s.sides, 'two-sided-long-edge');
  assert.equal(s.pages, '1-3');
  assert.equal(s.landscape, true);
  assert.equal(s.fit, null);
  assert.deepEqual(parseCli(['--help']), { help: true });
});

test('usage errors: no verb, unknown verb, missing file, exclusive flags', () => {
  assert.throws(() => parseCli([]), /no verb/);
  assert.throws(() => parseCli(['burn']), /unknown verb "burn"/);
  assert.throws(() => parseCli(['send']), /at least one file/);
  assert.throws(() => parseCli(['send', 'a', '--gray', '--color']), /exclusive/);
  assert.throws(() => parseCli(['cancel']), /needs a job id/);
  assert.throws(() => parseCli(['unstick']), /needs a printer/);
});

test('ceilings are refused, not lowered (SENSIBILITIES #3)', () => {
  assert.equal(parseCopies(undefined), 1);
  assert.equal(parseCopies(String(MAX_COPIES)), MAX_COPIES);
  assert.throws(() => parseCopies(String(MAX_COPIES + 1)), /exceeds the \d+ ceiling/);
  assert.throws(() => parseCopies('0'), /positive integer/);
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => `f${i}.pdf`);
  assert.throws(() => parseCli(['send', ...files]), /at most \d+ files/);
});

test('dpi, quality and page ranges', () => {
  assert.equal(parseDpi('300dpi'), 300);
  assert.throws(() => parseDpi('301'), /must be 150, 300, 600 or 1200/);
  assert.equal(parseQuality('Draft'), 'draft');
  assert.throws(() => parseQuality('best'), /draft, normal or high/);
  assert.equal(parsePages('1-3,5'), '1-3,5');
  assert.throws(() => parsePages('1;2'), /must look like/);
  assert.equal(countRange('1-3,5', 10), 4);
  assert.equal(countRange('1-30', 4), 4);
});

// ---- file inspection ---------------------------------------------------------

test('page counts: pdf by /Type /Page, images one, text by lines, other unknown', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>\n');
  assert.deepEqual(inspectFile('x.pdf', pdf), { kind: 'pdf', pages: 2 });
  assert.deepEqual(inspectFile('x.png', Buffer.alloc(4)), { kind: 'image', pages: 1 });
  assert.deepEqual(inspectFile('x.txt', Buffer.from(Array(130).fill('l').join('\n'))), { kind: 'text', pages: 3 });
  assert.deepEqual(inspectFile('x.docx', Buffer.alloc(4)), { kind: 'other', pages: null });
});

// ---- the plan ----------------------------------------------------------------

const opts = (extra = {}) => ({ ...parseCli(['send', 'x', '-p', 'P']), printer: 'P', ...extra });
const img = { path: '/t/a.png', bytes: 1e6, kind: 'image', pages: 1 };
const pdf3 = { path: '/t/b.pdf', bytes: 1e6, kind: 'pdf', pages: 3 };
const mono = { colorSupported: false, resolutions: [300, 600, 1200], defaultDpi: 600 };

test('no resolution or quality override unless asked; images fit to page; a mono printer gets monochrome', () => {
  const plan = buildPlan(opts(), [img], mono);
  assert.equal(plan.dpi, 600);
  assert.equal(plan.dpiExplicit, false);
  assert.ok(!plan.opts.some((x) => x.startsWith('printer-resolution=') || x.startsWith('print-quality=')));
  assert.ok(plan.opts.includes('print-color-mode=monochrome'));
  assert.ok(plan.opts.includes('fit-to-page'));
  assert.deepEqual(plan.args.slice(0, 2), ['-d', 'P']);
  assert.ok(plan.args.includes('-t') && plan.args[plan.args.indexOf('-t') + 1] === 'a.png', 'title defaults to the file name so the watchdog can find the job on the printer');
});

test('a big image raster is described as slow, never as stuck; overrides warn about the garbage risk', () => {
  const plan = buildPlan(opts(), [img], mono);
  assert.ok(plan.rasterMB > RASTER_SLOW_MB);
  assert.match(plan.warnings.join('\n'), /several minutes.*do not cancel early/);
  assert.doesNotMatch(plan.warnings.join('\n'), /stall|stuck|--dpi 300/);
  const pdfPlan = buildPlan(opts(), [pdf3], mono);
  assert.deepEqual(pdfPlan.warnings, []);
  const forced = buildPlan(opts({ dpi: 300 }), [img], mono);
  assert.ok(forced.opts.includes('printer-resolution=300dpi'));
  assert.match(forced.warnings.join('\n'), /200 pages of binary garbage/);
});

test('sheets = pages x copies, halved for duplex; the sheet ceiling throws', () => {
  assert.equal(buildPlan(opts({ copies: 2 }), [pdf3], mono).sheets, 6);
  assert.equal(buildPlan(opts({ sides: 'two-sided-long-edge' }), [pdf3], mono).sheets, 2);
  assert.equal(buildPlan(opts({ pages: '1-2' }), [pdf3], mono).sheets, 2);
  const big = { ...pdf3, pages: MAX_SHEETS + 1 };
  assert.throws(() => buildPlan(opts(), [big], mono), /exceeds the \d+ ceiling/);
  const unknown = buildPlan(opts(), [{ ...pdf3, pages: null }], mono);
  assert.equal(unknown.unknownPages, true);
});

test('renderPlan shows the exact lp line and the --yes hint only in preview', () => {
  const o = opts();
  const plan = buildPlan(o, [img], mono);
  const out = renderPlan(plan, o, [img], true);
  assert.match(out, /PREVIEW, nothing sent/);
  assert.match(out, /command: {3}lp -d P /);
  assert.match(out, /Re-run with --yes/);
  assert.doesNotMatch(renderPlan(plan, o, [img], false), /--yes/);
});

// ---- diagnosis ---------------------------------------------------------------

test('diagnose names paper-out, the job-incoming stall, and nothing when healthy', () => {
  assert.match(diagnose({ 'printer-state-reasons': ['media-empty-warning', 'paused'] }, []), /out of paper/);
  assert.match(diagnose({ 'printer-state-reasons': 'none' }, [{ id: 7, reasons: 'job-incoming,job-printing', progress: '0', name: 'x' }]), /still being received.*Give it 5 minutes/);
  assert.doesNotMatch(diagnose({ 'printer-state-reasons': 'none' }, [{ id: 7, reasons: 'job-incoming', progress: '0', name: 'x' }]), /--dpi 300/);
  assert.equal(diagnose({ 'printer-state-reasons': 'none' }, []), null);
});

// ---- CUPS parsers ------------------------------------------------------------

test('lpstat -p -d, -v and -o parse', () => {
  const p = parseLpstatPrinters(`printer Brother is idle.  enabled since Sat Aug 29 10:41:55 2026
printer Epson now printing Epson-3.  enabled since Tue Jun  2 19:32:46 2026
\tConnected to printer.
printer Old disabled since Mon Jan  1 00:00:00 2026 -
\tPaused
system default destination: Brother
`);
  assert.deepEqual(p.printers.map((x) => [x.name, x.state]), [['Brother', 'idle'], ['Epson', 'printing'], ['Old', 'disabled']]);
  assert.equal(p.printers[1].reason, 'Connected to printer.');
  assert.equal(p.default, 'Brother');
  assert.deepEqual(parseLpstatDevices('device for Brother: dnssd://Brother%20X._ipp._tcp.local./?uuid=1\n'), { Brother: 'dnssd://Brother%20X._ipp._tcp.local./?uuid=1' });
  const j = parseLpstatJobs('Brother-102 robgruhl        506880   Sat Aug 29 13:59:19 2026\n');
  assert.deepEqual(j, [{ id: 'Brother-102', printer: 'Brother', seq: 102, user: 'robgruhl', bytes: 506880, submitted: 'Sat Aug 29 13:59:19 2026' }]);
});

test('ipptool -tv output: merged attrs, per-job groups, PASS/FAIL', () => {
  const out = `"/usr/share/cups/ipptool/get-jobs.test":
    Get pending jobs                                                     [FAIL]
        job-id (integer) = 5
        job-state (enum) = processing
        job-state-reasons (1setOf keyword) = job-incoming,job-printing
        job-name (nameWithLanguage) = a.png[en-us]
        job-impressions-completed (integer) = 0
        job-id (integer) = 6
        job-state (enum) = pending
        job-state-reasons (keyword) = none
        job-name (nameWithLanguage) = b.pdf[en-us]
        job-impressions-completed (integer) = 0
`;
  const r = parseIpptool(out);
  assert.equal(r.passed, false);
  assert.deepEqual(r.attrs['job-id'], ['5', '6']);
  const jobs = groupJobs(r.groups);
  assert.deepEqual(jobs.map((j) => [j.id, j.state, j.reasons, j.name]), [[5, 'processing', 'job-incoming,job-printing', 'a.png'], [6, 'pending', 'none', 'b.pdf']]);
});

test('device URIs: ipp direct, dnssd needs resolving, usb has no IPP path', () => {
  assert.equal(directIppUri('ipp://BRW1.local.:631/ipp/print'), 'ipp://BRW1.local:631/ipp/print');
  assert.equal(directIppUri('ipps://host/ipp/print'), 'ipps://host/ipp/print');
  assert.equal(directIppUri('dnssd://X._ipp._tcp.local./?uuid=1'), null);
  assert.equal(dnssdService('dnssd://Brother%20MFC-L2750DW%20series._ipp._tcp.local./?uuid=e3'), 'Brother MFC-L2750DW series._ipp._tcp.local.');
  assert.equal(dnssdService('usb://Brother/MFC?serial=1'), null);
});

// ---- audit + cache -----------------------------------------------------------

test('audit appends a 600-mode line and the host cache round-trips', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'print-test-'));
  const file = path.join(home, 'audit.log');
  const err = console.error; const lines = []; console.error = (l) => lines.push(l);
  try { audit({ verb: 'send', printer: 'P', job: 'P-1', title: 'two words' }, { home, file }); } finally { console.error = err; }
  const body = readFileSync(file, 'utf8');
  assert.match(body, /^\[print audit\] \S+ verb=send printer=P job=P-1 title="two words"\n$/);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(lines.length, 1);
  const c = hostCache(path.join(home, 'hosts.json'));
  assert.equal(c.get('P'), null);
  c.set('P', 'ipp://p.local:631/ipp/print');
  assert.equal(hostCache(path.join(home, 'hosts.json')).get('P'), 'ipp://p.local:631/ipp/print');
  c.drop('P');
  assert.equal(hostCache(path.join(home, 'hosts.json')).get('P'), null);
  rmSync(home, { recursive: true, force: true });
});

// ---- manifest parity ---------------------------------------------------------

test('the manifest verbs[] matches the VERBS table in the code', () => {
  const m = JSON.parse(readFileSync(new URL('../toolbelt.json', import.meta.url), 'utf8'));
  const declared = Object.fromEntries(m.verbs.filter((v) => v.tier !== 'never').map((v) => [v.name.split(' ')[0], v.tier]));
  assert.deepEqual(declared, VERBS);
});

test('a named quality always carries an explicit dpi, never 1200; --paper maps to media-type', () => {
  const hi = buildPlan(opts({ quality: 'high' }), [pdf3], mono);
  assert.ok(hi.opts.includes('print-quality=5'));
  assert.ok(hi.opts.includes('printer-resolution=600dpi'));
  const draft = buildPlan(opts({ quality: 'draft' }), [pdf3], mono);
  assert.ok(draft.opts.includes('printer-resolution=300dpi'));
  assert.match(draft.warnings.join('\n'), /overrides are the risky path/);
  const glossy = buildPlan(opts({ paper: 'photographic-glossy', colorMode: 'color' }), [img], { colorSupported: true, resolutions: [300, 600], defaultDpi: 300 });
  assert.ok(glossy.opts.includes('media-type=photographic-glossy'));
  assert.ok(glossy.opts.includes('print-color-mode=color'));
});
