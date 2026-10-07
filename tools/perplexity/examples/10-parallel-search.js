#!/usr/bin/env node

/**
 * 10 — Parallel search
 * Run multiple searches concurrently for comprehensive research.
 * Pattern from no-spoiler-cycling's searchRaceComprehensive.
 */

import 'dotenv/config';
import { search } from '../lib/perplexity.js';

const topic = 'electric vehicles';
const queries = [
  `${topic} market share 2026 by manufacturer`,
  `${topic} battery technology breakthroughs 2026`,
  `${topic} charging infrastructure growth 2026`,
];

console.log(`Running ${queries.length} parallel searches...\n`);
const start = Date.now();

const results = await Promise.all(
  queries.map(q => search(q, { maxResults: 5, recency: 'month' }))
);

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`All ${queries.length} searches completed in ${elapsed}s\n`);

results.forEach((result, i) => {
  console.log(`--- Query ${i + 1}: "${queries[i].substring(0, 50)}..." ---`);
  console.log(`Results: ${result.results.length}`);
  result.results.slice(0, 2).forEach(r => console.log(`  ${r.title} (${r.url})`));
  console.log();
});
