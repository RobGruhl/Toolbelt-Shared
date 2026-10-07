---
name: spiral-book
description: Create professional spiral-bound books with color-coded sections, thumb index tabs, and print-ready PDF output. Scaffolds a complete book project from Markdown chapters through Typst typesetting to imposed print-ready PDFs. Use when the user wants to create a book, guide, manual, reference, handbook, or any multi-chapter document with professional layout.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, Agent
---

# Spiral Book Builder

Create professional spiral-bound books from Markdown source. The pipeline: **Markdown chapters
-> Pandoc -> Typst -> PDF -> print-ready imposed PDF**.

This skill is the conversational front door for the belt tool at `tools/spiral-book/` (the
directory this skill is symlinked from, one level up: `$SKILL_DIR/..`). The templates and every
verb live there; this file carries no pipeline code of its own. Read `../CLAUDE.md` once per
session — it is the contract: what each verb writes, the gates, the ceilings.

```bash
TOOL="$(dirname "$(readlink -f ~/.claude/skills/spiral-book)")"   # …/Toolbelt/tools/spiral-book
node "$TOOL/spiral-book.mjs" --help
```

## When to Use This Skill

Use when the user wants to:
- Create a new book, guide, manual, handbook, or reference document
- Set up a book project with professional typesetting
- Add chapters or sections to an existing book project
- Build/compile book output (PDF, print-ready)
- Draft a cover image prompt for their book
- Review and QA a book's content

## System Requirements

`node "$TOOL/spiral-book.mjs" check` reports each one with its fix line:
- `pandoc` — Markdown to Typst (`brew install pandoc`)
- `typst` — Typst to PDF (`brew install typst`)
- `pypdf` — print imposition, from the tool's poetry env (`cd "$TOOL" && poetry install --no-root`
  or `toolbelt setup spiral-book`); without it `build` still makes the book PDF and names the
  degraded mode
- `fswatch` — optional, for the scaffolded `build.sh watch` (`brew install fswatch`)

Never `pip install` anything; the fix lines above are the whole install story.

## Phase 1: Gather Book Information

Ask the user (use AskUserQuestion) for:

1. **Book title** — headers, document metadata, output filename (slugified)
2. **Author/group name** — document metadata
3. **Topic and purpose** — what the book is about, who it's for
4. **Sections** — the major thematic groupings (2-6 recommended). Each section gets a color
   from the palette in the order it first appears: gray, blue, green, orange, purple, red.
   Example: a cooking book might have "Basics", "Appetizers", "Mains", "Desserts"
5. **Chapters** — the list within each section. Each chapter is one Markdown file,
   `NN-slug.md`, with a thumb-tab label of at most 8 characters
6. **Page size** — default half-letter (5.5" x 8.5", the spiral-bound default). Also letter or
   A5; only half-letter gets the imposed print-ready PDF
7. **Binding style** — spiral (default, 0.85" gutter) or perfect (0.6" gutter)
8. **Project directory** — the one place every file will go. Every write in this tool is
   contained to that directory; name it explicitly

If the user just has a topic and wants help planning chapters, brainstorm a table of contents
before scaffolding. Thumb tabs read best with 8-25 chapters; the tool refuses more than 40.

## Phase 2: Scaffold the Project

One command creates the whole tree. Show the plan first, then run it:

```bash
node "$TOOL/spiral-book.mjs" scaffold <project-dir> \
  --title "<Book Title>" --author "<Author>" \
  --chapter 01-intro:INTRO:Basics \
  --chapter 02-setup:SETUP:Basics \
  --chapter 03-recipes:RECIPES:Cooking \
  [--size half-letter|letter|a5] [--binding spiral|perfect] \
  [--font-body Georgia] [--font-heading "Helvetica Neue"] [--font-mono Menlo] \
  --explain            # the file list, nothing written — drop the flag to create it
```

