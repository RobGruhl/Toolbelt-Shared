# 06 — Character & Style Consistency

How to keep a character, art style, or world visually consistent across many generations — for graphic novels, children's books, storyboards, product photography series, anything where drift across frames ruins the output.

## What changed with gpt-image-2

- **Identity preservation is first-class now.** OpenAI's own cookbook lists "robust facial and identity preservation for edits, character consistency, and multi-step workflows" as a core capability of `gpt-image-2`. The recipe below is documented, not a workaround.
- **`input_fidelity` is locked to high.** You can't tune it — every reference image is processed at high fidelity automatically. You pay more input tokens; you get better consistency.
- **Text rendering is usable.** Signage, labels, short strings hold up. Readable comic lettering still isn't reliable — do lettering outside the model.
- **Responses API retains prior images** via `previous_response_id`, so iterative refinement doesn't require re-uploading.

## The core workflow (from OpenAI's cookbook)

```
1. Generate ONE canonical reference image of the subject.
2. For every subsequent frame, call the edits endpoint with that reference.
3. Prompt pattern:
   - Restate identity:  "Same character. Same [hair], [eyes], [outfit],
                         same proportions, same palette."
   - Describe the new scene/action/emotion.
   - Add a negative:    "Do not redesign the character."
```

That's it. The edits endpoint + an explicit restatement of identity + a "do not redesign" negative is the current official answer.

## The character bible

A **fixed canonical descriptor string**, 5–10 key visuals. This is the sweet spot:

> `Elara: 30s, olive skin, sharp green eyes, silver braid down left shoulder, scarred right cheek, leather armor with emerald clasps, lean build.`

- **Too short** (e.g., "elf warrior") → drifts wildly across frames.
- **Too long** (20+ traits, backstory, mood) → over-constrains; pose and emotion requests get ignored.
- **Rule of thumb:** if 80% of generations match without the reference image, the bible is strong enough.

Keep the bible as an identity descriptor. Put demeanor, emotion, pose, and lighting in the *per-frame* prompt, not the bible.

## Practical pipeline

1. **Script → scene breakdown.** One entry per frame: location, characters present, camera angle, action, emotion. Structured (JSON/YAML) so you can iterate without rewriting prose.
2. **Character bible per character.** The fixed descriptor string above.
3. **Master reference sheets.** Generate once per character: front / three-quarter / profile in a neutral pose, plus a 4–6 emotion grid. These are your reference inputs.
4. **Optional style anchor.** One carefully-generated tone image that establishes palette, line weight, and rendering style. Used as a second reference with a distinct role from the character sheet.
5. **Per-frame call.** `edit()` with character sheet as reference #1, style anchor as reference #2. Prompt = bible + scene/action/emotion + "Same character as reference. Do not redesign."
6. **Re-anchor every ~10 frames.** Add a recent *good* frame as an extra reference. This is the technique that actually defeats slow drift in long sequences.
7. **Generate 2–3 variants per frame at `quality: 'low'`, pick the best, re-render at `high` only for final.**
8. **Lettering, panel layout, and FX belong outside the model.** Affinity Publisher, Clip Studio, Figma.

## Example: edit with character sheet + style anchor

```js
import { edit, saveImage } from './lib/gpt-image.js';

const ELARA = 'Elara: 30s, olive skin, sharp green eyes, silver braid down ' +
              'left shoulder, scarred right cheek, leather armor with emerald clasps, lean build.';

const { images } = await edit(
  `${ELARA}
   Scene: Elara crouched on a rainswept rooftop at dusk, looking down at a
   lamp-lit alley, determined expression, three-quarter view from behind.
   Same character as reference. Same armor, same braid, same scarred cheek,
   same proportions, same color palette. Do not redesign the character.`,
  {
    image: ['refs/elara-sheet.png', 'refs/style-anchor.png'],
    quality: 'high',
  }
);

saveImage(images[0], 'panels/ch01-p03-panel2.png');
```

Two references, distinct roles: character identity vs. art style. Don't reuse one image for both — the roles blur and extraction degrades.

## Multi-turn variant (Responses API)

When you want the model to iterate on its own last image without re-uploading:

```js
import { generateViaResponses } from './lib/gpt-image.js';

const t1 = await generateViaResponses(
  `${ELARA} Elara at a market stall, cheerful, holding a copper coin.`
);
const t2 = await generateViaResponses(
  `Same character, same everything. Now she's turning to run, startled.
   Do not redesign the character.`,
  { previousResponseId: t1.responseId, action: 'edit' }
);
```

Cheaper for short iterative loops. For long sequences, edits-endpoint + reference images scales better.

## What still breaks

- **Drift over long runs.** Even gpt-image-2 drifts 40+ frames in without re-anchoring. Budget a re-reference cadence (step 6).
- **Environments drift more than characters.** A consistent protagonist in an inconsistent world is a common failure. Apply the same reference-image technique to locations: one canonical "establishing shot" per recurring location.
- **Multi-character scenes.** Two characters together is fragile even with both sheets as references. Generating separately and compositing is the common workaround.
- **Expressive poses.** Over-specifying the bible locks the face into neutral; strong emotion requests get ignored. Keep identity in the bible, demeanor in the per-frame prompt.
- **Painterly and European graphic-novel styles** (Bilal, Mattotti, Mignola) are harder to lock than manga or clean-line Western comic style. Expect more iteration.
- **Readable comic lettering** is still unreliable. Do it in layout software.

## Further reading

- [OpenAI cookbook — image-gen prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide) — the official character-consistency workflow
- [ai-flow.net consistent-character workflow for gpt-image](https://ai-flow.net/blog/consistent-character-generation-workflow-gpt-image/) — shipped pipeline writeup
- [Steve Newcomb — AI character bibles](https://stevenewcomb.substack.com/p/ai-character-bibles) — structural approach, model-agnostic
- [getimg.ai multi-reference combinations](https://getimg.ai/guides/guide-to-multiple-image-references-combinations) — empirical matrix of reference-role combos (not OpenAI-specific but the principle transfers)
- [OpenAI community thread on comic-character consistency](https://community.openai.com/t/how-to-achieve-consistency-of-comic-characters/591652) — real failure modes and workarounds
