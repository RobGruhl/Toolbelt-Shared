# OpenAI image generation — doctrine

Current as of 2026-08-22. Every section names its source; when a figure here and the linked
page disagree, the page wins and this file gets rewritten.

## Models and defaults

- Flagship: `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`). Prior: `gpt-image-1.5`
  (`gpt-image-1.5-2025-12-16`), `gpt-image-1`, `gpt-image-1-mini`. DALL-E 2/3 remain on the
  endpoint as legacy. — https://developers.openai.com/api/docs/models/gpt-image-2 ·
  https://developers.openai.com/api/docs/api-reference/images/create
- `gpt-image-2` reasons before drawing, renders text at ~99% character accuracy across Latin,
  CJK, Hindi and Bengali, and outputs up to 4K. —
  https://openai.com/index/introducing-chatgpt-images-2-0/ ·
  https://community.openai.com/t/introducing-gpt-image-2-available-today-in-the-api-and-codex/1379479
- Belt defaults: `model: gpt-image-2`, `quality: low` for drafts (`medium`/`high` for text-dense
  or final assets), `size: 1024x1024` (or `1536x1024` / `1024x1536`; `auto` is the API default),
  `output_format: png` (`jpeg` is faster, `webp` smaller), `moderation: auto`, `n: 1`. —
  https://developers.openai.com/api/docs/guides/image-generation

## Two surfaces

- **Images API** (`POST /v1/images/generations`, `/v1/images/edits`): single-shot, returns
  `b64_json`. The surface for CLI and headless work. `gpt-image-1-mini` is the cheapest,
  `gpt-image-2` the most capable.
- **Responses API `image_generation` tool**: a mainline model (`gpt-5.6`, `gpt-5.5`,
  `gpt-5.4-mini/nano`, `gpt-5.2`, `gpt-5`, `o3`, `gpt-4.1*`, `gpt-4o*`) rewrites the prompt
  (`revised_prompt`) and calls a GPT Image model it selects. Multi-turn editing threads through
  `previous_response_id`, or by passing a prior `image_generation_call` id in `input`; File IDs
  are accepted as inputs. Tool params: `size`, `quality`, `output_format`, `output_compression`,
  `background`, `action` (auto/generate/edit), `partial_images`. Streaming events:
  `response.image_generation_call.partial_image`, `response.completed`. One-shot work costs the
  mainline model's tokens on top of the image, so the Images API is the default. —
  https://developers.openai.com/api/docs/guides/tools-image-generation

## Parameters (Images API, GPT Image models)

- `size`: `auto` | `1024x1024` | `1536x1024` | `1024x1536` | custom `WxH`. `gpt-image-2`
  custom constraints: max edge 3840px, edges multiples of 16, aspect <= 3:1, total pixels
  655,360–8,294,400. Above 2560x1440 is experimental. Custom sizes apply to edits too.
- `quality`: `low` | `medium` | `high` | `auto` (default `auto`).
- `background`: `transparent` | `opaque` | `auto`. Transparent is preview on `gpt-image-2` and
  requires `png` or `webp`.
- `output_format`: `png` (default) | `jpeg` | `webp`; `output_compression` 0–100 (jpeg/webp
  only, default 100).
- `moderation`: `auto` (default) | `low`. A blocked request returns
  `error.code = "moderation_blocked"` with `moderation_details.{moderation_stage, categories}`.
- `n`: 1–10. `stream: true` + `partial_images` 0–3 streams progressive renders (+100 output
  tokens per partial).
- Edits: `image[]` up to 16 inputs (`file_id` or `image_url`/base64), total under 50 MB; `mask`
  is a PNG with alpha, same size and format as the first image — transparent pixels are
  repainted. `input_fidelity: high|low` exists for `gpt-image-1.5` / `gpt-image-1` /
  `gpt-image-1-mini`; **omit it for `gpt-image-2`** (always high; the API rejects it).
- Latency: complex prompts up to ~2 minutes.
— https://developers.openai.com/api/docs/guides/image-generation ·
https://developers.openai.com/api/docs/api-reference/images/createEdit

## Minimal Node (openai SDK)

