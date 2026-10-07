#!/usr/bin/env node

/**
 * 09 — OpenAI SDK compatibility
 * Perplexity's Chat Completions endpoint is OpenAI-compatible.
 * You can use the OpenAI SDK with a base URL swap.
 *
 * Requires: bun install openai  (not included in project deps)
 */

import 'dotenv/config';

let OpenAI;
try {
  ({ default: OpenAI } = await import('openai'));
} catch {
  console.log('This example requires the openai package.');
  console.log('Install with: bun install openai');
  process.exit(0);
}

const client = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: 'https://api.perplexity.ai',
});

const response = await client.chat.completions.create({
  model: 'sonar-pro',
  messages: [
    { role: 'user', content: 'What is the latest stable version of Node.js?' },
  ],
});

console.log('Answer:', response.choices[0].message.content);
console.log('\nCitations:', response.citations);
console.log('\nUsage:', response.usage);
