#!/usr/bin/env node
// spiral-book — scaffold and build spiral-bound books: Markdown chapters → pandoc → Typst →
// PDF → imposed print-ready PDF. Zero Node dependencies; pandoc and typst are system
// binaries (brew), pypdf comes from this directory's poetry env.
//
// Containment (SENSIBILITIES #2): every write lands inside the ONE project directory the
// operator names on the command line. Paths are resolved and checked against that root
// before any file is touched; a chapter stem that could escape it (`..`, `/`) is rejected
// at parse time. Nothing here reaches the network, a credential, or a shared system.
//
// Exit codes: 0 done or previewed · 1 a dependency or the pipeline failed · 2 usage
//             (including a --yes-gated verb run without --yes and without a terminal preview).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOL = 'spiral-book';
export const VERSION = '0.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, 'templates');

// ---------------------------------------------------------------- ceilings (code, not flags — SENSIBILITIES #3)

/** Thumb tabs become unreadable past ~25 chapters; 40 is the hard stop, refused not lowered. */
export const MAX_CHAPTERS = 40;
/** Pandoc and typst each get this long per invocation; a hung compile exits 1, no retry. */
export const STEP_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------- tiers (data, not prose)

/** Every verb's tier as the manifest declares it; the test suite asserts the two agree. */
export const VERBS = {
  check: { tier: 'read' },
  plan: { tier: 'read' },
  scaffold: { tier: 'write-gated', gate: 'containment' },
  build: { tier: 'read', note: 'regenerates derived files (*.md.typ, the PDFs) inside the named project; never touches a chapter .md' },
  impose: { tier: 'read', note: 'writes one derived PDF next to the book PDF inside the named project' },
  clean: { tier: 'write-gated', gate: 'flag' },
};

export function tierOf(verb) {
  return VERBS[verb] ?? null;
}

// ---------------------------------------------------------------- page geometry and palette

export const SIZES = {
  'half-letter': { width: '5.5in', height: '8.5in', imposable: true },
  letter: { width: '8.5in', height: '11in', imposable: false },
  a5: { width: '148mm', height: '210mm', imposable: false },
};
export const BINDINGS = { spiral: '0.85in', perfect: '0.6in' };

/** Section colors in assignment order. `gray` is always emitted: layout.typ falls back to
 *  `color-gray` for pages outside any section (the contents page, placeholders). */
export const PALETTE = [
  ['gray', '#5C6370', '#E8EAED'],
  ['blue', '#2B7A9B', '#DCEEF5'],
  ['green', '#3E8E5A', '#DDF0E3'],
  ['orange', '#D1782B', '#FBE8D8'],
  ['purple', '#6F4FA3', '#E8E0F3'],
  ['red', '#B8423E', '#F6DEDD'],
];

// ---------------------------------------------------------------- environment

export function makeEnv(overrides = {}) {
  return {
    out: overrides.out ?? ((s) => process.stdout.write(s + '\n')),
    err: overrides.err ?? ((s) => process.stderr.write(s + '\n')),
    now: overrides.now ?? (() => Date.now()),
    stdinIsTTY: overrides.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    python: overrides.python ?? process.env.SPIRAL_BOOK_PYTHON ?? path.join(HERE, '.venv', 'bin', 'python'),
    which: overrides.which ?? which,
    run: overrides.run ?? run,
  };
}

function which(bin) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: STEP_TIMEOUT_MS, ...opts });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}

function audit(env, verb, target, extra = '') {
  env.err(`[${TOOL} audit] ${new Date(env.now()).toISOString()} verb=${verb} target=${target}${extra ? ' ' + extra : ''}`);
}

// ---------------------------------------------------------------- containment

/** The project root: resolved once, absolute. Every write is checked against it. */
export function resolveProject(dir) {
  if (!dir) return null;
  return path.resolve(dir);
}