```js
import OpenAI from "openai"; import fs from "node:fs";
const openai = new OpenAI();
const g = await openai.images.generate({ model: "gpt-image-2", prompt, size: "1024x1024", quality: "low", output_format: "png" });
fs.writeFileSync("out.png", Buffer.from(g.data[0].b64_json, "base64"));
const e = await openai.images.edit({ model: "gpt-image-2", image: [fs.createReadStream("in.png")], mask: fs.createReadStream("mask.png"), prompt: "change only X; keep everything else the same", quality: "medium" });
fs.writeFileSync("edit.png", Buffer.from(e.data[0].b64_json, "base64"));
```

Responses API multi-turn: `openai.responses.create({ model: "gpt-5.6", input, tools: [{ type: "image_generation" }] })`,
then again with `previous_response_id: r.id` and the new instruction. —
https://developers.openai.com/api/docs/guides/image-generation

## Pricing (USD per image; token-billed, so estimates)

| Model | Low 1024² / 1536×1024 | Medium | High | Per 1M tokens (img in / img out) |
|---|---|---|---|---|
| gpt-image-2 | $0.006 / $0.005 | $0.012 / $0.010 | $0.040 / $0.032 | $8 / $30 (text in $5) |
| gpt-image-1.5 | $0.009 / $0.013 | $0.034 / $0.05 | $0.133 / $0.20 | $8 / $32 |
| gpt-image-1 | $0.011 / $0.016 | $0.042 / $0.063 | $0.167 / $0.25 | $10 / $40 |
| gpt-image-1-mini | $0.005 / $0.006 | $0.011 / $0.015 | $0.036 / $0.052 | $2.50 / $8 |

Batch API is 50% off. Larger custom sizes on `gpt-image-2` scale with output tokens
(third-party calculators quote up to ~$0.21 at 4K high). —
https://developers.openai.com/api/docs/pricing ·
https://developers.openai.com/api/docs/models/gpt-image-1.5 ·
https://developers.openai.com/api/docs/models/gpt-image-1 ·
https://developers.openai.com/api/docs/models/gpt-image-1-mini ·
https://costgoat.com/pricing/openai-images

## Rate limits (all GPT Image models; images per minute / tokens per minute)

Tier 1: 5 / 100k · Tier 2: 20 / 250k · Tier 3: 50 / 800k · Tier 4: 150 / 3M · Tier 5: 250 / 8M.
— https://developers.openai.com/api/docs/models/gpt-image-2

## Prompting

Source: https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
(gpt-image-1.5 companion: https://cookbook.openai.com/examples/multimodal/image-gen-1.5-prompting_guide)

- Order prompts consistently: scene/background → subject → key details → constraints; state
  the intended use (ad, UI mock, infographic) to set the mode and polish level.
- Use line breaks or labeled segments for complex prompts; pick one format (descriptive, JSON,
  tag list) and keep it.
- Exact text: quotes or ALL CAPS; specify font, size, color, placement; spell unusual words
  letter by letter; demand "verbatim, no extra characters"; `quality: medium|high` for small or
  dense text.
- Edits: "change only X, keep everything else the same"; name the invariants (layout, labels,
  saturation, camera angle, likeness) and restate them on every iteration to prevent drift.
- Iterate with single small changes from a clean base; re-specify details that start drifting;
  "same style as before" works in multi-turn context.
- Start at `quality: low` and upgrade only when the output falls short; `high` for infographics,
  portraits, edits, high-res output. `input_fidelity: high` for likeness on 1.x models.
- Photorealism: say "photorealistic", use camera language (lens, lighting, depth of field,
  grain), ask for real texture and "no glamorization, no heavy retouching".
- Logos: describe brand personality and use, ask for a strong silhouette and negative space,
  `background: transparent` + `png`, `n: 4` for variants.
- UI mockups: describe the product as if shipped (layout, hierarchy, spacing, real controls),
  not as concept art.
- Multi-image inputs: refer to them by index and description ("apply Image 2's style to
  Image 1"); specify lighting, perspective and scale matching for composites.
- Exclusions are explicit ("no watermark", "no extra text"); treat outputs above 2K as
  experimental.

The vendored `01`–`08` docs in this directory carry the longer reference material
(request shapes, mask construction, consistency and compositing workflows); this file is the
summary that wins on conflict.
