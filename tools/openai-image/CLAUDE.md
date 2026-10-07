# openai-image (`oimg`) — the agent contract

## Read first

- **What:** paid image generation on the operator's own OpenAI account — `gpt-image-2` through
  the Images API (`generate`, `edit`) and the Responses API `image_generation` tool
  (`responses`, multi-turn). A CLI (`oimg.mjs`) over a client library (`lib/gpt-image.js`)
  other projects may copy.
- **Auth:** `$OPENAI_API_KEY`, else `~/.config/toolbelt/openai-image.key` (mode 600, enforced).
  The organization must have completed API verification or every gpt-image call 403s. No key is
  needed to preview or to run `models`.
- **First read:** `node oimg.mjs models` — model ids, per-image prices, rate-limit tiers; no network.
- **Writes (all paid, all flag tier):** `generate`, `edit`, `responses`. A bare call **previews**
  — model, size, quality, n, estimated cost and its basis, input files, the exact output paths,
  whether a credential was found — and exits 0 without calling the API. `--yes` runs it.
- **The 24h hard ask (exit 3):** before any paid call, oimg adds up the real spend of the last 24
  hours (token counts in the audit log, at TOKEN_RATES) plus this call. Past **$50**, plus any
  allowances, `--yes` stops with exit 3 and sends nothing. **When you hit it, stop and ask the
  user in the conversation, naming the numbers**: "Image spend is $X in the last 24h. OK to
  allow another $50?" Only after they say yes to an amount, run
  `node oimg.mjs allow --usd <that amount> --note "<their words>" --yes`, then continue. Their
  acknowledgment is the gate (Rob, 2026-10-05: "just a user acknowledgment"). Never allow on
  your own initiative, never inflate the amount past what they said, and never route around the
  gate by importing `lib/gpt-image.js`. Standing pre-approval for a project's renders does not
  cover the line. Ask each time it trips.
- **Report real spend, not estimates:** `node oimg.mjs spend` prices the audit log's tokens. The
  preview's `est cost` is a guess. gpt-image-2's table was ~5× low until 2026-10-05: 513 renders
  were estimated at $19 and actually cost $100.
- **The rule:** show the user the preview and never pass `--yes` on your own. If the user, in the
  conversation, approves a specific preview (the prompt, the size, the cost), re-run that same
  command with `--yes`. The approval must name the render, not the verb.
- **Live here?** `bin/toolbelt doctor openai-image` — Node >= 20, `npm install`, a key (warn only).
- **Doctrine:** [docs/openai-image-best-practices.md](docs/openai-image-best-practices.md) —
  models, parameters, pricing, rate limits, prompting, with source URLs. Read it before
  drafting a prompt for anything that matters.

```bash
node oimg.mjs models
node oimg.mjs generate 'a product shot of a brass compass, studio light' --out ./assets            # preview
node oimg.mjs generate 'a product shot of a brass compass, studio light' --out ./assets --yes      # $0.006
node oimg.mjs generate '…' --out ./assets --quality high --size 1536x1024 --name compass-hero --yes
node oimg.mjs edit 'change only the sky to dusk, keep everything else the same' --image in.png --mask sky-mask.png --out ./assets --yes
node oimg.mjs responses 'a tabby cat hugging an otter' --out ./assets --yes                       # prints response_id
node oimg.mjs responses 'now make it photorealistic' --previous resp_… --out ./assets --yes
```

Exit codes: `0` done or previewed · `1` API, credential or filesystem failure · `2` usage, or a
ceiling · `3` the 24h hard ask: ask the operator, then `oimg allow` with their acknowledgment.

## Gates and ceilings

