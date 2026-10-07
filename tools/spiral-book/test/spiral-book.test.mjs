// spiral-book tests — tiers vs. manifest, containment, the book model, rendered templates,
// scaffold idempotence, the clean gate. A temp dir per test; pandoc/typst are stubbed except
// in the one end-to-end test, which runs only where both binaries exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, VERBS, tierOf, planBook, parseChapter, isInside, renderTheme, renderMain, renderLayout, renderBuildSh, scaffoldFiles, readStems, readSlug, parseArgs, MAX_CHAPTERS, PALETTE, slugify } from '../spiral-book.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(path.join(HERE, '..', 'toolbelt.json'), 'utf8'));

/** A harness: temp dir, captured output, stubbed binaries (none found) unless `real`. */
function rig({ which, run, stdinIsTTY = false, python = '/nonexistent/python', real = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'spiral-'));
  const out = [];
  const err = [];
  const stubs = real ? {} : { which: which ?? (() => null), run: run ?? (() => ({ code: 1, stdout: '', stderr: 'stubbed' })) };
  const go = (argv) => main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), ...stubs, stdinIsTTY, python, now: () => Date.UTC(2026, 7, 22) });
  return { dir, out, err, go, all: () => [...out, ...err].join('\n'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CHAPTERS = ['01-intro:INTRO:Basics', '02-setup:SETUP:Basics', '03-recipes:RECIPES:Cooking'];
const scaffoldArgs = (dir, extra = []) => ['scaffold', dir, '--title', 'Demo Guide', '--author', 'A. Writer', ...CHAPTERS.flatMap((c) => ['--chapter', c]), ...extra];

test('tiers: the manifest verbs[] mirrors the VERBS table in the code', () => {
  const declared = Object.fromEntries(MANIFEST.verbs.filter((v) => VERBS[v.name]).map((v) => [v.name, v]));
  for (const [name, spec] of Object.entries(VERBS)) {
    assert.ok(declared[name], `manifest lacks verb ${name}`);
    assert.equal(declared[name].tier, spec.tier, `${name} tier`);
    assert.equal(declared[name].gate, spec.gate, `${name} gate`);
  }
  assert.equal(tierOf('scaffold').gate, 'containment');
  assert.equal(tierOf('clean').gate, 'flag');
  assert.equal(tierOf('nope'), null);
});

test('ceilings are code constants', () => {
  assert.equal(MAX_CHAPTERS, 40);
  assert.equal(PALETTE.length, 6);
  assert.equal(PALETTE[0][0], 'gray');
});

test('containment: stems cannot escape the project and paths are checked against the root', () => {
  for (const bad of ['../x', '01-../x', '01-Intro', 'intro', '01-in tro', '01-a/b']) assert.throws(() => parseChapter(bad), new RegExp('stem'), bad);
  assert.throws(() => parseChapter('01-intro:TOOLONGLABEL'), /8 is the most/);
  assert.deepEqual(parseChapter('02-getting-started'), { stem: '02-getting-started', tab: 'GETTING', section: 'Main' });
  assert.ok(isInside('/a/b', '/a/b/guide/x.md'));
  assert.ok(isInside('/a/b', '/a/b'));
  assert.ok(!isInside('/a/b', '/a/bc'));
  assert.ok(!isInside('/a/b', '/a/b/../c'));
});

test('planBook: sections get palette colors in first-seen order, ceilings refuse not lower', () => {
  const book = planBook({ title: 'Demo Guide', chapters: CHAPTERS });
  assert.equal(book.slug, 'demo-guide');
  assert.deepEqual(book.sections.map((s) => [s.name, s.color]), [['Basics', 'gray'], ['Cooking', 'blue']]);
  assert.equal(book.chapters[2].order, 3);
  assert.equal(book.chapters[2].color, 'blue');
  assert.throws(() => planBook({ title: 'x', chapters: [] }), /at least one/);
  assert.throws(() => planBook({ title: '', chapters: CHAPTERS }), /--title/);
  assert.throws(() => planBook({ title: 'x', chapters: ['01-a', '01-a'] }), /twice/);
  assert.throws(() => planBook({ title: 'x', chapters: CHAPTERS, size: 'tabloid' }), /--size/);
  const many = Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => `${String(i + 1).padStart(2, '0')}-c${i}`);
  assert.throws(() => planBook({ title: 'x', chapters: many }), /MAX_CHAPTERS=40/);
  assert.equal(slugify('  Hello, World!! '), 'hello-world');
});

test('rendering: no placeholder survives, the registry and includes match the chapters', () => {
  const book = planBook({ title: 'Demo "Quoted"', author: 'Me', chapters: CHAPTERS, size: 'a5', binding: 'perfect' });
  const theme = renderTheme(book);
  const layout = renderLayout(book);
  const mainTyp = renderMain(book);
  const sh = renderBuildSh(book);
  for (const t of [theme, layout, mainTyp, sh]) assert.doesNotMatch(t, /\{\{[A-Z_]+\}\}/);
  assert.match(theme, /#let color-gray/);
  assert.match(theme, /"03-recipes": \(tab: "RECIPES", color: color-blue, order: 3\)/);
  assert.match(theme, /#let total-tabs = 3/);
  assert.match(layout, /page-width   = 148mm/);
  assert.match(layout, /gutter       = 0.6in/);
  assert.match(layout, /title: "Demo \\"Quoted\\""/);
  assert.match(mainTyp, /#section-start\("01-intro"\)\n#include "01-intro.md.typ"/);
  assert.match(mainTyp, /\/\/ #page\(header: none/); // cover block shipped commented out
  assert.match(sh, /OUTPUT="demo-quoted.pdf"/);
  assert.match(sh, /SECTIONS=\(\n  01-intro\n  02-setup\n  03-recipes\n\)/);
  assert.doesNotMatch(sh, /pip install/);
  assert.equal(scaffoldFiles(book).size, 9);
});

test('scaffold: --explain writes nothing; a real run writes only under the root; re-run refuses; --force keeps chapters', () => {
  const r = rig();
  try {
    const root = path.join(r.dir, 'book');
    assert.equal(r.go(scaffoldArgs(root, ['--explain'])), 0);
    assert.ok(!existsSync(root));
    assert.match(r.all(), /gate: containment/);
    assert.equal(r.go(scaffoldArgs(root)), 0);
    assert.match(r.err.join('\n'), /\[spiral-book audit\] 2026-08-22T00:00:00.000Z verb=scaffold target=.* files=\+9/);
    assert.ok(existsSync(path.join(root, 'guide', 'template', 'layout.typ')));
    assert.ok(statSync(path.join(root, 'guide', 'build.sh')).mode & 0o100);
    assert.deepEqual(readStems(root), ['01-intro', '02-setup', '03-recipes']);
    assert.equal(readSlug(root), 'demo-guide');
    writeFileSync(path.join(root, 'guide', '01-intro.md'), '# Real content\n');
    assert.equal(r.go(scaffoldArgs(root)), 2);
    assert.match(r.err.join('\n'), /already holds 9/);
    assert.equal(readFileSync(path.join(root, 'guide', '01-intro.md'), 'utf8'), '# Real content\n');
    assert.equal(r.go(scaffoldArgs(root, ['--force'])), 0);
    assert.equal(readFileSync(path.join(root, 'guide', '01-intro.md'), 'utf8'), '# Real content\n');
    assert.match(r.out.join('\n'), /created 0, replaced 6, kept 3/);
  } finally { r.cleanup(); }
});

test('usage: missing title, bad flag, unknown verb all exit 2 with help', () => {
  const r = rig();
  try {
    assert.equal(r.go(['scaffold', path.join(r.dir, 'b'), '--chapter', '01-a']), 2);
    assert.equal(r.go(['scaffold', path.join(r.dir, 'b'), '--title=X', '--chapter', '01-a', '--bogus=1']), 2);
    assert.equal(r.go(['frobnicate']), 2);
    assert.equal(r.go([]), 2);
    assert.equal(r.go(['help']), 0);
    assert.ok(!existsSync(path.join(r.dir, 'b')));
    const p = parseArgs(['scaffold', 'd', '--chapter', 'a', '--chapter=b', '--force', '--title', 'T']);
    assert.deepEqual(p.flags, { chapter: ['a', 'b'], force: true, title: 'T' });
  } finally { r.cleanup(); }
});

test('build: a missing binary is exit 1 with the brew fix, nothing converted', () => {
  const r = rig();
  try {
    const root = path.join(r.dir, 'book');
    r.go(scaffoldArgs(root));
    assert.equal(r.go(['build', root, '--explain']), 0);
    assert.equal(r.go(['build', root]), 1);
    assert.match(r.err.join('\n'), /pandoc not found — fix: brew install pandoc/);
    assert.ok(!existsSync(path.join(root, 'guide', '01-intro.md.typ')));
    assert.equal(r.go(['build', r.dir]), 1); // not a project
  } finally { r.cleanup(); }
});

test('clean: previews without --yes (exit 2 headless, 0 at a terminal), deletes with --yes, never a chapter', () => {
  const r = rig();
  try {
    const root = path.join(r.dir, 'book');
    r.go(scaffoldArgs(root));
    writeFileSync(path.join(root, 'guide', '01-intro.md.typ'), '// x');
    writeFileSync(path.join(root, 'guide', 'demo-guide.pdf'), 'pdf');
    assert.equal(r.go(['clean', root, '--explain']), 0);
    assert.equal(r.go(['clean', root]), 2);
    assert.match(r.err.join('\n'), /Preview only — nothing deleted/);
    assert.ok(existsSync(path.join(root, 'guide', 'demo-guide.pdf')));
    const t = rig({ stdinIsTTY: true });
    try {
      const root2 = path.join(t.dir, 'b');
      t.go(scaffoldArgs(root2));
      writeFileSync(path.join(root2, 'guide', 'demo-guide.pdf'), 'pdf');
      assert.equal(t.go(['clean', root2]), 0);
    } finally { t.cleanup(); }
    assert.equal(r.go(['clean', root, '--yes']), 0);
    assert.match(r.err.join('\n'), /verb=clean target=.* files=-2/);
    assert.ok(!existsSync(path.join(root, 'guide', 'demo-guide.pdf')));
    assert.ok(existsSync(path.join(root, 'guide', '01-intro.md')));
    assert.ok(existsSync(path.join(root, 'guide', 'template', 'theme.typ')));
    assert.equal(r.go(['clean', root, '--yes']), 0);
    assert.match(r.out.join('\n'), /no generated files to clean/);
  } finally { r.cleanup(); }
});

test('check: reports each dependency with a fix line and exits 1 when a required one is missing', () => {
  const r = rig({ which: (b) => (b === 'pandoc' ? '/usr/local/bin/pandoc' : null), run: () => ({ code: 0, stdout: 'pandoc 3.9\n', stderr: '' }) });
  try {
    assert.equal(r.go(['check', '--json']), 1);
    const j = JSON.parse(r.out[0]);
    assert.equal(j.ok, false);
    assert.deepEqual(j.deps.map((d) => [d.dep, d.status]), [['pandoc', 'ok'], ['typst', 'missing'], ['pypdf', 'degraded'], ['fswatch', 'optional']]);
    assert.match(j.deps[1].detail, /brew install typst/);
    assert.match(j.deps[2].detail, /poetry install/);
  } finally { r.cleanup(); }
});

const havePandoc = spawnSync('/bin/sh', ['-c', 'command -v pandoc && command -v typst']).status === 0;
test('end-to-end: scaffold, build, impose (degraded without pypdf), plan — real pandoc and typst', { skip: !havePandoc && 'pandoc/typst not installed' }, () => {
  const venv = path.join(HERE, '..', '.venv', 'bin', 'python');
  const r = rig({ real: true, python: existsSync(venv) ? venv : '/nonexistent/python' });
  try {
    const root = path.join(r.dir, 'book');
    assert.equal(r.go(scaffoldArgs(root)), 0);
    writeFileSync(path.join(root, 'guide', '01-intro.md'), '<!-- tab: INTRO | color: gray | mode: Basics -->\n\n# Intro\n\nHello **world**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    assert.equal(r.go(['build', root]), 0, r.all());
    assert.ok(existsSync(path.join(root, 'guide', 'demo-guide.pdf')));
    assert.doesNotMatch(readFileSync(path.join(root, 'guide', '01-intro.md.typ'), 'utf8'), /<!-- tab:/);
    assert.match(r.err.join('\n'), /verb=build target=.* chapters=3 converted=3/);
    if (existsSync(venv)) assert.ok(existsSync(path.join(root, 'guide', 'demo-guide-print-ready.pdf')), 'imposed');
    else assert.match(r.err.join('\n'), /degraded — imposition skipped/);
    assert.equal(r.go(['plan', root, '--json']), 0);
    const plan = JSON.parse(r.out.at(-1));
    assert.equal(plan.chapters[0].md, 'written');
    assert.equal(plan.chapters[1].md, 'placeholder');
    assert.ok(plan.outputs.pdf);
  } finally { r.cleanup(); }
});
