#!/usr/bin/env node

/**
 * 06 — Reasoning (Chain of Thought)
 * Uses sonar-reasoning-pro for step-by-step analysis grounded in search.
 * Good for complex comparisons, logical problems, recommendations.
 */

import 'dotenv/config';
import { reason } from '../lib/perplexity.js';

console.log('Reasoning with search grounding...\n');

const { answer, citations, raw } = await reason(
  'I need to choose between PostgreSQL and MongoDB for a new project that handles ' +
  'mixed structured and semi-structured data, needs ACID transactions, and will scale ' +
  'to ~100M records. What should I choose and why?',
  { reasoningEffort: 'high' }
);

console.log('Answer:', answer);
console.log(`\n${citations.length} citations:`);
citations.forEach((url, i) => console.log(`  [${i + 1}] ${url}`));

// Reasoning tokens are tracked in usage
if (raw.usage) {
  console.log('\nUsage:', {
    prompt: raw.usage.prompt_tokens,
    completion: raw.usage.completion_tokens,
    reasoning: raw.usage.reasoning_tokens,
  });
}
