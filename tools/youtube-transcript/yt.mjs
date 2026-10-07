#!/usr/bin/env node
// yt — read-only YouTube caption fetcher for the Toolbelt.
//
// Two backends, both read-only, no API key, the operator's own egress:
//   innertube  @danielxceron/youtube-transcript (HTML scrape + InnerTube fallback) — default
//   ytdlp      `yt-dlp --skip-download --write-auto-subs` + scripts/clean_vtt.py — the
//              fallback when InnerTube answers "disabled"/"unavailable" for a video that
//              visibly has captions; yt-dlp keeps pace with YouTube's page changes
//
// Every verb is a read. The only files written are ones the operator names with --out, and
// an existing file is never overwritten without --force. The markers `SENSIBILITIES #n` show
// where each belt pattern lives.

import { writeFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.2.0';

// ---- ceilings (SENSIBILITIES #3): code constants, not flags ----------------------------
export const MAX_BATCH = 20;          // videos per `batch` call; above it exits 2
export const BATCH_DELAY_MS = 1500;   // pause between videos in `batch` (SENSIBILITIES #9)
export const MAX_CONTEXT = 5;         // --context ceiling for `search`
export const DEFAULT_CONTEXT = 1;
export const TIMEOUT_MS = 30_000;     // per network call, both backends
export const DEFAULT_LANG = 'en';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLEAN_VTT = path.join(HERE, 'scripts', 'clean_vtt.py');

export const VERBS = ['fetch', 'search', 'stats', 'batch', 'ytdlp'];
export const FORMATS = ['text', 'timestamped', 'segments', 'json', 'srt', 'md'];

const USAGE = `yt ${VERSION} — read-only YouTube captions, no API key

  node yt.mjs fetch  <url|id> [--lang xx] [--format F] [--out FILE]   captions via InnerTube (default backend)
  node yt.mjs search <url|id> <query> [--lang xx] [--context N]        segments matching a term, with context
  node yt.mjs stats  <url|id> [--lang xx]                              segments, words, duration, language
  node yt.mjs batch  <url|id>... [--lang xx]                           stats per video, ${BATCH_DELAY_MS}ms apart, max ${MAX_BATCH}
  node yt.mjs ytdlp  <url|id> [--lang xx] [--out FILE]                 captions via yt-dlp + clean_vtt.py (markdown)

  --format   ${FORMATS.join(' | ')}   (default: timestamped)
  --out      write to FILE instead of stdout; refuses to overwrite unless --force
  --explain  pre-flight: print what would be fetched, make no call
  --json     machine output where the verb has one (search, stats, batch)

Ceilings (code constants in yt.mjs): MAX_BATCH=${MAX_BATCH}, MAX_CONTEXT=${MAX_CONTEXT}, TIMEOUT_MS=${TIMEOUT_MS}.
Exit: 0 ok · 1 no captions / network / backend missing · 2 usage.`;

// ---- pure helpers -------------------------------------------------------------------------

/** 11-char video id from a bare id or any youtube.com / youtu.be URL; throws otherwise. */
export function extractVideoId(input) {
  if (typeof input !== 'string') throw new Error('video id must be a string');
  const s = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  throw new Error(`not a YouTube video id or URL: ${input}`);
}

/** Seconds → M:SS or H:MM:SS. */
export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function srtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Render segments [{text, offset, duration, lang}] in one of FORMATS. */
export function render(segments, format, meta = {}) {
  switch (format) {
    case 'text':
      return segments.map((s) => s.text).join(' ');
    case 'timestamped':
      return segments.map((s) => `[${formatTime(s.offset)}] ${s.text}`).join('\n');
    case 'segments':
      return segments.map((s) => `${s.offset.toFixed(2)}\t${s.duration.toFixed(2)}\t${s.text}`).join('\n');
    case 'json':
      return JSON.stringify(segments, null, 2);
    case 'srt':
      return segments
        .map((s, i) => `${i + 1}\n${srtTime(s.offset)} --> ${srtTime(s.offset + s.duration)}\n${s.text}\n`)
        .join('\n');
    case 'md': {
      // Paragraphs of ~45s, the same grouping clean_vtt.py uses, so both backends read alike.
      const paras = [];
      let cur = null;
      for (const s of segments) {
        if (!cur || s.offset - cur.start > 45) {
          cur = { start: s.offset, parts: [] };
          paras.push(cur);
        }
        cur.parts.push(s.text);
      }
      const body = paras
        .map((p) => `**[${formatTime(p.start).padStart(5, '0')}]** ${p.parts.join(' ').replace(/\s+/g, ' ').trim()}`)
        .join('\n\n');
      return markdownDoc({ ...meta, note: 'YouTube captions via InnerTube (timestamps ≈ paragraph start)' }, body);
    }
    default:
      throw new Error(`unknown format "${format}" — one of ${FORMATS.join(', ')}`);
  }
}

export function markdownDoc(meta, body) {
  const lines = [`# ${meta.title ?? meta.videoId}`, ''];
  lines.push(`- **Source:** ${meta.channel ? `${meta.channel} — ` : ''}https://www.youtube.com/watch?v=${meta.videoId}`);
  if (meta.published || meta.length) {
    lines.push(`- **Published:** ${meta.published ?? 'unknown'} · **Length:** ${meta.length ?? 'unknown'}`);
  }
  lines.push(`- **Transcript:** ${meta.note}`, '', '---', '', body, '');
  return lines.join('\n');
}

export function stats(segments) {
  const text = segments.map((s) => s.text).join(' ');
  const last = segments[segments.length - 1];
  const total = last ? last.offset + last.duration : 0;
  return {
    segments: segments.length,
    words: text.split(/\s+/).filter(Boolean).length,
    duration: formatTime(total),
    durationSeconds: Math.round(total),
    lang: segments[0]?.lang || 'unknown',
  };
}

export function searchSegments(segments, query, context = DEFAULT_CONTEXT) {
  const needle = query.toLowerCase();
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].text.toLowerCase().includes(needle)) continue;
    const lo = Math.max(0, i - context);
    const hi = Math.min(segments.length, i + context + 1);
    out.push({
      match: { ...segments[i], time: formatTime(segments[i].offset) },
      context: segments.slice(lo, hi).map((s) => ({ ...s, time: formatTime(s.offset) })),
    });
  }
  return out;
}

