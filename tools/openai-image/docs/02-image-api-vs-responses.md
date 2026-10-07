# 02 — Image API vs Responses API

Both APIs can generate images. Which one to reach for:

| Dimension | Image API | Responses API |
|---|---|---|
| Model parameter | `gpt-image-2` (generation model) | `gpt-5.6` (mainline) with `image_generation` tool |
| State | Stateless | Threaded via `previous_response_id` |
| Multi-turn edits | Caller must re-upload prior image | Model keeps context automatically |
| Prompt revision | None (literal prompt) | Model returns a `revised_prompt` it used |
| Input images | Bytes / multipart only | Bytes **or** Files API `file_id`s |
| Streaming | Yes (`partial_images`) | Yes (via SSE events on the response) |
| Best for | Batch pipelines, single shots | Chat UIs, iterative design loops |

## When to pick which

Pick **Image API** when:
- You have a complete prompt and want the image.
- You're batch-generating many independent images.
- You don't want the mainline model rewriting your prompt.
- You want the simplest surface and cheapest call path.

Pick **Responses API** when:
- Users will iterate ("make it warmer", "add a hat").
- You want the model to decide when to generate vs. edit.
- You already use Responses for tool-using agents and want image gen in-context.
- You need Files API integration (e.g. upload once, reference by ID in many turns).

## Cost shape

- **Image API**: pay for output image tokens only (plus input tokens if editing with references).
- **Responses API**: pay for the mainline model's input/output tokens **plus** the image tool's output image tokens. A simple 1-image generate via Responses is always more expensive than the same call via Image API.

## Example equivalence

```js
// Image API — one-shot
const r = await client.images.generate({ model: 'gpt-image-2', prompt: 'A fox' });
const png = Buffer.from(r.data[0].b64_json, 'base64');

// Responses API — equivalent, but routed through a mainline model (gpt-5.6, gpt-5.5, gpt-5.4-mini/nano, gpt-5.2, gpt-5, o3, gpt-4.1*, gpt-4o*)
const r2 = await client.responses.create({
  model: 'gpt-5.6',
  input: 'Generate an image of a fox',
  tools: [{ type: 'image_generation' }],
});
const call = r2.output.find(o => o.type === 'image_generation_call');
const png2 = Buffer.from(call.result, 'base64');
```

The second form costs more but gives you `response.id` to feed into the next turn.
