#!/usr/bin/env node

/**
 * 01 — Basic navigation
 * Open a URL, take a screenshot. Simplest possible playwright-cli usage.
 */

import { open, screenshot, close } from '../lib/playwright.js';

const session = 'demo-nav';

console.log('Opening example.com...');
const openResult = open('https://example.com', { session });
console.log(openResult);

console.log('\nTaking screenshot...');
const ssResult = screenshot(undefined, {
  session,
  filename: 'example-homepage.png',
});
console.log(ssResult);

console.log('\nClosing browser...');
close({ session });
console.log('Done.');
