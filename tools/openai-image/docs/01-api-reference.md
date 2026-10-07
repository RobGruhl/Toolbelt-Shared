# 01 — API Reference

OpenAI exposes image generation through **two surfaces**. Pick based on whether you need one-shot output or multi-turn conversation.

## Image API (`client.images.*`)

Flat, stateless REST. Best for single-prompt generation or edits.

| Endpoint | Method | Purpose |
|---|---|---|
| `/images/generations` | `client.images.generate` | Generate from prompt |
| `/images/edits` | `client.images.edit` | Edit / compose / inpaint |
| `/images/variations` | `client.images.createVariation` | Variations (DALL·E 2 only) |

### Generations request

```js
await client.images.generate({
  model: 'gpt-image-2',           // required
  prompt: 'A tabby cat...',       // required
  size: '1024x1024',              // or 'auto'
  quality: 'low',                 // low | medium | high | auto
  output_format: 'png',           // png | jpeg | webp
  output_compression: 70,         // 0-100, jpeg/webp only
  background: 'auto',             // auto | opaque
  moderation: 'auto',             // auto | low
  n: 1,                           // number of images
  stream: false,                  // set true for SSE
  partial_images: 0,              // 0-3 (streaming only)
});
```

Returns `{ data: [{ b64_json }, ...] }`. Base64-decode to get PNG/JPEG bytes.

### Edits request

```js
await client.images.edit({
  model: 'gpt-image-2',
  image: /* File | File[] */,
  mask: /* optional File */,
  prompt: '...',
  // same size/quality/format/compression/n options
});
```

- `image` can be a single File or an array (up to several references).
- If both `image[]` and `mask` are given, the mask applies to the **first** image.

### Streaming

Set `stream: true` + `partial_images: N` (N = 0..3). Each event arrives as `image_generation.partial_image` with `b64_json`; final as `image_generation.completed`. Each partial adds +100 output tokens.

## Responses API (`client.responses.*`)

Conversational. State is threaded via `previous_response_id`. The model chooses whether to generate or edit across turns.

```js
await client.responses.create({
  model: 'gpt-5.6',                // mainline model, not gpt-image-*
  input: 'Generate an image of...', // string or structured content
  tools: [{
    type: 'image_generation',
    action: 'auto',                // auto | generate | edit
    quality: 'high',
    partial_images: 2,             // enables streaming
    input_image_mask: { file_id }, // optional mask for edits
  }],
  previous_response_id: 'resp_...', // chain turns
});
```

Pull results from `response.output.filter(o => o.type === 'image_generation_call')`. Each call has:
- `id` — reuse to re-inject into a later `input`
- `result` — base64 PNG bytes
- `revised_prompt` — the model's rewritten prompt

### Choosing

- One prompt, one image → **Image API**.
- Iterate ("now make it realistic", "add snow") → **Responses API**.
- Streaming partials → supported on both.

## Auth

Header `Authorization: Bearer $OPENAI_API_KEY`. The SDK reads `OPENAI_API_KEY` automatically.

**Org verification required** for `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`. See <https://help.openai.com/en/articles/10910291-api-organization-verification>.
