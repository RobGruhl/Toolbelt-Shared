#!/usr/bin/env node

/**
 * 04 — Domain-scoped search
 * Use the site: operator to restrict search to a specific domain.
 */

import { search } from '../lib/firecrawl.js';

const domain = 'github.com';
const query = `site:${domain} firecrawl`;

const { results } = await search(query, { limit: 5 });

console.log(`Results from ${domain}:\n`);

results.forEach((r, i) => {
  console.log(`[${i + 1}] ${r.title}`);
  console.log(`    ${r.url}`);
  console.log(`    ${r.description?.substring(0, 150)}`);
  console.log();
});
