#!/usr/bin/env node

/**
 * 01 — Basic Search API call
 * Simplest possible Perplexity query. Flat-rate endpoint, no model selection.
 *
 * The Search API returns raw search results (title, url, snippet) — not a
 * synthesized answer. For answers, use the Chat Completions API (example 04).
 */

import 'dotenv/config';
import { search } from '../lib/perplexity.js';

const { results, citations } = await search(
  'What is the current population of Tokyo?'
);

console.log(`${results.length} result(s) returned\n`);

results.slice(0, 3).forEach((r, i) => {
  console.log(`[${i + 1}] ${r.title}`);
  console.log(`    ${r.url}`);
  console.log(`    ${r.snippet?.substring(0, 150)}...`);
  console.log();
});

console.log('Citations:', citations.slice(0, 3));
