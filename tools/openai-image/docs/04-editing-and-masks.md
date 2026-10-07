# 04 — Editing and Masks

The edits endpoint does three things depending on what you pass:

| Inputs | Behavior |
|---|---|
| `image` (one) + `prompt` | Transform the image per the prompt |
| `image[]` (multiple) + `prompt` | Compose a **new** image using the inputs as visual references |
| `image` + `mask` + `prompt` | Inpaint only the masked (transparent) region |

## Reference composition

Pass up to several images. The model pulls visual elements (subjects, materials, colors) from them into a newly-generated scene described by `prompt`.

```js
await client.images.edit({
  model: 'gpt-image-2',
  image: [file1, file2, file3, file4],
  prompt: "Photorealistic gift basket labeled 'Relax & Unwind' containing all the items in the reference pictures",
});
```

## Masking

The mask's **alpha channel** is what matters. Transparent pixels = editable. Opaque pixels = preserved.

Requirements:
- Mask and base image must be the **same size** and **same format**.
- File size < 50MB.
- Mask **must** have an alpha channel. A plain black-and-white PNG won't work.

Masking on GPT Image is **prompt-guided** — the model uses the mask as a hint and may not hit its exact edges. Include descriptive prompt text about what should appear in the masked region.

### Converting a B&W mask to alpha

If your tool exports grayscale PNGs, use the grayscale as the alpha channel:

```python
from PIL import Image
mask = Image.open('mask_bw.png').convert('L')
rgba = mask.convert('RGBA')
rgba.putalpha(mask)          # black = transparent, white = opaque
rgba.save('mask_alpha.png')
```

Or in Node with `sharp`:

```js
import sharp from 'sharp';
const bw = await sharp('mask_bw.png').greyscale().toBuffer();
await sharp(bw)
  .ensureAlpha()
  .joinChannel(bw)           // reuse greyscale as alpha
  .png()
  .toFile('mask_alpha.png');
```

## Input fidelity

On `gpt-image-2`, `input_fidelity` is **not** settable — every reference image is processed at high fidelity automatically, and the API rejects the parameter, so the client omits it for that model. `input_fidelity: 'high' | 'low'` applies to `gpt-image-1.5`, `gpt-image-1` and `gpt-image-1-mini` only. High-fidelity references push up input token counts for edit requests with many references; budget accordingly.

## Multi-turn editing (Responses API)

If you're doing iterative edits, the Responses API keeps the prior image in context so you don't re-upload:

```js
const r1 = await client.responses.create({
  model: 'gpt-5.6',
  input: 'A cat hugging an otter',
  tools: [{ type: 'image_generation' }],
});
const r2 = await client.responses.create({
  model: 'gpt-5.6',
  input: 'Now make it realistic',
  previous_response_id: r1.id,
  tools: [{ type: 'image_generation', action: 'edit' }],
});
```

Use `action: 'edit'` to force editing. If no image exists in context, a forced edit call errors. Leave it at `auto` and the model decides.