export function isInside(root, p) {
  const rel = path.relative(root, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function contained(root, p) {
  if (!isInside(root, p)) throw new Error(`refusing to write outside the project: ${p} is not under ${root}`);
  return p;
}

/** `NN-slug` only: digits, a dash, lowercase slug. No separators that could leave the dir. */
export const STEM_RE = /^\d{2}-[a-z0-9][a-z0-9-]*$/;

/** `stem[:TAB[:Section]]` → {stem, tab, section}. */
export function parseChapter(spec) {
  const [stem, tab, section] = spec.split(':');
  if (!STEM_RE.test(stem ?? '')) throw new Error(`chapter "${spec}": stem must look like 01-intro (NN-slug, lowercase)`);
  const label = (tab && tab.trim()) || stem.slice(3).split('-')[0].toUpperCase();
  if (label.length > 8) throw new Error(`chapter "${spec}": tab label "${label}" is ${label.length} chars; 8 is the most a thumb tab can show`);
  if (!/^[A-Z0-9 ]+$/.test(label)) throw new Error(`chapter "${spec}": tab label must be A-Z, 0-9, space`);
  return { stem, tab: label, section: (section && section.trim()) || 'Main' };
}

// ---------------------------------------------------------------- rendering

function fill(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'book';
}

function typstString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The book model from parsed flags: sections in first-seen order, each with a palette color. */
export function planBook({ title, author, chapters, size = 'half-letter', binding = 'spiral', fonts = {} }) {
  if (!title) throw new Error('--title is required');
  if (!chapters?.length) throw new Error('at least one --chapter is required');
  if (chapters.length > MAX_CHAPTERS) throw new Error(`${chapters.length} chapters exceeds MAX_CHAPTERS=${MAX_CHAPTERS} (a code constant in spiral-book.mjs; thumb tabs are unreadable past ~25)`);
  if (!SIZES[size]) throw new Error(`--size must be one of ${Object.keys(SIZES).join('|')}`);
  if (!BINDINGS[binding]) throw new Error(`--binding must be one of ${Object.keys(BINDINGS).join('|')}`);
  const seen = new Set();
  const parsed = chapters.map(parseChapter);
  for (const c of parsed) {
    if (seen.has(c.stem)) throw new Error(`chapter stem ${c.stem} appears twice`);
    seen.add(c.stem);
  }
  const sectionNames = [...new Set(parsed.map((c) => c.section))];
  if (sectionNames.length > PALETTE.length) throw new Error(`${sectionNames.length} sections; the palette has ${PALETTE.length} colors (2-6 sections read best)`);
  const sections = sectionNames.map((name, i) => ({ name, color: PALETTE[i][0], hex: PALETTE[i][1], light: PALETTE[i][2] }));
  const colorOf = Object.fromEntries(sections.map((s) => [s.name, s.color]));
  return {
    title, author: author || '', slug: slugify(title), size, binding,
    fonts: { body: fonts.body || 'Georgia', heading: fonts.heading || 'Helvetica Neue', mono: fonts.mono || 'Menlo' },
    sections,
    chapters: parsed.map((c, i) => ({ ...c, order: i + 1, color: colorOf[c.section] })),
  };
}

export function renderTheme(book) {
  const palette = book.sections.some((s) => s.color === 'gray') ? book.sections : [{ name: '(fallback)', color: 'gray', hex: PALETTE[0][1], light: PALETTE[0][2] }, ...book.sections];
  const colors = [
    ...palette.map((s) => `#let color-${s.color.padEnd(7)} = rgb("${s.hex}")   // ${s.name}`),
    '',
    ...palette.map((s) => `#let color-${s.color}-light = rgb("${s.light}")`),
  ].join('\n');
  const sections = book.chapters.map((c) => `  "${c.stem}": (tab: "${typstString(c.tab)}", color: color-${c.color}, order: ${c.order}),`).join('\n');
  return fill(readFileSync(path.join(TEMPLATES, 'theme.typ'), 'utf8'), {
    TITLE: book.title, COLORS: colors, SECTIONS: sections, TOTAL_TABS: String(book.chapters.length),
    FONT_BODY: book.fonts.body, FONT_HEADING: book.fonts.heading, FONT_MONO: book.fonts.mono,
  });
}

export function renderLayout(book) {
  const s = SIZES[book.size];
  return fill(readFileSync(path.join(TEMPLATES, 'layout.typ'), 'utf8'), {
    TITLE: typstString(book.title), AUTHOR: typstString(book.author), PAGE_WIDTH: s.width, PAGE_HEIGHT: s.height, GUTTER: BINDINGS[book.binding],
  });
}

export function renderMain(book) {
  const lines = [];
  let current = null;
  for (const c of book.chapters) {
    if (c.section !== current) { current = c.section; lines.push(`\n// --- ${c.section} (${c.color}) ---`); }
    lines.push(`#section-start("${c.stem}")`, `#include "${c.stem}.md.typ"`);
  }
  return fill(readFileSync(path.join(TEMPLATES, 'main.typ'), 'utf8'), {
    TITLE: typstString(book.title), FIRST_COLOR: 'gray', CHAPTERS: lines.join('\n').trim(),
  });
}

export function renderBuildSh(book) {
  return fill(readFileSync(path.join(TEMPLATES, 'build.sh'), 'utf8'), {
    TITLE: book.title, SLUG: book.slug, SECTIONS_BASH: book.chapters.map((c) => `  ${c.stem}`).join('\n'),
  });
}

export function renderChapter(c) {
  const title = c.stem.slice(3).split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return fill(readFileSync(path.join(TEMPLATES, 'chapter.md'), 'utf8'), { TAB: c.tab, COLOR: c.color, SECTION: c.section, CHAPTER_TITLE: title });
}

/** Every file scaffold would write, relative to the project root, with its content. */
export function scaffoldFiles(book) {
  const files = new Map();
  files.set('.gitignore', readFileSync(path.join(TEMPLATES, 'gitignore'), 'utf8'));
  files.set('guide/template/theme.typ', renderTheme(book));
  files.set('guide/template/layout.typ', renderLayout(book));
  files.set('guide/main.typ', renderMain(book));
  files.set('guide/build.sh', renderBuildSh(book));
  files.set('guide/impose.py', readFileSync(path.join(TEMPLATES, 'impose.py'), 'utf8'));
  for (const c of book.chapters) files.set(`guide/${c.stem}.md`, renderChapter(c));
  return files;
}

// ---------------------------------------------------------------- the scaffolded project, read back

/** Chapter stems in build order, from the project's own build.sh SECTIONS array. */
export function readStems(root) {
  const sh = path.join(root, 'guide', 'build.sh');
  if (!existsSync(sh)) return null;
  const m = readFileSync(sh, 'utf8').match(/SECTIONS=\(\n([\s\S]*?)\n\)/);
  if (!m) return null;
  return m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function readSlug(root) {
  const sh = path.join(root, 'guide', 'build.sh');
  if (!existsSync(sh)) return null;
  const m = readFileSync(sh, 'utf8').match(/^OUTPUT="(.+)\.pdf"$/m);
  return m ? m[1] : null;
}

function derivedFiles(root) {
  const stems = readStems(root) ?? [];
  const slug = readSlug(root);
  const guide = path.join(root, 'guide');
  const list = stems.map((s) => path.join(guide, `${s}.md.typ`));
  if (slug) list.push(path.join(guide, `${slug}.pdf`), path.join(guide, `${slug}-print-ready.pdf`));
  return list.filter((p) => existsSync(p));
}

// ---------------------------------------------------------------- verbs

function cmdCheck(env, flags) {
  const rows = [];
  let rc = 0;
  for (const [bin, why, fix] of [
    ['pandoc', 'Markdown → Typst', 'brew install pandoc'],
    ['typst', 'Typst → PDF', 'brew install typst'],
  ]) {
    const p = env.which(bin);
    if (p) {
      const v = env.run(p, ['--version']).stdout.split('\n')[0].trim();
      rows.push({ dep: bin, status: 'ok', detail: `${v} (${p})` });
    } else { rows.push({ dep: bin, status: 'missing', detail: `${why} — fix: ${fix}` }); rc = 1; }
  }
  const py = existsSync(env.python) ? env.run(env.python, ['-c', 'import pypdf; print(pypdf.__version__)']) : null;
  rows.push(py && py.code === 0
    ? { dep: 'pypdf', status: 'ok', detail: `${py.stdout.trim()} (${env.python})` }
    : { dep: 'pypdf', status: 'degraded', detail: `not importable by ${env.python}; build skips imposition — fix: cd ${HERE} && poetry install` });
  const fsw = env.which('fswatch');
  rows.push(fsw ? { dep: 'fswatch', status: 'ok', detail: fsw } : { dep: 'fswatch', status: 'optional', detail: 'watch mode in a scaffolded build.sh needs it — brew install fswatch' });
  if (flags.json) env.out(JSON.stringify({ ok: rc === 0, deps: rows }));
  else for (const r of rows) env.out(`${r.status.padEnd(9)} ${r.dep.padEnd(8)} ${r.detail}`);
  return rc;
}

function parseBookFlags(flags) {
  return planBook({
    title: flags.title, author: flags.author, chapters: flags.chapter ?? [],
    size: flags.size ?? 'half-letter', binding: flags.binding ?? 'spiral',
    fonts: { body: flags['font-body'], heading: flags['font-heading'], mono: flags['font-mono'] },
  });
}

function cmdScaffold(env, dir, flags) {
  const root = resolveProject(dir);
  if (!root) return usage(env, 'scaffold needs the project directory to create');
  let book;
  try { book = parseBookFlags(flags); } catch (e) { return usage(env, e.message); }
  const files = scaffoldFiles(book);
  const existing = [...files.keys()].filter((rel) => existsSync(path.join(root, rel)));
  const chapters = existing.filter((rel) => rel.endsWith('.md'));
  const header = `scaffold ${book.title} → ${root}  (${book.chapters.length} chapter(s), ${book.sections.length} section(s), ${book.size}, ${book.binding}-bound)`;
  if (flags.explain) {
    env.out(`would create (tier: write-gated, gate: containment — every path is under ${root}):`);
    env.out(`  ${header}`);
    for (const rel of files.keys()) env.out(`  ${existing.includes(rel) ? (rel.endsWith('.md') ? 'keep   ' : (flags.force ? 'replace' : 'EXISTS ')) : 'create '} ${rel}`);
    if (existing.length && !flags.force) env.out(`${existing.length} file(s) already exist; re-run with --force to replace the template/build files (chapter .md files are never overwritten)`);
    return 0;
  }
  if (existing.length && !flags.force) {
    env.err(`${TOOL}: ${root} already holds ${existing.length} of these files (${existing.slice(0, 4).join(', ')}${existing.length > 4 ? ', …' : ''}).`);
    env.err(`Nothing written. --force replaces the generated template/build files and still keeps every chapter .md; --explain lists the plan.`);
    return 2;
  }
  let created = 0, replaced = 0, kept = 0;
  for (const [rel, content] of files) {
    const target = contained(root, path.join(root, rel));
    if (existsSync(target)) {
      if (rel.endsWith('.md')) { kept++; continue; }
      replaced++;
    } else created++;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    if (rel.endsWith('.sh')) chmodSync(target, 0o755);
  }
  audit(env, 'scaffold', root, `files=+${created} replaced=${replaced} kept=${kept}`);
  env.out(header);
  env.out(`created ${created}, replaced ${replaced}, kept ${kept} chapter file(s) — ${chapters.length ? 'existing chapters untouched; ' : ''}next: write guide/NN-*.md, then: ${TOOL} build ${quote(root)}`);
  return 0;
}

function cmdPlan(env, dir, flags) {
  const root = resolveProject(dir);
  if (!root) return usage(env, 'plan needs a project directory');
  const stems = readStems(root);
  if (!stems) { env.err(`${TOOL}: ${root} has no guide/build.sh with a SECTIONS array — not a spiral-book project (scaffold one first)`); return 1; }
  const slug = readSlug(root);
  const guide = path.join(root, 'guide');
  const rows = stems.map((s) => {
    const md = path.join(guide, `${s}.md`);
    const written = existsSync(md) && !/Replace this placeholder/.test(readFileSync(md, 'utf8'));
    return { stem: s, md: existsSync(md) ? (written ? 'written' : 'placeholder') : 'missing', typ: existsSync(path.join(guide, `${s}.md.typ`)) };
  });
  const pdf = slug ? path.join(guide, `${slug}.pdf`) : null;
  const print = slug ? path.join(guide, `${slug}-print-ready.pdf`) : null;
  const outputs = { pdf: pdf && existsSync(pdf) ? pdf : null, print_ready: print && existsSync(print) ? print : null };
  if (flags.json) { env.out(JSON.stringify({ root, slug, chapters: rows, outputs })); return 0; }
  env.out(`${root}  (${rows.length} chapter(s), output ${slug ?? '?'}.pdf)`);
  for (const r of rows) env.out(`  ${r.md.padEnd(12)} ${r.stem}${r.typ ? '' : '   (not yet converted)'}`);
  env.out(`  pdf: ${outputs.pdf ?? 'not built'}   print-ready: ${outputs.print_ready ?? 'not imposed'}`);
  return 0;
}

/** Pandoc one chapter to Typst; the tab comment is stripped here rather than by sed. */
function convertChapter(env, guide, stem) {
  const src = path.join(guide, `${stem}.md`);
  const dst = contained(guide, path.join(guide, `${stem}.md.typ`));
  const head = '#import "template/layout.typ": horizontalrule\n';
  if (!existsSync(src)) { writeFileSync(dst, `${head}// Placeholder — ${stem}.md not yet written\n`); return 'placeholder'; }
  const r = env.run('pandoc', [src, '--from', 'markdown', '--to', 'typst', '--wrap=none']);
  if (r.code !== 0) throw new Error(`pandoc failed on ${stem}.md: ${r.stderr.trim().split('\n').pop()}`);
  const body = r.stdout.split('\n').filter((l) => !l.startsWith('<!-- tab:')).join('\n');
  writeFileSync(dst, head + body);
  return 'converted';
}

function cmdBuild(env, dir, flags) {
  const root = resolveProject(dir);
  if (!root) return usage(env, 'build needs a project directory');
  const stems = readStems(root);
  const slug = readSlug(root);
  if (!stems || !slug) { env.err(`${TOOL}: ${root} is not a spiral-book project (no guide/build.sh with SECTIONS and OUTPUT)`); return 1; }
  const guide = path.join(root, 'guide');
  const pdf = path.join(guide, `${slug}.pdf`);
  if (flags.explain) {
    env.out(`would build ${root} (tier: read — writes only derived files under guide/):`);
    for (const s of stems) env.out(`  pandoc  ${s}.md → ${s}.md.typ`);
    env.out(`  typst   main.typ → ${slug}.pdf`);
    env.out(flags['no-impose'] ? '  impose  skipped (--no-impose)' : `  impose  ${slug}.pdf → ${slug}-print-ready.pdf (if pypdf is importable; otherwise degraded: skipped and named)`);
    return 0;
  }
  for (const [bin, fix] of [['pandoc', 'brew install pandoc'], ['typst', 'brew install typst']]) {
    if (!env.which(bin)) { env.err(`${TOOL}: ${bin} not found — fix: ${fix}`); return 1; }
  }
  let converted = 0, placeholders = 0;
  try {
    for (const s of stems) { if (convertChapter(env, guide, s) === 'converted') converted++; else placeholders++; }
  } catch (e) { env.err(`${TOOL}: ${e.message}`); return 1; }
  const t = env.run('typst', ['compile', 'main.typ', contained(guide, pdf)], { cwd: guide });
  if (t.code !== 0) {
    env.err(t.stderr.trim() || t.stdout.trim());
    env.err(`${TOOL}: typst compile failed (${t.signal ? 'timed out' : `exit ${t.code}`}); the .md.typ files are left in place for inspection`);
    return 1;
  }
  const pages = pdfPageCount(env, pdf);
  audit(env, 'build', root, `chapters=${stems.length} converted=${converted} placeholders=${placeholders} pdf=${slug}.pdf pages=${pages ?? '?'}`);
  env.out(`built ${pdf}${pages != null ? ` (${pages} pages)` : ''}${placeholders ? ` — ${placeholders} placeholder chapter(s) not yet written` : ''}`);
  if (flags['no-impose']) return 0;
  return doImpose(env, root, { degradeOk: true });
}

function pdfPageCount(env, pdf) {
  if (!existsSync(env.python)) return null;
  const r = env.run(env.python, ['-c', `import sys; from pypdf import PdfReader; print(len(PdfReader(sys.argv[1]).pages))`, pdf]);
  return r.code === 0 ? Number(r.stdout.trim()) : null;
}

function doImpose(env, root, { degradeOk }) {
  const slug = readSlug(root);
  const guide = path.join(root, 'guide');
  const pdf = path.join(guide, `${slug}.pdf`);
  const out = contained(guide, path.join(guide, `${slug}-print-ready.pdf`));
  if (!existsSync(pdf)) { env.err(`${TOOL}: ${pdf} not found — run: ${TOOL} build ${quote(root)}`); return 1; }
  const probe = existsSync(env.python) ? env.run(env.python, ['-c', 'import pypdf']) : { code: 1 };
  if (probe.code !== 0) {
    env.err(`${TOOL}: degraded — imposition skipped, pypdf is not importable by ${env.python}. Fix: cd ${HERE} && poetry install   (or export SPIRAL_BOOK_PYTHON to an interpreter that has it)`);
    return degradeOk ? 0 : 1;
  }
  const r = env.run(env.python, [path.join(TEMPLATES, 'impose.py'), pdf, out]);
  if (r.code !== 0) { env.err((r.stdout + r.stderr).trim()); env.err(`${TOOL}: imposition failed (exit ${r.code})`); return 1; }
  audit(env, 'impose', root, `out=${path.basename(out)}`);
  env.out(r.stdout.trim());
  env.out(`print-ready: ${out} — duplex, short-edge flip; cut the stack in half, left pile on top of right`);
  return 0;
}

function cmdImpose(env, dir, flags) {
  const root = resolveProject(dir);
  if (!root) return usage(env, 'impose needs a project directory');
  const slug = readSlug(root);
  if (!slug) { env.err(`${TOOL}: ${root} is not a spiral-book project`); return 1; }
  if (flags.explain) { env.out(`would impose guide/${slug}.pdf → guide/${slug}-print-ready.pdf inside ${root} (tier: read; half-letter pages only; needs pypdf from ${env.python})`); return 0; }
  return doImpose(env, root, { degradeOk: false });
}

function cmdClean(env, dir, flags) {
  const root = resolveProject(dir);
  if (!root) return usage(env, 'clean needs a project directory');
  if (!readStems(root)) { env.err(`${TOOL}: ${root} is not a spiral-book project; nothing to clean`); return 1; }
  const victims = derivedFiles(root);
  const plan = () => { for (const p of victims) env.out(`  - ${path.relative(root, p)}`); };
  if (flags.explain) {
    env.out(`would delete ${victims.length} generated file(s) under ${root} (tier: write-gated, gate: flag — --yes required; chapter .md and template files are never touched):`);
    plan();
    return 0;
  }
  if (!victims.length) { env.out(`${root}: no generated files to clean`); return 0; }
  if (!flags.yes) {
    env.err(`clean ${root} — ${victims.length} generated file(s) would be deleted (every one is rebuilt by \`${TOOL} build\`; no chapter or template is touched):`);
    for (const p of victims) env.err(`  - ${path.relative(root, p)}`);
    env.err(`Preview only — nothing deleted. To delete exactly these, re-run: ${TOOL} clean ${quote(root)} --yes`);
    return env.stdinIsTTY ? 0 : 2;
  }
  for (const p of victims) unlinkSync(contained(root, p));
  audit(env, 'clean', root, `files=-${victims.length}`);
  env.out(`deleted ${victims.length} generated file(s) under ${root} — rebuild with: ${TOOL} build ${quote(root)}`);
  return 0;
}

export function quote(s) {
  return /^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- cli

const HELP = `${TOOL} ${VERSION} — spiral-bound books: Markdown → pandoc → Typst → PDF → imposed print PDF

reads (free)
  ${TOOL} check [--json]                        pandoc / typst / pypdf / fswatch: present, versions, fix lines
  ${TOOL} plan <project> [--json]               chapters, which are written, which outputs exist
  ${TOOL} build <project> [--no-impose]         pandoc each chapter, typst compile, impose if pypdf is here
  ${TOOL} impose <project>                      the 2-up print-ready PDF only (half-letter pages)

writes into the ONE directory you name (containment)
  ${TOOL} scaffold <project> --title T [--author A] --chapter NN-stem[:TAB[:Section]] ...
        [--size half-letter|letter|a5] [--binding spiral|perfect]
        [--font-body F] [--font-heading F] [--font-mono F] [--force]
      creates <project>/guide/{template/theme.typ,template/layout.typ,main.typ,build.sh,impose.py,NN-*.md} and .gitignore
      refuses when any of those exist; --force replaces template/build files and still never overwrites a chapter .md

write-gated by --yes
  ${TOOL} clean <project> [--yes]               delete generated .md.typ and PDFs; preview without --yes

flags   --explain   print what a verb would do and touch nothing (scaffold, build, impose, clean)
env     SPIRAL_BOOK_PYTHON   interpreter that imports pypdf (default: this dir's .venv/bin/python)
ceiling MAX_CHAPTERS=${MAX_CHAPTERS} (code constant); sections ≤ ${PALETTE.length}; tab labels ≤ 8 chars`;

function usage(env, msg) {
  env.err(`${TOOL}: ${msg}\n\n${HELP}`);
  return 2;
}

const REPEATABLE = new Set(['chapter']);
const VALUED = new Set(['title', 'author', 'chapter', 'size', 'binding', 'font-body', 'font-heading', 'font-mono']);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (VALUED.has(k)) {
      if (v === undefined) v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      if (REPEATABLE.has(k)) (flags[k] ??= []).push(v); else flags[k] = v;
    } else if (v !== undefined) throw new Error(`--${k} takes no value`);
    else flags[k] = true;
  }
  return { flags, positional };
}

export function main(argv, overrides = {}) {
  const env = makeEnv(overrides);
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { return usage(env, e.message); }
  const { flags, positional } = parsed;
  const [verb, target] = positional;
  if (!verb || flags.help || verb === 'help') { env.out(HELP); return verb ? 0 : 2; }
  if (flags.version) { env.out(`${TOOL} ${VERSION}`); return 0; }
  switch (verb) {
    case 'check': return cmdCheck(env, flags);
    case 'plan': return cmdPlan(env, target, flags);
    case 'scaffold': return cmdScaffold(env, target, flags);
    case 'build': return cmdBuild(env, target, flags);
    case 'impose': return cmdImpose(env, target, flags);
    case 'clean': return cmdClean(env, target, flags);
    default: return usage(env, `unknown verb "${verb}"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
