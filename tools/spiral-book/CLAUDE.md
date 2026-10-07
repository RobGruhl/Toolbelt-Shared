# spiral-book — the agent contract

## Read first

- **What:** spiral-bound books from Markdown. `scaffold` lays down a project (Typst theme and
  layout with color-coded sections and thumb index tabs, a `build.sh`, `impose.py`, one `.md`
  per chapter); `build` runs pandoc → typst → pypdf imposition; `clean` removes what `build`
  made. The skill in `skill/SKILL.md` is the conversational front door and routes through this
  CLI. One file, zero Node dependencies; pandoc and typst come from brew, pypdf from this
  directory's poetry env.
- **Auth:** none. Nothing here reaches the network or a credential.
- **First read:** `node spiral-book.mjs check` — pandoc, typst, pypdf, fswatch: present, version,
  fix line. Exit 1 means a required binary is missing; the fix is always `brew install …` or
  `poetry install --no-root` here.
- **Writes:** every one lands inside the single project directory you name on the command line
  and nowhere else. `scaffold` is containment-gated: it refuses when any of its files exist.
  `clean` deletes only with `--yes`. `build`/`impose` write derived files only.
- **Live here?** `bin/toolbelt doctor spiral-book`. `setup spiral-book` creates the venv and links
  the skill into `~/.claude/skills/spiral-book`.

```bash
node spiral-book.mjs check                                   # deps, versions, fix lines
node spiral-book.mjs scaffold ~/Books/field-guide \
  --title "Field Guide" --author "R. Gruhl" \
  --chapter 01-intro:INTRO:Basics --chapter 02-gear:GEAR:Basics \
  --chapter 03-knots:KNOTS:Skills [--size half-letter|letter|a5] [--binding spiral|perfect] --explain
node spiral-book.mjs scaffold ~/Books/field-guide … # same line without --explain: writes
node spiral-book.mjs plan ~/Books/field-guide        # chapters: written / placeholder / missing; outputs
node spiral-book.mjs build ~/Books/field-guide       # pandoc → typst → impose (degrades without pypdf)
node spiral-book.mjs impose ~/Books/field-guide      # the 2-up print PDF only
node spiral-book.mjs clean ~/Books/field-guide       # preview; --yes deletes the generated files
```

Exit codes: `0` done or previewed · `1` a dependency or the pipeline failed · `2` usage, a
scaffold target that already exists, or `clean` without `--yes` and without a terminal.

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| `check`, `plan`, any verb `--explain` | read | run freely |
| `build`, `impose` | read (derived files only) | run when the user asked for the book; report the `built …` line and page count |
| `scaffold <dir> …` | write-gated, containment | run when the user named the directory and approved the chapter list; show `--explain` first when the list was yours |
| `scaffold --force` | — | only when the user asked to regenerate the templates; chapters survive it regardless |
| `clean <dir>` | write-gated, flag | run without `--yes`: it previews and exits 2. Hand the user the `--yes` line it prints; pass `--yes` yourself only when the user said "clean it" for that directory |

A chapter `.md` is the user's writing. No verb in this tool overwrites one — `scaffold --force`
skips them, `clean` never lists them, `build` only reads them. Edit chapters with your file
tools in the open, never by regenerating the project.

## The project it makes

```
<dir>/
├── .gitignore                 ignores guide/*.md.typ, guide/*.pdf, .venv/
└── guide/
    ├── template/theme.typ     colors, fonts, the section registry (stem → tab, color, order)
    ├── template/layout.typ    page geometry, header/footer, thumb index; title/author/size filled in
    ├── main.typ               cover block (commented out), contents page, one include per chapter
    ├── build.sh               standalone pipeline; `./build.sh [clean|watch|impose]`
    ├── impose.py              cut-and-stack 2-up imposition, half-letter on letter, duplex short-edge
    └── NN-slug.md             one per --chapter, with the `<!-- tab: … -->` marker on line 1
```

`--chapter NN-stem[:TAB[:Section]]`: the stem is the filename (`NN-slug`, lowercase, no other
characters — it is what keeps every path inside the project); `TAB` is the thumb-tab label (8
characters, A-Z 0-9 space; defaults to the first word of the slug upper-cased); `Section` groups
chapters under one color, assigned from the palette in first-seen order (gray, blue, green,
orange, purple, red). The tab comment on line 1 of a chapter is documentation for humans;
`build` strips it, and the registry in `theme.typ` is what the layout reads.

`build` and `clean` read the chapter list back from the project's own `guide/build.sh`
(`SECTIONS=( … )`) and the output name from `OUTPUT=`, so adding a chapter later is: create
`guide/NN-slug.md`, add the stem to `SECTIONS` in `build.sh`, add a `#section-start`/`#include`
pair in `main.typ`, add a registry entry in `theme.typ`, bump `total-tabs`. `plan` shows whether
every stem has its file.

## Ceilings, degraded modes, quirks

| What | Value | Where |
|---|---|---|
| `MAX_CHAPTERS` | 40, refused not lowered | code constant in `spiral-book.mjs`; tabs read best at 8–25 |
| sections | ≤ 6 (the palette) | `PALETTE` |
| tab label | ≤ 8 chars | `parseChapter` |
| `STEP_TIMEOUT_MS` | 120 s per pandoc/typst call, no retry | `run()` |

- **No pypdf → degraded, not failed.** `build` compiles the book PDF, prints
  `degraded — imposition skipped` with the `poetry install --no-root` fix, exits 0. `impose` on
  its own exits 1 in the same state. `SPIRAL_BOOK_PYTHON` points both at another interpreter.
- **Imposition is half-letter only.** `impose.py` refuses other page sizes (exit 2) rather than
  mis-tiling; `--size letter` and `a5` books get a book PDF and no print-ready file.
- **A missing chapter file is not an error:** `build` writes a placeholder `.md.typ` and counts
  it; `plan` shows it as `missing`. A chapter still holding the scaffold text shows as
  `placeholder`.
- **Cover art is optional and external.** `main.typ` ships with the cover page commented out.
  When the user has an image (any generator, a designer, a photo), they drop it at
  `guide/cover.png` (2:3 portrait, no text — the title is typeset) and uncomment the block.
  The skill drafts a prompt into `guide/cover-prompt.txt`; nothing in this tool generates
  images.
- **Fonts are system fonts** (Georgia, Helvetica Neue, Menlo by default; `--font-body` etc.
  override). A font typst cannot find falls back silently — check with `typst fonts | grep`.
- **Pandoc is invoked with `--wrap=none`** and the `.md.typ` gets `#import
  "template/layout.typ": horizontalrule` on line 1 so `---` rules render; write standard
  Markdown (H1 = chapter title, tables, lists, code) and cross-reference chapters by name, not
  link.
- **Audit line** on stderr for every scaffold/build/impose/clean:
  `[spiral-book audit] <iso> verb=<v> target=<dir> …` with the file delta or page count.

## The skill

`skill/SKILL.md` is what `~/.claude/skills/spiral-book` links to (the `symlink` install step).
It gathers the book's title, sections and chapters, calls `scaffold`, helps write the chapters,
drafts a cover prompt, runs `build`, then reviews. It carries no pipeline code of its own: the
templates live in `templates/` and the verbs here, so the skill and the tool cannot drift.
