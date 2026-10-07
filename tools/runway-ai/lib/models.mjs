/**
 * The models rwy will spend on, their request shapes, and their credit prices.
 *
 * Runway request bodies are a discriminated union on `model`: allowed ratios, durations and
 * optional fields differ per model, so each entry here carries its own. Only models whose
 * price is a fixed function of the request are listed — rwy prices every call before it is
 * made, and a model it cannot price it does not call.
 *
 * Sources (read 2026-09-25): https://docs.dev.runwayml.com/api.md for fields,
 * https://docs.dev.runwayml.com/guides/pricing.md for credits. 1 credit = $0.01.
 * When Runway changes a price or retires a model, this file is the one to edit.
 */

export const USD_PER_CREDIT = 0.01;
export const PRICES_AS_OF = '2026-09-25';

const GEN4_IMAGE_RATIOS = ['1024:1024', '1080:1080', '1168:880', '1360:768', '1440:1080', '1080:1440', '1808:768', '1920:1080', '1080:1920', '2112:912', '1280:720', '720:1280', '720:720', '960:720', '720:960', '1680:720'];
const I2V_RATIOS = ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'];

export const IMAGE_MODELS = {
  muse_image: {
    ratios: ['auto', '2352:1008', '2016:1152', '1920:1280', '1792:1344', '1600:1600', '1344:1792', '1280:1920', '1152:2016'],
    defaultRatio: 'auto',
    maxPrompt: 4000,
    multiOutput: true,
    refs: { max: 10, tags: false },
    credits: ({ n }) => ({ credits: n, basis: `1 credit per image × ${n}` }),
    note: 'cheapest; 1 credit per image, up to 4 per call here',
  },
  gen4_image: {
    ratios: GEN4_IMAGE_RATIOS,
    defaultRatio: '1920:1080',
    maxPrompt: 1000,
    multiOutput: false,
    refs: { max: 3, tags: true },
    // Pricing is 5 credits at 720p and 8 at 1080p; the docs do not map each ratio to a tier,
    // so every ratio is priced at the 1080p rate — an upper bound, and the preview says so.
    credits: () => ({ credits: 8, basis: '8 credits (1080p rate; 720p-class ratios bill 5 — upper bound)' }),
    note: "Runway's own image model; 5–8 credits per image",
  },
};

export const VIDEO_MODELS = {
  'gen4.5': {
    textRatios: ['1280:720', '720:1280'],
    imageRatios: I2V_RATIOS,
    defaultRatio: '1280:720',
    durations: [2, 10],
    defaultDuration: 5,
    text: true,
    image: true,
    maxPrompt: 1000,
    perSecond: 12,
    note: "Runway's flagship; text or first-frame image; 12 credits/s",
  },
  gen4_turbo: {
    imageRatios: I2V_RATIOS,
    defaultRatio: '1280:720',
    durations: [2, 10],
    defaultDuration: 5,
    text: false,
    image: true,
    maxPrompt: 1000,
    perSecond: 5,
    note: 'image-to-video only; cheapest Runway video at 5 credits/s',
  },
};

export const AUDIO_MODELS = {
  eleven_text_to_sound_v2: {
    durations: [1, 30],
    defaultDuration: 10,
    maxPrompt: 3000,
    perSecond: 1,
    note: 'sound effects and ambience from a description; 1 credit/s, 1–30 s',
  },
};

export const DEFAULT_IMAGE_MODEL = 'muse_image';
export const DEFAULT_VIDEO_MODEL = 'gen4.5';
export const DEFAULT_AUDIO_MODEL = 'eleven_text_to_sound_v2';

export function audioCredits(model, duration) {
  const m = AUDIO_MODELS[model];
  return { credits: m.perSecond * duration, basis: `${m.perSecond} credit/s × ${duration}s` };
}

export function videoCredits(model, duration) {
  const m = VIDEO_MODELS[model];
  return { credits: m.perSecond * duration, basis: `${m.perSecond} credits/s × ${duration}s` };
}

/** POST /v1/text_to_image body. `refs` is [{ uri, tag? }]; gen4_image prompts cite a ref as @tag. */
export function buildImageRequest({ model, prompt, ratio, n, seed, refs = [] }) {
  const body = { model, promptText: prompt, ratio };
  if (IMAGE_MODELS[model].multiOutput && n > 1) body.outputCount = n;
  if (refs.length) body.referenceImages = refs.map(r => (r.tag ? { uri: r.uri, tag: r.tag } : { uri: r.uri }));
  if (seed !== undefined) body.seed = seed;
  return { endpoint: 'text_to_image', body };
}

/** POST /v1/text_to_video or /v1/image_to_video body. `image` is a URI (https, data or runway). */
export function buildVideoRequest({ model, prompt, ratio, duration, image, seed }) {
  const body = { model, ratio, duration };
  if (prompt) body.promptText = prompt;
  if (image) body.promptImage = image;
  if (seed !== undefined) body.seed = seed;
  return { endpoint: image ? 'image_to_video' : 'text_to_video', body };
}

/** POST /v1/sound_effect body. A fixed duration keeps the price exact. */
export function buildAudioRequest({ model, prompt, duration, loop }) {
  const body = { model, promptText: prompt, duration };
  if (loop) body.loop = true;
  return { endpoint: 'sound_effect', body };
}