export function clampContext(raw) {
  if (raw === undefined) return DEFAULT_CONTEXT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--context must be a non-negative integer, got "${raw}"`);
  if (n > MAX_CONTEXT) throw new Error(`--context ${n} exceeds the ${MAX_CONTEXT} ceiling (MAX_CONTEXT, a code constant in yt.mjs)`);
  return n;
}

export function parseCli(argv) {
  const opts = { lang: DEFAULT_LANG, format: 'timestamped', out: null, force: false, explain: false, json: false, context: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--version') return { version: true };
    if (a === '--lang') opts.lang = takeValue();
    else if (a === '--format') opts.format = takeValue();
    else if (a === '--out') opts.out = takeValue();
    else if (a === '--context') opts.context = takeValue();
    else if (a === '--force') opts.force = true;
    else if (a === '--explain') opts.explain = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  const [verb, ...rest] = positional;
  if (!verb) throw new Error('no verb given');
  if (!VERBS.includes(verb)) throw new Error(`unknown verb "${verb}" — one of ${VERBS.join(', ')}`);
  if (!FORMATS.includes(opts.format)) throw new Error(`unknown --format "${opts.format}" — one of ${FORMATS.join(', ')}`);
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(opts.lang)) throw new Error(`--lang must be a language code like en or pt-BR, got "${opts.lang}"`);
  opts.context = clampContext(opts.context);

  if (verb === 'batch') {
    if (rest.length === 0) throw new Error('batch needs one or more <url|id>');
    if (rest.length > MAX_BATCH) throw new Error(`batch of ${rest.length} exceeds the ${MAX_BATCH} ceiling (MAX_BATCH, a code constant in yt.mjs)`);
    return { verb, ids: rest.map(extractVideoId), ...opts };
  }
  if (rest.length === 0) throw new Error(`${verb} needs a <url|id>`);
  const videoId = extractVideoId(rest[0]);
  if (verb === 'search') {
    const query = rest.slice(1).join(' ').trim();
    if (!query) throw new Error('search needs a <query> after the video');
    return { verb, videoId, query, ...opts };
  }
  if (rest.length > 1) throw new Error(`${verb} takes exactly one <url|id>`);
  return { verb, videoId, ...opts };
}

// ---- output -------------------------------------------------------------------------------

/** --out is the one file write (operator-named, local). Existing files are not overwritten. */
export function emit(text, out, force) {
  if (!out) {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    return;
  }
  if (existsSync(out) && !force) {
    throw new Error(`${out} exists — pass --force to overwrite it`);
  }
  writeFileSync(out, text.endsWith('\n') ? text : text + '\n', 'utf8');
  process.stderr.write(`wrote ${Buffer.byteLength(text)} bytes to ${out}\n`);
}

function audit(verb, backend, target) {
  // SENSIBILITIES #7 — one grep-able line per network call, before it is made.
  process.stderr.write(`[yt] ${new Date().toISOString()} verb=${verb} backend=${backend} target=${target}\n`);
}

function withTimeout(promise, what) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${TIMEOUT_MS}ms (TIMEOUT_MS)`)), TIMEOUT_MS);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// ---- backend: innertube --------------------------------------------------------------------

