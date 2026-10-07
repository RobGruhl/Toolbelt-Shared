#!/usr/bin/env node

/**
 * 11 — Agent API with Claude Sonnet 4.6
 * Claude-quality reasoning WITH Perplexity's live web-search grounding + citations.
 * This is the third-party-model path (NOT a Perplexity Sonar model).
 *
 * Endpoint: POST /v1/agent  ·  Model: anthropic/claude-sonnet-4-6 (default)
 * Pricing: $3/M in, $15/M out (direct provider rate) + ~$0.005 per web search.
 */

import 'dotenv/config';
import { agent } from '../lib/perplexity.js';

const { answer, citations, results, usage } = await agent(
  'What changed in the most recent LANCER rules errata? Be specific.',
  {
    // model: 'anthropic/claude-sonnet-4-6',  // default; or CLAUDE_OPUS / CLAUDE_HAIKU
    instructions: 'Use web_search for anything that may have changed recently. Cite sources.',
  }
);

console.log('ANSWER:\n', answer, '\n');
console.log(`SOURCES (${results.length}):`);
citations.slice(0, 5).forEach((u, i) => console.log(`  [${i + 1}] ${u}`));
console.log('\nCOST: $' + (usage?.cost?.total_cost ?? '?'), `(${usage?.total_tokens ?? '?'} tokens)`);