`--chapter NN-stem[:TAB[:Section]]`: stem = filename (lowercase `NN-slug`), TAB = thumb label
(A-Z 0-9, 8 chars; defaults to the slug's first word), Section = the color group. Chapters in
the same section should be adjacent in the list.

The result:

```
<project-dir>/
├── .gitignore
└── guide/
    ├── build.sh              # standalone build: ./build.sh [clean|watch|impose]
    ├── impose.py             # print imposition (half-letter on letter, duplex short-edge)
    ├── main.typ              # cover (commented out), contents, one include per chapter
    ├── template/
    │   ├── layout.typ        # page geometry, headers/footers, thumb index
    │   └── theme.typ         # colors, fonts, section registry
    ├── 01-intro.md           # chapter files, each with a <!-- tab: … --> marker on line 1
    ├── 02-setup.md
    └── ...
```

`scaffold` refuses when any of those files already exist (exit 2, naming them). `--force`
regenerates the template and build files and **never** touches a chapter `.md` — use it when
the user wants the theme or layout reset, not to add chapters.

**Adding a chapter to an existing project** is four edits, not a re-scaffold: create
`guide/NN-slug.md` (copy the tab-marker line from a sibling), add the stem to `SECTIONS=( … )`
in `guide/build.sh`, add a `#section-start("NN-slug")` + `#include "NN-slug.md.typ"` pair in
`guide/main.typ`, add the registry entry in `guide/template/theme.typ` and bump `total-tabs`.
`node "$TOOL/spiral-book.mjs" plan <project-dir>` confirms every stem has its file.

**Theme and layout edits** (colors, fonts, sizes, margins) are plain edits to
`guide/template/theme.typ` and `guide/template/layout.typ`; nothing regenerates them unless
`--force` is passed. Tab labels render rotated 90° in a thin tab, so keep them short. Fonts:
stick to system fonts unless the user has others installed — check with
`typst fonts | grep "<name>"`.

## Phase 3: Write Chapter Content

When the user asks to write or draft chapter content:

1. **Understand the source material** — ask what references, notes, or knowledge should inform the chapter
2. **Draft in Markdown** — clean, well-structured: H1 = chapter title, H2 = major sections, H3 = subsections, H4 = sub-subsections
3. **Follow the book's voice** — consistent tone across chapters
4. **Use standard Markdown** — the pipeline handles paragraphs, headings (H1-H4), bold, italic, inline and block code, bullet and numbered lists, tables, horizontal rules (`---`)
5. **Cross-reference other chapters by name** (not by link) — "see the chapter on Character Creation"

Keep the `<!-- tab: … -->` comment on line 1; the build strips it, and the section mapping the
layout reads lives in `theme.typ`.

## Phase 4: Draft a Cover Prompt (optional)

Cover art is optional and comes from outside this pipeline — any image generator, a designer,
a photo. When the user wants a cover, help them craft a detailed image prompt:

1. **Ask about the visual concept** — what should the cover depict?
2. **Write a multi-layer composition** — foreground, midground, background
3. **Specify style** — painterly, photorealistic, minimalist, etc.
4. **Include aspect ratio** — 2:3 for portrait book covers
5. **End with "No text or titles in the image"** — the title is typeset by Typst
6. **Save to `guide/cover-prompt.txt`**

When the user has an image, they save it as `guide/cover.png` and uncomment the cover block at
the top of `guide/main.typ`. Until then the book builds without a cover.

## Phase 5: Build the Book

```bash
node "$TOOL/spiral-book.mjs" build <project-dir>        # pandoc → typst → impose
node "$TOOL/spiral-book.mjs" impose <project-dir>       # the 2-up print PDF only
node "$TOOL/spiral-book.mjs" plan <project-dir>         # what is written, what exists
```

Outputs land in `guide/`: `<slug>.pdf` (the book) and `<slug>-print-ready.pdf` (2-up on
landscape letter for duplex printing with short-edge flip; cut the stack in half and put the
left pile on top of the right). A missing `pypdf` skips the second file and says so; the fix
is in the message. The scaffolded `guide/build.sh` is the same pipeline as a standalone
script — `./build.sh watch` (needs fswatch) gives a live-rebuilding preview while writing.

`node "$TOOL/spiral-book.mjs" clean <project-dir>` previews the generated files it would remove;
it deletes only with `--yes`, which is the user's to say. It never lists a chapter or template.

## Phase 6: Review and QA

After the book is built, help the user review:

1. **Terminology consistency** — search for stale or inconsistent terms across chapters
2. **Cross-reference accuracy** — chapter names match when referenced
3. **Rules/facts accuracy** — cross-check technical values against the sources
4. **Quick reference completeness** — a reference chapter covers all the material
5. **Document fixes** in a `REVIEW-FIXES.md` file with fix IDs (FIX-01, FIX-02, …)

## Tips

- **Start small**: scaffold with 3-5 chapters, add more as content develops
- **Thumb tabs work best** with 8-25 chapters; fewer makes tabs too tall, more too thin
- **Color palette**: 2-6 sections; more becomes visually noisy
- **Chapter naming**: `NN-slug.md` (01-intro.md, 02-basics.md) keeps sort order and is the only
  form the tool accepts — it is what keeps every file inside the project
- **Every verb takes `--explain`** and prints its plan without writing; use it before any
  scaffold you composed yourself
