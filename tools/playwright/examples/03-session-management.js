#!/usr/bin/env node

/**
 * 03 — Session management
 * Demonstrates named sessions for isolating browser instances.
 * Two sessions run independently with different URLs.
 */

import { open, snapshot, list, close, closeAll } from '../lib/playwright.js';

console.log('Opening two separate sessions...');

open('https://example.com', { session: 'session-a' });
console.log('Session A: opened example.com');

open('https://demo.playwright.dev/todomvc/', { session: 'session-b' });
console.log('Session B: opened TodoMVC');

console.log('\nListing all sessions:');
const sessions = list();
console.log(sessions);

console.log('\nSnapshot from session A:');
const snapA = snapshot({ session: 'session-a' });
console.log(snapA.substring(0, 500));

console.log('\nSnapshot from session B:');
const snapB = snapshot({ session: 'session-b' });
console.log(snapB.substring(0, 500));

console.log('\nClosing all sessions...');
closeAll();
console.log('Done.');