async function fetchInnertube(videoId, lang, verb) {
  const { YoutubeTranscript } = await import('@danielxceron/youtube-transcript');
  audit(verb, 'innertube', videoId);
  try {
    return await withTimeout(YoutubeTranscript.fetchTranscript(videoId, { lang }), `innertube ${videoId}`);
  } catch (e) {
    const name = e?.constructor?.name ?? '';
    if (/TooManyRequest/.test(name)) throw new Error(`YouTube is rate-limiting this IP (${videoId}); wait, or use \`ytdlp\` which carries its own client headers`);
    if (/Disabled|NotAvailable|Empty/.test(name)) {
      throw new Error(`no captions via InnerTube for ${videoId} (${name.replace('YoutubeTranscript', '')}) — try: node yt.mjs ytdlp ${videoId} --lang ${lang}`);
    }
    throw e;
  }
}

// ---- backend: yt-dlp -----------------------------------------------------------------------

export function ytdlpPath() {
  const r = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runYtdlp(args) {
  const r = spawnSync('yt-dlp', args, { encoding: 'utf8', timeout: TIMEOUT_MS * 2 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`yt-dlp exited ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
  return r.stdout;
}

async function fetchYtdlp(videoId, lang) {
  if (!ytdlpPath()) {
    throw new Error('yt-dlp is not on PATH — brew install yt-dlp (the innertube backend is unaffected: node yt.mjs fetch …)');
  }
  // The URL is rebuilt from the validated id so nothing the caller typed reaches yt-dlp's argv.
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const work = mkdtempSync(path.join(tmpdir(), 'yt-'));
  try {
    audit('ytdlp', 'yt-dlp', videoId);
    const meta = runYtdlp(['--skip-download', '--no-warnings', '--print', '%(title)s\t%(channel)s\t%(upload_date)s\t%(duration_string)s', url]).trim();
    const [title, channel, date, length] = meta.split('\t');
    runYtdlp(['--skip-download', '--no-warnings', '--write-subs', '--write-auto-subs',
      '--sub-langs', `${lang},${lang}-orig`, '--sub-format', 'vtt', '-o', path.join(work, 'cap'), url]);
    const vtts = readdirSync(work).filter((f) => f.endsWith('.vtt')).sort();
    if (vtts.length === 0) {
      throw new Error(`yt-dlp found no "${lang}" captions for ${videoId}; see: yt-dlp --list-subs ${url}`);
    }
    const preferred = vtts.find((f) => f === `cap.${lang}.vtt`) ?? vtts[0];
    const py = spawnSync('python3', [CLEAN_VTT, path.join(work, preferred)], { encoding: 'utf8' });
    if (py.status !== 0) throw new Error(`clean_vtt.py failed: ${(py.stderr || '').trim()}`);
    const published = /^\d{8}$/.test(date ?? '') ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : date;
    return markdownDoc(
      { videoId, title, channel, published, length, note: `YouTube captions via yt-dlp (${preferred.replace('cap.', '')}), cleaned; timestamps ≈ paragraph start` },
      py.stdout.trim(),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- main ----------------------------------------------------------------------------------

export function renderExplain(c) {
  const lines = [`verb: ${c.verb}`];
  if (c.verb === 'batch') lines.push(`videos (${c.ids.length}/${MAX_BATCH}): ${c.ids.join(' ')}`, `delay: ${BATCH_DELAY_MS}ms between videos`);
  else lines.push(`video: ${c.videoId} (https://www.youtube.com/watch?v=${c.videoId})`);
  lines.push(`lang: ${c.lang}`);
  if (c.verb === 'ytdlp') {
    const v = ytdlpPath();
    lines.push(`backend: yt-dlp ${v ? `(${v}) --skip-download --write-subs --write-auto-subs` : '— NOT ON PATH (brew install yt-dlp)'}`);
    lines.push(`post-process: python3 ${CLEAN_VTT}`);
  } else {
    lines.push('backend: innertube (@danielxceron/youtube-transcript): GET watch page, fall back to InnerTube player API');
  }
  if (c.verb === 'fetch') lines.push(`format: ${c.format}`);
  if (c.verb === 'search') lines.push(`query: "${c.query}", context ±${c.context}`);
  if (c.out) lines.push(`output: ${c.out}${existsSync(c.out) ? (c.force ? ' (exists; --force overwrites)' : ' (exists; would refuse without --force)') : ''}`);
  else lines.push('output: stdout');
  lines.push(`timeout: ${TIMEOUT_MS}ms`, 'auth: none — the operator\'s own egress, no key', '(pre-flight only: no call made)');
  return lines.join('\n');
}

async function main(argv) {
  let c;
  try {
    c = parseCli(argv);
  } catch (e) {
    process.stderr.write(`yt: ${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (c.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (c.version) { process.stdout.write(VERSION + '\n'); return 0; }
  if (c.explain) { process.stdout.write(renderExplain(c) + '\n'); return 0; }

  try {
    switch (c.verb) {
      case 'fetch': {
        let segs;
        try {
          segs = await fetchInnertube(c.videoId, c.lang, 'fetch');
        } catch (e) {
          // SENSIBILITIES #8 — degraded mode, named: markdown output can come from yt-dlp instead.
          if (c.format === 'md' && /no captions via InnerTube/.test(e.message) && ytdlpPath()) {
            process.stderr.write(`[yt] degraded: InnerTube gave no captions for ${c.videoId}; falling back to the yt-dlp backend\n`);
            emit(await fetchYtdlp(c.videoId, c.lang), c.out, c.force);
            return 0;
          }
          throw e;
        }
        emit(render(segs, c.format, { videoId: c.videoId }), c.out, c.force);
        return 0;
      }
      case 'search': {
        const segs = await fetchInnertube(c.videoId, c.lang, 'search');
        const hits = searchSegments(segs, c.query, c.context);
        if (c.json) emit(JSON.stringify(hits, null, 2), c.out, c.force);
        else if (hits.length === 0) emit(`no segment contains "${c.query}" in ${segs.length} segments (${c.lang})`, c.out, c.force);
        else emit(hits.map((h) => h.context.map((s) => `${s === h.context.find((x) => x.offset === h.match.offset) ? '>' : ' '} [${s.time}] ${s.text}`).join('\n')).join('\n\n'), c.out, c.force);
        return 0;
      }
      case 'stats': {
        const segs = await fetchInnertube(c.videoId, c.lang, 'stats');
        const s = stats(segs);
        emit(c.json ? JSON.stringify(s, null, 2) : `${c.videoId}: ${s.segments} segments, ${s.words} words, ${s.duration}, lang=${s.lang}`, c.out, c.force);
        return 0;
      }
      case 'batch': {
        const rows = [];
        for (let i = 0; i < c.ids.length; i++) {
          const id = c.ids[i];
          try {
            rows.push({ id, ...stats(await fetchInnertube(id, c.lang, 'batch')) });
          } catch (e) {
            rows.push({ id, error: e.message });
          }
          if (i < c.ids.length - 1) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
        emit(c.json ? JSON.stringify(rows, null, 2)
          : rows.map((r) => r.error ? `${r.id}: ERROR ${r.error}` : `${r.id}: ${r.segments} segments, ${r.words} words, ${r.duration}, lang=${r.lang}`).join('\n'),
        c.out, c.force);
        return rows.some((r) => r.error) ? 1 : 0;
      }
      case 'ytdlp': {
        emit(await fetchYtdlp(c.videoId, c.lang), c.out, c.force);
        return 0;
      }
      default:
        return 2;
    }
  } catch (e) {
    process.stderr.write(`yt: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
