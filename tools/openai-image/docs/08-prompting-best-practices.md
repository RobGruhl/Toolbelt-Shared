# 08 — Prompting Best Practices

Distilled from OpenAI's official prompting guide for the gpt-image family, plus field guides from fal.ai and i-scoop. This is the "how to write the prompt" companion to `04-editing-and-masks.md` (mechanics) and `06-consistency-workflow.md` (multi-frame identity).

## Prompt structure

Order matters. The reliable ordering is:

```
background/scene → subject → key details → constraints → intended use
```

For anything non-trivial, use labeled short segments instead of a dense paragraph. The fal.ai five-slot template is a good reusable skeleton:

```
Scene:
[where this happens, time of day, background, environment]

Subject:
[who or what is the main focus]

Important details:
[materials, clothing, texture, lighting, camera angle, lens feel, composition, mood]

Use case:
[editorial photo / product mockup / poster / UI screen / infographic / concept frame]

Constraints:
[no watermark / no logos / no extra text / preserve face / preserve layout]
```

Any format works if the intent is clear — minimal one-liners, paragraphs, JSON, tags. For production pipelines, **prefer skimmable templates over clever syntax**: they're easier to parameterize and diff.

Always state the intended use ("Instagram ad", "UI mock", "children's book page") — it sets polish level and rendering conventions.

## Specificity — visual facts over vague praise

- Replace "stunning", "masterpiece", "high quality" with concrete observations: "overcast daylight", "brushed aluminum", "50mm feel", "soft bounce light".
- Style tags need targets. Not "minimalist brutalist editorial luxury" — instead: "cream background, heavy black sans serif, asymmetrical type block, generous negative space, studio lighting".
- Name the medium directly: "photorealistic", "real photograph", "watercolor", "3D render", "iPhone photo". These engage distinct rendering modes; for photoreal work the word "photorealistic" (or equivalent) should appear explicitly.
- Camera specs ("85mm, f/1.8") are interpreted as *aesthetic suggestions*, not physics simulation. Use them for high-level look only.

## Composition, people, and pose

Call out placement and framing explicitly — the model won't infer it:

- Framing/viewpoint: "close-up", "wide shot", "top-down", "low-angle", "eye-level"
- Placement: "logo top-right", "subject centered with negative space on left"
- Lighting/mood: "soft diffuse", "golden hour", "high-contrast"

For people, describe scale, body framing, gaze, and object interaction:

- "full body visible, feet included"
- "child-sized relative to the table"
- "looking down at the open book, not at camera"
- "hands naturally gripping the handlebars"

## Text in images

