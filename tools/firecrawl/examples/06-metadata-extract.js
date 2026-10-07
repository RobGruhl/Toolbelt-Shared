#!/usr/bin/env node

/**
 * 06 — Metadata extraction
 * Scrape a page and inspect all available metadata fields.
 */

import { scrape } from '../lib/firecrawl.js';

const url = 'https://example.com';
const { metadata } = await scrape(url);

console.log('Metadata fields:\n');

const fields = [
  'title', 'description', 'language', 'sourceURL', 'statusCode',
  'ogTitle', 'ogDescription', 'ogUrl', 'ogImage', 'ogSiteName',
  'keywords', 'robots',
];

fields.forEach(field => {
  const value = metadata[field];
  if (value !== undefined && value !== null) {
    console.log(`  ${field}: ${value}`);
  }
});

// Show any extra fields not in the standard list
const extraFields = Object.keys(metadata).filter(k => !fields.includes(k));
if (extraFields.length > 0) {
  console.log('\nAdditional fields:');
  extraFields.forEach(field => {
    console.log(`  ${field}: ${JSON.stringify(metadata[field]).substring(0, 100)}`);
  });
}