The spend is private and bounded, so the gate is the **flag tier** (SENSIBILITIES #2): the
preview prevents the accidental call; `--yes` is always honored because refusing a deliberate
render only pushes the work to an unguarded script. Two things no flag can raise — change the
constant in `oimg.mjs` and the diff is the review:

| Constant | Value | Effect |
|---|---|---|
| `MAX_N` | 4 | images per call (the API allows 10); exit 2 above it |
| `MAX_EST_USD` | 2.00 | estimated USD per call; exit 2 above it, naming the constant |
| `HARD_ASK_USD` | 50 | real spend per rolling 24h (+ allowances) before a paid call stops with exit 3 |
| `ALLOW_STEP_USD` / `MAX_ALLOW_USD` | 50 / 500 | default and largest single `oimg allow` grant; each expires after 24h |
| `DEFAULT_QUALITY` | `low` | drafts by default; pass `--quality high` for final assets |
| `TIMEOUT_MS` (lib) | 180 000 | complex prompts at `high` take up to ~2 minutes |

**Owner's standing preference:** for real deliverables, always `--quality high`. The code
default stays `low` because a belt default must be the cheap one; the human upgrades it.

**Containment.** `--out <dir>` is required and every file lands inside it — the root and the
home directory are refused, `--name` is `[A-Za-z0-9._-]` only, and an existing file is never
overwritten (the call is refused before any money is spent). Write into the project the user is
working in (its `assets/` or wherever its convention says), not into this tool's `output/`.

**Audit.** One line per image written, on stderr and appended to
`~/.local/share/openai-image/audit.log` (dir 700, file 600):

```
[oimg audit] 2026-08-22T20:11:04.118Z verb=generate model=gpt-image-2 size=1024x1024 quality=low est_usd=0.0060 file="/…/assets/compass.png" bytes=812344 tokens_in=12 tokens_out=272
```

The bytes come from re-stating the written file; the key is never in the line. "What did the
agent render last Tuesday" is one grep of that file.

## Estimates

Preset sizes (`1024x1024`, `1536x1024`, `1024x1536`) use the per-image prices in
`lib/constants.js`. For gpt-image-2 those are **calibrated from observed token usage**, because
the price-page figures were ~5× low: high is 7,024 output tokens per 1024² image ≈ $0.211 and
5,488 per 1536×1024 ≈ $0.165. Low and medium are scaled by the same factor, a deliberate
overestimate, until real usage is logged. Recalibrate from `tokens_out` in the audit log. Any other size is scaled from the 1024² price by pixel count and the preview
says `scaled … (estimate)`. `--quality auto` is priced as `high` — the upper bound. `edit` adds
"input-image tokens not included"; `responses` adds "plus gpt-5.6 text tokens, not estimated".
The API is token-billed, so every figure is an estimate; the audit line records actual token
usage when the API returns it.

## Quirks that cost money or time

- **`input_fidelity` is rejected by `gpt-image-2`** (always high). `buildEditRequest` drops it
  for that model and keeps it for `gpt-image-1.5` / `1` / `1-mini`.
- **`--background transparent`** is preview on `gpt-image-2` and needs `png` or `webp`; a jpeg
  request is refused before the call. An opaque result means fall back to `gpt-image-1`.
- **Masks need an alpha channel** the same size as the first `--image`; transparent pixels are
  repainted. Describe the change in the prompt too — masking is prompt-guided.
- **Sizes** must be `auto` or `WxH` with edges multiples of 16, max edge 3840, ratio <= 3:1,
  pixels in [655 360, 8 294 400]; above 2560x1440 the preview says `experimental`.
- **`responses` is one image per call** and costs the mainline model's tokens on top; use it
  only for multi-turn iteration (`--previous`) or Files-API inputs. `--action edit` errors when
  no image is in context; leave it `auto`.
- **`moderation_blocked`** exits 1 with the stage and categories; rephrase. 429 exits 1 with no
  retry. 403 means the organization is not verified.
- **Reference images from a conversation are ephemeral.** Copy them into the user's project
  before anything else; macOS screenshot names carry U+202F before AM/PM, so copy with a glob.
- **Independent renders fan out** — `Promise.allSettled` in a script, or parallel `oimg` calls —
  rather than a sequential loop; each call keeps its own preview, ceiling and audit line.

## The library

`lib/gpt-image.js` exports `generate`, `edit`, `stream`, `generateViaResponses`, `createClient`,
`resolveKey`, `saveImage`, the pure `buildGenerateRequest` / `buildEditRequest` /
`buildResponsesRequest`, `parseSize`, `estimateCost`, `usageOf`. The CLI previews exactly the
request the builders produce, so the preview and the call cannot drift. `stream()` (progressive
partials, +100 output tokens each) has no CLI verb. A project that copies `lib/` takes on the
gate itself: nothing in the library previews or audits — that is the CLI's job.

## Verb inventory

| Verb | Tier | Gate |
|---|---|---|
| `models` | read | — |
| `generate <prompt> --out <dir>` | write-gated, paid | preview → `--yes` |
| `edit <prompt> --image … [--mask …] --out <dir>` | write-gated, paid | preview → `--yes` |
| `responses <prompt> [--previous id] --out <dir>` | write-gated, paid | preview → `--yes` |
| dall-e-2 variations, Files API upload, batch | never | no verb exists |
