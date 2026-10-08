/**
 * OpenAI Image generation constants.
 * Sources: https://developers.openai.com/api/docs/guides/image-generation
 *          https://developers.openai.com/api/docs/models/gpt-image-2
 *          https://developers.openai.com/api/docs/pricing
 * Doctrine (with source URLs): ../docs/openai-image-best-practices.md
 */

// Image API models (client.images.*). Snapshot ids are pinned where the docs publish them.
export const IMAGE_MODELS = {
  GPT_IMAGE_2: 'gpt-image-2',          // flagship; snapshot gpt-image-2-2026-04-21
  GPT_IMAGE_1_5: 'gpt-image-1.5',      // snapshot gpt-image-1.5-2025-12-16
  GPT_IMAGE_1: 'gpt-image-1',
  GPT_IMAGE_1_MINI: 'gpt-image-1-mini', // cheapest
  DALLE_3: 'dall-e-3',                 // legacy
  DALLE_2: 'dall-e-2',                 // legacy; the only model with a variations endpoint
};

// Mainline models that accept the image_generation tool in the Responses API.
export const RESPONSES_MODELS = {
  GPT_5_6: 'gpt-5.6',
  GPT_5_5: 'gpt-5.5',
  GPT_5_4_MINI: 'gpt-5.4-mini',
  GPT_5_4_NANO: 'gpt-5.4-nano',
  GPT_5_2: 'gpt-5.2',
  GPT_5: 'gpt-5',
  O3: 'o3',
};

export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS.GPT_IMAGE_2;
export const DEFAULT_RESPONSES_MODEL = RESPONSES_MODELS.GPT_5_6;

// Models that take `input_fidelity` on edits. gpt-image-2 is always high and REJECTS the
// parameter, so the client drops it for any model not listed here.
export const INPUT_FIDELITY_MODELS = new Set([
  IMAGE_MODELS.GPT_IMAGE_1_5,
  IMAGE_MODELS.GPT_IMAGE_1,
  IMAGE_MODELS.GPT_IMAGE_1_MINI,
]);

// Well-exercised sizes. gpt-image-2 accepts any WxH inside SIZE_CONSTRAINTS.
export const SIZES = {
  SQUARE: '1024x1024',
  LANDSCAPE: '1536x1024',
  PORTRAIT: '1024x1536',
  SQUARE_2K: '2048x2048',
  LANDSCAPE_2K: '2048x1152',
  LANDSCAPE_4K: '3840x2160',           // experimental (>2560x1440)
  PORTRAIT_4K: '2160x3840',            // experimental
  AUTO: 'auto',
};

// gpt-image-2 custom-size constraints (apply to edits too).
export const SIZE_CONSTRAINTS = {
  MAX_EDGE: 3840,
  EDGE_MULTIPLE: 16,
  MAX_RATIO: 3,
  MIN_PIXELS: 655_360,
  MAX_PIXELS: 8_294_400,
  RELIABLE_MAX_PIXELS: 2560 * 1440,   // above this is experimental
};

export const QUALITY = {
  LOW: 'low',       // drafts, thumbnails
  MEDIUM: 'medium', // text-dense assets
  HIGH: 'high',     // infographics, portraits, edits, final output
  AUTO: 'auto',     // API default
};

export const FORMAT = {
  PNG: 'png',       // default
  JPEG: 'jpeg',     // faster; supports output_compression
  WEBP: 'webp',     // smaller; supports output_compression
};

export const BACKGROUND = {
  AUTO: 'auto',
  OPAQUE: 'opaque',
  TRANSPARENT: 'transparent', // TRANSPARENT_MODELS only; requires png or webp
};

// Models that return a real alpha channel. gpt-image-2 answers background=transparent with
// HTTP 400 "Transparent background is not supported for this model".
export const TRANSPARENT_MODELS = new Set([
  IMAGE_MODELS.GPT_IMAGE_1_5,
  IMAGE_MODELS.GPT_IMAGE_1,
  IMAGE_MODELS.GPT_IMAGE_1_MINI,
]);

export const MODERATION = {
  AUTO: 'auto',     // default
  LOW: 'low',       // less restrictive
};

// Per-image price in USD for the three preset sizes. The API bills tokens; these are estimates.
// Custom sizes are scaled by pixel count in estimate().
// Reference: https://developers.openai.com/api/docs/pricing
//
// gpt-image-2 is CALIBRATED FROM REAL USAGE, not copied from a price page.
// The old table said $0.040 for a high 1024x1024 image. The audit log shows each one actually
// returns 7,024 output tokens, and 1536x1024 returns 5,488. At $30/1M image-out that is
// $0.211 and $0.165: the old figures were ~5x low.
// On 2026-10-05, 513 renders estimated at $19.10 actually cost about $100.
// Low and medium have no observed usage yet. They are the old figures scaled by the same 5.27x,
// a deliberate overestimate. Re-calibrate them from audit.log tokens_out once real renders exist.
export const PRICING = {
  'gpt-image-2': {
    low:    { '1024x1024': 0.032, '1024x1536': 0.026, '1536x1024': 0.026 },
    medium: { '1024x1024': 0.063, '1024x1536': 0.053, '1536x1024': 0.053 },
    high:   { '1024x1024': 0.211, '1024x1536': 0.165, '1536x1024': 0.165 },
  },
  'gpt-image-1.5': {
    low:    { '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.013 },
    medium: { '1024x1024': 0.034, '1024x1536': 0.050, '1536x1024': 0.050 },
    high:   { '1024x1024': 0.133, '1024x1536': 0.200, '1536x1024': 0.200 },
  },
  'gpt-image-1': {
    low:    { '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 },
    medium: { '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 },
    high:   { '1024x1024': 0.167, '1024x1536': 0.250, '1536x1024': 0.250 },
  },
  'gpt-image-1-mini': {
    low:    { '1024x1024': 0.005, '1024x1536': 0.006, '1536x1024': 0.006 },
    medium: { '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 },
    high:   { '1024x1024': 0.036, '1024x1536': 0.052, '1536x1024': 0.052 },
  },
};

// Per-1M-token rates (image in / image out / text in), for the usage line in the audit trail.
export const TOKEN_RATES = {
  'gpt-image-2':      { imageIn: 8,    imageOut: 30, textIn: 5 },
  'gpt-image-1.5':    { imageIn: 8,    imageOut: 32, textIn: 5 },
  'gpt-image-1':      { imageIn: 10,   imageOut: 40, textIn: 5 },
  'gpt-image-1-mini': { imageIn: 2.5,  imageOut: 8,  textIn: 2 },
};

// Each partial image streamed costs +100 output tokens.
export const PARTIAL_IMAGE_TOKEN_COST = 100;

// Rate limits, images per minute / tokens per minute, by usage tier (all GPT Image models).
export const RATE_LIMITS = {
  1: { ipm: 5,   tpm: 100_000 },
  2: { ipm: 20,  tpm: 250_000 },
  3: { ipm: 50,  tpm: 800_000 },
  4: { ipm: 150, tpm: 3_000_000 },
  5: { ipm: 250, tpm: 8_000_000 },
};
