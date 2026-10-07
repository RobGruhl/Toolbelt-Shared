#!/usr/bin/env node

/**
 * 05 — Network mocking
 * Intercept network requests and return mock responses.
 * Useful for testing without hitting real APIs.
 */

import { open, route, routeList, unroute, snapshot, close } from '../lib/playwright.js';

const session = 'demo-mock';

console.log('Opening browser...');
open('https://example.com', { session });

console.log('\nSetting up route mock for a JSON API...');
route('**/api/data', {
  body: JSON.stringify({ message: 'mocked response', count: 42 }),
  status: '200',
  contentType: 'application/json',
}, { session });

console.log('\nListing active routes:');
const routes = routeList({ session });
console.log(routes);

console.log('\nRemoving route...');
unroute('**/api/data', { session });

console.log('\nClosing browser...');
close({ session });
console.log('Done.');
