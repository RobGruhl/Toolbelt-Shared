/**
 * Perplexity API constants
 *
 * Two distinct APIs:
 *   /search          — flat-rate web search ($5/1K requests, no token costs)
 *   /chat/completions — model-specific chat with search grounding (token-priced)
 */

import { homedir } from 'node:os';
import path from 'node:path';

export const BASE_URL = 'https://api.perplexity.ai';

// 600-mode key file outside the tree; $PERPLEXITY_API_KEY wins when set.
export const KEY_FILE = path.join(homedir(), '.config', 'toolbelt', 'perplexity.key');

// -- Endpoints --

export const ENDPOINTS = {
  SEARCH: '/search',
  CHAT: '/chat/completions',
  AGENT: '/v1/agent',  // Agent API — third-party frontier models + web search (OpenAI /v1/responses-compatible)
};

// -- Agent API models (third-party frontier models, accessed at direct provider rates) --
// Verified against https://docs.perplexity.ai/docs/agent-api/models
export const AGENT_MODELS = {
  CLAUDE_SONNET: 'anthropic/claude-sonnet-4-6',  // balanced — the default here
  CLAUDE_OPUS: 'anthropic/claude-opus-4-8',      // highest reasoning
  CLAUDE_HAIKU: 'anthropic/claude-haiku-4-5',    // fastest/cheapest
};

// -- Models (Chat Completions only — Search has no model parameter) --

export const MODELS = {
  SONAR: 'sonar',                           // Lightweight, cost-effective search
  SONAR_PRO: 'sonar-pro',                   // Advanced multi-step search synthesis
  SONAR_REASONING_PRO: 'sonar-reasoning-pro', // Chain-of-thought reasoning with search
  SONAR_DEEP_RESEARCH: 'sonar-deep-research', // Exhaustive multi-source research reports
};

// -- Defaults --

export const DEFAULTS = {
  // Search API
  SEARCH_MAX_RESULTS: 10,
  SEARCH_MAX_TOKENS: 10000,
  SEARCH_MAX_TOKENS_PER_PAGE: 4096,

  // Chat Completions API
  CHAT_MODEL: MODELS.SONAR_PRO,
  CHAT_TIMEOUT_MS: 30_000,
  DEEP_RESEARCH_TIMEOUT_MS: 360_000,  // 6 minutes — deep research is slow
  REASONING_TIMEOUT_MS: 60_000,

  // Agent API (Claude Sonnet + web search by default)
  AGENT_MODEL: AGENT_MODELS.CLAUDE_SONNET,
  AGENT_TIMEOUT_MS: 120_000,  // 2 min — frontier model + live search can be slow
  AGENT_MAX_OUTPUT_TOKENS: 2048,  // always sent; the answer length is the unbounded term in the price
  CHAT_MAX_TOKENS: 2048,
};

// -- Ceilings (SENSIBILITIES #3) --
// Code constants, never flags. A value above one is refused, not lowered. Raising one is a
// reviewed diff. Worst case per call at these ceilings: search ≈ $0.005; agent on Sonnet
// ≈ $0.07 (4096 out × $15/M + search); agent on Opus ≈ $0.11; chat on sonar-pro ≈ $0.07.
export const CEILINGS = {
  SEARCH_MAX_RESULTS: 20,          // Perplexity's own maximum for max_results
  SEARCH_MAX_QUERIES: 5,           // batch queries per /search call (API maximum)
  SEARCH_MAX_TOKENS: 20_000,       // total content tokens returned by /search
  AGENT_MAX_OUTPUT_TOKENS: 4096,
  CHAT_MAX_TOKENS: 4096,
};

// -- Recency filters --

export const RECENCY = {
  HOUR: 'hour',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
};

// -- Search modes (Chat Completions only) --

export const SEARCH_MODES = {
  WEB: 'web',
  ACADEMIC: 'academic',
  SEC: 'sec',
};

// -- Pricing reference (not used in code, here for docs) --

export const PRICING = {
  SEARCH_API: { per_1k_requests: 5.00 },
  SONAR: { input_per_1m: 1, output_per_1m: 1 },
  SONAR_PRO: { input_per_1m: 3, output_per_1m: 15 },
  SONAR_REASONING_PRO: { input_per_1m: 2, output_per_1m: 8 },
  SONAR_DEEP_RESEARCH: { input_per_1m: 2, output_per_1m: 8, citation_per_1m: 2, reasoning_per_1m: 3 },
  // Agent API — direct provider rates, no markup; plus web_search tool cost per call
  AGENT_CLAUDE_SONNET: { input_per_1m: 3, output_per_1m: 15, cache_per_1m: 0.30 },
  AGENT_CLAUDE_OPUS: { input_per_1m: 5, output_per_1m: 25, cache_per_1m: 0.50 },
  AGENT_CLAUDE_HAIKU: { input_per_1m: 1, output_per_1m: 5, cache_per_1m: 0.10 },
};
