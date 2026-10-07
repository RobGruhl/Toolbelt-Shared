#!/usr/bin/env node

/**
 * 03 — Date filtering
 * Restrict results by publication date or recency.
 * Key for spoiler safety, freshness control, and historical research.
 */

import 'dotenv/config';
import { search } from '../lib/perplexity.js';

// Recency filter: only results from the past week
console.log('=== Recency: past week ===\n');
const recent = await search('AI news this week', {
  recency: 'week',
  maxResults: 5,
});
console.log(`${recent.results.length} results from the past week:`);
recent.results.forEach(r => console.log(`  [${r.date}] ${r.title}`));

// Date range: results published between specific dates (ISO format)
console.log('\n=== Date range: Jan 2026 only ===\n');
const dateRange = await search('tech industry layoffs', {
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  maxResults: 5,
});
console.log(`${dateRange.results.length} results from Jan 2026:`);
dateRange.results.forEach(r => console.log(`  [${r.date}] ${r.title}`));

// Spoiler-safety pattern: only content published BEFORE an event
console.log('\n=== Spoiler safety: pre-event content only ===\n');
const preEvent = await search('2025 Tour de France stage 15 preview', {
  endDate: '2025-07-13',  // day before the stage
  allowDomains: ['cyclingnews.com', 'velonews.com'],
  maxResults: 5,
});
console.log(`${preEvent.results.length} pre-event results:`);
preEvent.results.forEach(r => console.log(`  [${r.date}] ${r.title}`));
