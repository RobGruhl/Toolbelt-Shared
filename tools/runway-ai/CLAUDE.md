# runway-ai (`rwy`) — the agent contract

## Read first

- **What:** paid image and video generation on the operator's own Runway Dev account, through
  the official `@runwayml/sdk`. `rwy.mjs` is the CLI; `lib/models.mjs` is the table of models it
  will call, their valid ratios and durations, and their credit prices.
- **Auth:** `$RUNWAYML_API_SECRET`, else `~/.config/toolbelt/runway-ai.key`, else the gitignored
  `tools/runway-ai/.env` — both files mode 600, enforced. `.env.example` is the template. No key
  is needed for `models` or any preview.
- **First read:** `node rwy.mjs balance` — credit balance, monthly cap, per-model tier limits.
- **Writes (all paid, all flag tier):** `image`, `video`, `audio`. A bare call **previews** — endpoint,
  model, ratio, duration, credit cost and its basis, the request body, the output stem — and
  exits 0 without calling the API. `--yes` submits, waits, and downloads the outputs.
- **The rule:** show the user the preview and never pass `--yes` on your own. If the user, in the
  conversation, approves a specific preview (the prompt, the model, the cost), re-run that same
  command with `--yes`. The approval must name the render, not the verb.
- **Live here?** `bin/toolbelt doctor runway-ai` — Node >= 20, `npm ci`, the API reachable.

```bash
node rwy.mjs models
node rwy.mjs balance
node rwy.mjs usage --days 7
node rwy.mjs image 'a lighthouse at dusk, watercolor' --out ./assets                       # preview
node rwy.mjs image 'a lighthouse at dusk, watercolor' --out ./assets -n 4 --yes             # 4 credits
node rwy.mjs video 'slow push-in on a foggy harbor at dawn' --out ./assets --duration 5 --yes   # 60 credits
node rwy.mjs video 'the waves start to move' --image still.png --model gen4_turbo --out ./assets --yes   # 25 credits
node rwy.mjs task <task-id> --out ./assets                                                  # collect a finished task
```

**Consistent characters across scenes.** Pull a frame with the characters from an earlier render
(`ffmpeg -ss 6 -i clip.mp4 -frames:v 1 ref.png`), draw each scene's keyframe with
`image --model gen4_image --ratio 1280:720 --ref pair=ref.png '@pair …'`, then animate each
keyframe with `video --image keyframe.png`. Keyframes cost 8 credits and double as the
storyboard; a text-only `video` redraws the characters every time.

Exit codes: `0` done or previewed · `1` API, credential or filesystem failure · `2` usage, or a
ceiling.

## Choosing a surface

Runway Dev offers five surfaces. This tool implements **Models** — direct generation with a
named model — because it is the shortest path from prompt to file and every call can be priced
before it is made.

| Surface | What it is | Here |
|---|---|---|
| Models | `POST /v1/text_to_image`, `/text_to_video`, `/image_to_video`, `/sound_effect`, … with an explicit `model` | `image`, `video`, `audio` |
| Model Routers | a saved config picks the model by cost, latency or quality; `POST /v1/generate/*` | not built |
| Recipes | packaged multi-step jobs (`product_ad`, `multi_shot_video`, …), 13–228 credits and up | not built |
| Characters | real-time conversational avatars, billed per second of session | not built |
| Workflows | saved multi-step graphs invoked by id | not built |

A new surface or model is a new entry in `lib/models.mjs` (fields from
`https://docs.dev.runwayml.com/api.md`, credits from `/guides/pricing.md` — the only place
Runway publishes prices) plus, for a new endpoint, a request builder. Never guess a field: the
request body is a discriminated union on `model`, so ratios, durations and required fields differ
between models even on one endpoint. The docs are Markdown at any page path + `.md`;
`https://docs.dev.runwayml.com/ai-context.md` is the primer.

## Gates and ceilings

The spend is private and bounded, so the gate is the **flag tier** (SENSIBILITIES #2): the
preview prevents the accidental call; `--yes` is always honored. What no flag can raise — change
the constant in `rwy.mjs` and the diff is the review:

| Constant | Value | Effect |
|---|---|---|
| `MAX_CREDITS_PER_CALL` | 120 ($1.20) | exit 2 above it; exactly one 10 s `gen4.5` clip |
| `MAX_N` | 4 | images per call (`muse_image` allows 10) |
| `MAX_IMAGE_BYTES` | 3.3 MB | local first-frame images travel as data URIs, which Runway caps at 5 MB encoded |
| `WAIT_MS` | 5 min image, 15 min video | how long `--yes` polls before handing back the task id |

Before submitting, `--yes` checks the credit balance and refuses a call it cannot cover. The
create request runs with SDK retries off, so a dropped connection cannot start a second billed
task.

**Content moderation is billed.** A generation Runway's moderation stops ends as a `FAILED` task
and costs the same as a success; repeated moderated requests can suspend the account. Recognizable
public figures, real people's likenesses and explicit content are the usual triggers.

**Containment.** `--out <dir>` is required to spend and every file lands inside it; the root and
home directory are refused, `--name` is `[A-Za-z0-9._-]` only, and an existing output stem is
refused before any credit is spent. Write into the project the user is working in, not this
tool's `output/`.

**Outputs expire.** Runway's output URLs last 24–48 hours. `--yes` downloads immediately; if the
wait times out, the error prints `node rwy.mjs task <id> --out <dir>`, which collects the result
without spending again.

**Audit.** One line per paid task on stderr and in `~/.local/share/runway-ai/audit.log`
(dir 700, file 600): time, verb, model, task id, status, estimated and charged credits, files or
failure. Never the key or the prompt. `node rwy.mjs usage` is Runway's own ledger to reconcile it
against.

## Models priced here

Prices as of 2026-09-25; 1 credit = $0.01.

| Model | Endpoint | Cost | Notes |
|---|---|---|---|
| `muse_image` (default image) | text_to_image | 1 credit/image | `auto` ratio lets the model frame it |
| `gen4_image` | text_to_image | 5–8 credits | priced at 8; the docs do not map ratios to the 720p/1080p tiers |
| `gen4.5` (default video) | text_to_video, image_to_video | 12 credits/s, 2–10 s | text ratios `1280:720`, `720:1280`; image adds four more |
| `gen4_turbo` | image_to_video only | 5 credits/s, 2–10 s | cheapest way to animate a still |
| `eleven_text_to_sound_v2` (default audio) | sound_effect | 1 credit/s, 1–30 s | effects and ambience; `--loop` for a seamless bed. Music comes from the elevenlabs tool's `music` verb |

Everything else in Runway's catalog (Veo, Seedance, Wan, Hailuo, Aleph, GPT/Gemini image models,
upscalers, speech and dubbing) is callable by the API but not by `rwy` until it has a row in `lib/models.mjs`.

## Not here

- **No cancel or delete verb.** `DELETE /v1/tasks/{id}` cancels a running task but *deletes* a
  finished one's outputs; cancel from the portal.
- **Runway Dev MCP** (`https://dev.runwayml.com/mcp`, OAuth) gives an agent live account reads
  and router management. Register it yourself if wanted:
  `claude mcp add --transport http --scope user runway-dev-mcp https://dev.runwayml.com/mcp`, then
  `/mcp` to sign in in your own browser. Its writes are the service's, not this belt's gates.
- **Runway's `npx skills add runwayml/skills`** is not installed: the belt routes through its one
  skill, and this file is the contract.
