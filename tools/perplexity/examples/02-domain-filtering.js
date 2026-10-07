#!/usr/bin/env node

/**
 * 02 — Domain filtering
 * Allow-list and block-list domains to control source quality.
 * Perplexity merges them into a single array (blocked prefixed with "-").
 */

import 'dotenv/config';
import { search } from '../lib/perplexity.js';

// Allow-list: only these domains
console.log('=== Allow-list: official cycling sources ===\n');
const allowed = await search('2026 Tour de France route preview', {
  allowDomains: ['cyclingnews.com', 'velonews.com', 'letour.fr'],
  maxResults: 5,
});
console.log(`${allowed.results.length} results from allowed domains:`);
allowed.results.forEach(r => console.log(`  ${r.url}`));

// Block-list: exclude noisy domains
console.log('\n=== Block-list: exclude forums ===\n');
const blocked = await search('best mechanical keyboard 2026', {
  blockDomains: ['reddit.com', 'quora.com', 'pinterest.com'],
  maxResults: 5,
});
console.log(`${blocked.results.length} results (forums excluded):`);
blocked.results.forEach(r => console.log(`  ${r.url}`));

// Combined: allow some, block others
console.log('\n=== Combined: allow news + block tabloids ===\n');
const combined = await search('latest space exploration news', {
  allowDomains: ['nasa.gov', 'spacex.com', 'arstechnica.com'],
  blockDomains: ['dailymail.co.uk'],
  maxResults: 5,
});
console.log(`${combined.results.length} results:`);
combined.results.forEach(r => console.log(`  ${r.url}`));
