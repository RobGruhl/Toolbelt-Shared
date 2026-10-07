# 03 — Sizes, Quality, Formats

## Size

`gpt-image-2` accepts **any** resolution meeting these constraints:

- Max edge ≤ `3840px`
- Both edges multiples of `16px`
- Long:short ratio ≤ `3:1`
- Total pixels between `655,360` and `8,294,400`

Use `size: 'auto'` to let the model pick. Square is typically fastest.

### Popular presets

| Size | Aspect | Notes |
|---|---|---|
| `1024x1024` | 1:1 | Fastest square, cheapest |
| `1536x1024` | 3:2 | Landscape |
| `1024x1536` | 2:3 | Portrait |
| `2048x2048` | 1:1 | 2K square |
| `2048x1152` | 16:9 | 2K landscape |
| `3840x2160` | 16:9 | **4K** — experimental (>2K) |
| `2160x3840` | 9:16 | 4K portrait — experimental |

Outputs above 2K (`> 3,686,400` pixels) are flagged experimental: treat them as best-effort, slower, and more variable.

## Quality

| Value | Use for |
|---|---|
| `low` | Drafts, thumbnails, smoke tests — **fastest and cheapest**. Default everywhere in this repo's examples. |
| `medium` | Standard web assets. |
| `high` | Final deliverables, print. Can take up to 2 min for complex prompts. |
| `auto` | API default — model picks. |

## Output format

| Format | Compression? | Notes |
|---|---|---|
| `png` | No | Default. Lossless. Larger. |
| `jpeg` | `output_compression: 0-100` | **Faster server-side than PNG.** Prefer for latency. |
| `webp` | `output_compression: 0-100` | Smaller than JPEG at similar quality. |

```js
await generate(prompt, { format: 'jpeg', compression: 70 });
```

## Background

| Value | Behavior |
|---|---|
| `auto` | Model picks |
| `opaque` | Always solid background |
| `transparent` | Alpha background. **Preview on gpt-image-2**; requires `format: 'png'` or `'webp'`. Stable on gpt-image-1.x. |

If a transparent render comes back opaque, re-run on `gpt-image-1` or post-process with `rembg`/similar.

## Moderation

- `auto` (default) — standard content policy filtering.
- `low` — less restrictive filtering. Use when your product already has downstream review.
