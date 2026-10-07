#!/usr/bin/env node

/**
 * 02 — Basic scrape
 * Scrape a single URL, print the first 500 chars of markdown.
 */

import { scrape } from '../lib/firecrawl.js';

const url = 'https://example.com';
const { markdown, metadata } = await scrape(url);

console.log(`Title: ${metadata.title}`);
console.log(`Status: ${metadata.statusCode}`);
console.log(`Source: ${metadata.sourceURL}\n`);

console.log('--- Markdown (first 500 chars) ---');
console.log(markdown?.substring(0, 500));
