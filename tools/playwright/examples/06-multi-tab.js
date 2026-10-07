#!/usr/bin/env node

/**
 * 06 — Multi-tab management
 * Open multiple tabs, switch between them, close specific tabs.
 */

import { open, tabNew, tabList, tabSelect, snapshot, tabClose, close } from '../lib/playwright.js';

const session = 'demo-tabs';

console.log('Opening first page...');
open('https://example.com', { session });

console.log('\nOpening second tab...');
tabNew('https://demo.playwright.dev/todomvc/', { session });

console.log('\nTab list:');
const tabs = tabList({ session });
console.log(tabs);

console.log('\nSwitching to tab 0 (example.com)...');
tabSelect(0, { session });

console.log('\nSnapshot of tab 0:');
const snap = snapshot({ session });
console.log(snap.substring(0, 300));

console.log('\nClosing tab 1...');
tabClose(1, { session });

console.log('\nClosing browser...');
close({ session });
console.log('Done.');
