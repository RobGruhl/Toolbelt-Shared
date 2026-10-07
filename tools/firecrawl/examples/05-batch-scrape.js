#!/usr/bin/env node

/**
 * 05 — Batch scrape
 * Scrape multiple URLs with a delay between requests.
 */

import { batchScrape } from '../lib/firecrawl.js';

const urls = [
  'https://example.com',
  'https://httpbin.org/html',
];

console.log(`Scraping ${urls.length} URLs...\n`);

const results = await batchScrape(urls, { delay: 1500 });

results.forEach((r, i) => {
  const status = r.error ? `ERROR: ${r.error}` : `OK (${r.metadata?.statusCode})`;
  console.log(`[${i + 1}] ${r.url}`);
  console.log(`    Status: ${status}`);
  console.log(`    Content: ${r.markdown?.substring(0, 150) ?? 'none'}...`);
  console.log();
});

console.log(`${results.filter(r => !r.error).length}/${urls.length} successful`);