- Put literal text in **quotes** or ALL CAPS; mark it "EXACT TEXT" or "verbatim" when it must not vary.
- Specify typography: font style, size, color, placement.
- Spell brand names and unusual words **letter-by-letter** ("spelled Q-U-V-E-X").
- Add guards: "no extra words", "no duplicate text", "100% readable".
- Small/dense text absolutely requires `quality: 'high'` — lower tiers mangle fine typography. (Moot under this repo's house rule of always-high, but worth knowing why.)
- Long-form or comic lettering still isn't reliable; do it in layout software (see `06-consistency-workflow.md`).

## Edits: separate change from preserve

The single highest-leverage editing pattern:

> **"Change only X. Keep everything else the same."**

Structure edit prompts in two columns:

```
Change:
[exactly what should change]

Preserve:
[face, identity, pose, lighting, framing, background, geometry, text, layout]

Constraints:
[no extra objects, no redesign, no logo drift, no watermark]
```

- **Repeat the preserve list on every iteration.** Drift compounds; restated invariants prevent it.
- **One revision per turn.** Small single-change follow-ups ("make lighting warmer", "remove the extra tree") beat big rewrites. Long accumulated prompts breed unpredictability — start clean and refine.
- Match the original's lighting, white balance, and grain in the prompt when compositing or replacing elements.

### Per-use-case editing patterns

| Task | Key phrasing |
|---|---|
| Object removal | "Remove X. Do not change anything else." |
| Virtual try-on | "Do not change face, body shape, pose, hair, expression." Only garments change; require realistic fit + consistent lighting/shadows. |
| Sketch → render | "Preserve exact layout, proportions, perspective. Do not add new elements or text." Add realism via materials/lighting. |
| Lighting/weather | Change only environmental conditions; "preserve identity, geometry, camera angle, object placement." |
| Product mockup | "Centered product, crisp silhouette, no halos/fringing. Preserve product geometry and label legibility exactly." Use an opaque background unless the deliverable needs alpha (`background: 'transparent'` is preview on gpt-image-2 and needs png/webp — see `03-sizes-quality-formats.md`). |
| Style transfer | Describe what stays (visual language, palette, texture) vs. what changes (subject/scene). Name concrete components — "chunky pixel forms, limited arcade palette, bright glow accents" — not "same style". |

## Multi-image inputs

When passing multiple references, name each by **index and role**, then describe the interaction:

```
Image 1: product photo of the mug.
Image 2: style reference — flat pastel illustration.
Apply Image 2's style to Image 1. Preserve the mug's shape and label text.
```

Compositing follows the same shape: "Put the bird from Image 1 on the elephant in Image 2, matched perspective and shadows." Keep reference roles distinct (identity vs. style) — see `06-consistency-workflow.md` for why blurring them degrades extraction.

## Character consistency (anchor pattern)

Covered in depth in `06-consistency-workflow.md`. The prompting essentials:

1. First generation establishes the anchor: locked appearance, outfit, proportions, palette ("green hooded tunic, soft brown boots, small belt pouch, kind expression").
2. Every subsequent prompt repeats the anchor: "same face, same green hooded tunic, same proportions, same color palette."
3. Always add the negative: **"same character, do not redesign."**
4. Use prior outputs as edit references; reference sheets compress identity + wardrobe + views into one input.

## Quality

**House rule for this repo: always `quality: 'high'`.** Every real generation and edit uses `high` — no low-quality drafts, no medium "good enough" passes. The only exception is the checked-in `examples/` smoke tests, which stay at `low` purely to keep a test run near $0.01.

Why it matters beyond fidelity: `high` is what makes small typography legible, dense infographics readable, portraits identity-stable, and edits preserve fine detail. Budget for it — complex prompts at `high` can take up to 2 minutes, so set generous HTTP timeouts.

## Resolutions and aspect ratios

`gpt-image-2` is **not** limited to the three preset sizes — it accepts **any custom `WxH`** that satisfies all four constraints:

1. Both edges are multiples of **16**
2. Max edge ≤ **3840px**
3. Long:short ratio ≤ **3:1**
4. Total pixels between **655,360** and **8,294,400** (8,294,400 = exactly 3840×2160)

### Recipe for a custom ratio

1. Pick the aspect ratio you actually need (don't settle for the nearest preset).
2. Choose a short edge, compute the long edge, and round **both** to the nearest multiple of 16.
3. Check the pixel count is within [655,360, 8,294,400] and the max edge ≤3840.
4. Prefer ≤2K total (`≤3,686,400` px ≈ 2560×1440) for reliability — larger outputs are officially best-effort/experimental. Go bigger only when the deliverable demands it (print, 4K).

### Ready-to-use sizes by ratio

| Ratio | Typical use | Reliable size | Max within limits |
|---|---|---|---|
| 1:1 | Square, avatars | `1024x1024`, `2048x2048` | `2880x2880` |
| 3:2 | Landscape photo | `1536x1024` | `3504x2336` |
| 2:3 | Portrait photo, book cover | `1024x1536` | `2336x3504` |
| 16:9 | Widescreen, slides | `2048x1152`, `2560x1440` | `3840x2160` (4K) |
| 9:16 | Stories/Reels, phone wallpaper | `1152x2048`, `1440x2560` | `2160x3840` |
| 4:5 | Instagram portrait | `1024x1280` | `2560x3200` |
| 21:9 (~2.33:1) | Cinematic, banners | `2688x1152` | `3840x1632` |
| 2:1 | Wide banner | `2048x1024` | `3840x1920` |
| 3:1 | Max-ratio strip/header | `3072x1024` | `3840x1280` |
| 1:√2 (A-series print) | A4/A3 posters | `1200x1696` | `2400x3392` |

Minimum legal size for reference: 655,360 px — e.g. `1024x640`.

- `size: 'auto'` lets the model pick and is the safe fallback, but for deliverables **specify the exact ratio the artifact needs** — composition adapts to the canvas, and outpainting/cropping after the fact loses quality.
- Mention the format in the prompt too ("vertical 9:16 poster", "cinematic 21:9 frame") — the model composes for the stated format, not just the pixel dimensions.
- 3:1 is a hard ratio ceiling. For more extreme banners, generate at 3:1 and crop/extend in post.

## Use-case briefs

For deliverable-shaped outputs, write the prompt as a spec, not a vibe:

- **Infographics** — name the deliverable, define the audience, list required components, state constraints.
- **Ads/marketing** — write a creative brief: brand positioning, audience, vibe, scene, exact tagline in quotes, "verbatim, legible typography".
- **UI mockups** — describe it as a shipped product: layout, hierarchy, real interface elements, exact copy with placement, component states. Avoid concept-art language.
- **Scientific/educational** — audience, lesson objective, required labels, scientific constraints; "clean flat system, consistent icons, readable labels".
- **Slides/charts** — artifact spec: canvas, hierarchy, real text/data, visual language, "readable typography, polished spacing, no clutter".

## Quick checklist

Before sending a prompt, verify:

- [ ] `quality: 'high'` set (house rule — always)
- [ ] Size specified as the exact ratio the deliverable needs (multiples of 16, ratio ≤3:1, ≤8,294,400 px) — and the format named in the prompt
- [ ] Scene → subject → details → constraints ordering (or labeled segments)
- [ ] Intended use stated
- [ ] Visual facts, not adjectives of praise
- [ ] Literal text quoted + typography specified
- [ ] Edits: change/preserve separated, preserve list repeated, one change per turn
- [ ] Multi-image: each reference indexed with a role
- [ ] Exclusions stated: "no watermark, no extra text, no logos"

## Further reading

- [OpenAI cookbook — image-gen models prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide) — the official best-practices writeup
- [fal.ai — prompting GPT Image 2](https://fal.ai/learn/tools/prompting-gpt-image-2) — five-slot template + photoreal/product/UI patterns
- [i-scoop — prompting gpt-image-2 like a pro](https://www.i-scoop.eu/prompting-gpt-image-2-like-a-pro-guide/) — condensed field guide of the above
