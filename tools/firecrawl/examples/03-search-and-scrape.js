#!/usr/bin/env node

/**
 * 03 — Search and scrape (two-stage discovery)
 * The canonical Firecrawl pattern: search for URLs, then scrape top results.
 */

import { searchAndScrape } from '../lib/firecrawl.js';

const results = await searchAndScrape('firecrawl web scraping API', {
  searchLimit: 3,
  delay: 1000,
});

console.log(`${results.length} page(s) scraped\n`);

results.forEach((r, i) => {
  console.log(`[${i + 1}] ${r.title}`);
  console.log(`    ${r.url}`);
  console.log(`    ${r.markdown?.substring(0, 200)}...`);
  console.log();
});
