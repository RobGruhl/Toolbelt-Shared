#!/usr/bin/env node

/**
 * 01 — Basic search
 * Simplest Firecrawl search. Returns URLs with title and description.
 */

import { search } from '../lib/firecrawl.js';

const { results } = await search('what is web scraping');

console.log(`${results.length} result(s)\n`);

results.forEach((r, i) => {
  console.log(`[${i + 1}] ${r.title}`);
  console.log(`    ${r.url}`);
  console.log(`    ${r.description?.substring(0, 150)}`);
  console.log();
});
