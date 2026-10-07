# openai-image (`oimg`)

Preview-first OpenAI image generation for the belt: `gpt-image-2` through the Images API
(one-shot generate, edit with references or a mask) and the Responses API `image_generation`
tool (multi-turn). The agent contract is [CLAUDE.md](CLAUDE.md); the doctrine with source URLs
is [docs/openai-image-best-practices.md](docs/openai-image-best-practices.md).

## Quick start

```bash
npm install
mkdir -p ~/.config/toolbelt && umask 077 && printf '%s\n' 'sk-…' > ~/.config/toolbelt/openai-image.key   # or export OPENAI_API_KEY
node oimg.mjs models                                               # prices, no network
node oimg.mjs generate 'a fox in a snowy field' --out ./assets     # preview: model, size, quality, cost, paths
node oimg.mjs generate 'a fox in a snowy field' --out ./assets --yes
```

Every paid verb previews and exits 0; `--yes` spends. Ceilings (`MAX_N` 4 images, `MAX_EST_USD`
2.00 per call) are constants in `oimg.mjs`. Output only lands inside `--out`, nothing is
overwritten, and each image gets an audit line on stderr and in
`~/.local/share/openai-image/audit.log`.

## Verbs

| Verb | What |
|---|---|
| `models` | model ids, per-image prices, token rates, rate-limit tiers |
| `generate <prompt> --out <dir>` | Images API one-shot; `--size`, `--quality`, `--format`, `--background`, `--moderation`, `-n` |
| `edit <prompt> --image a.png [--image b.png …] [--mask m.png] --out <dir>` | compose from up to 16 references, or inpaint the mask's transparent region |
| `responses <prompt> [--previous <response-id>] --out <dir>` | Responses API multi-turn; prints the `response_id` to iterate on |

## Client library

```js
import { generate, edit, stream, generateViaResponses, saveImage } from './lib/gpt-image.js';

const { images } = await generate('A fox in a snowy field', { quality: 'high', size: '1536x1024' });
saveImage(images[0], 'assets/fox.png');

await edit('Put a flamingo in the pool; change nothing else', { image: 'room.png', mask: 'mask.png' });

for await (const chunk of stream('An icy river', { partialImages: 2 })) {
  saveImage(chunk.buffer, `river-${chunk.isFinal ? 'final' : chunk.index}.png`);
}

const r1 = await generateViaResponses('A cat hugging an otter');
const r2 = await generateViaResponses('Now make it realistic', { previousResponseId: r1.responseId });
```

The key resolves from `$OPENAI_API_KEY`, then `~/.config/toolbelt/openai-image.key` (mode 600).
The library does not preview or audit; a project that copies `lib/` owns that.

## Docs

- [openai-image-best-practices](docs/openai-image-best-practices.md) — the doctrine: models, parameters, pricing, rate limits, prompting, with sources
- [API Reference](docs/01-api-reference.md) · [Image API vs Responses API](docs/02-image-api-vs-responses.md) · [Sizes, Quality, Formats](docs/03-sizes-quality-formats.md) · [Editing and Masks](docs/04-editing-and-masks.md) · [Pricing](docs/05-pricing.md)
- [Consistency Workflow](docs/06-consistency-workflow.md) · [Compositing & Print Tricks](docs/07-compositing-print-tricks.md) · [Prompting Best Practices](docs/08-prompting-best-practices.md)

`gpt-image-*` models require [API organization verification](https://help.openai.com/en/articles/10910291-api-organization-verification).
