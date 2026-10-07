#!/usr/bin/env node

/**
 * 04 — Snapshots and element refs
 * Take a snapshot to get the accessibility tree with element refs,
 * then use those refs to interact with specific elements.
 *
 * Snapshot refs (like e1, e2, e35) are the primary way to target
 * elements in playwright-cli. Always snapshot before clicking/filling.
 */

import { open, snapshot, click, type, press, check, close } from '../lib/playwright.js';

const session = 'demo-refs';

console.log('Opening TodoMVC...');
open('https://demo.playwright.dev/todomvc/', { session });

// Add some items first
type('First task', { session });
press('Enter', { session });
type('Second task', { session });
press('Enter', { session });

console.log('\nTaking snapshot to get element refs...');
const snap = snapshot({ session });
console.log(snap);

console.log('\nThe snapshot shows element refs like e1, e2, etc.');
console.log('Use these refs with click(), fill(), check(), etc.');
console.log('Example: check("e21") to check a todo item checkbox.');

console.log('\nClosing browser...');
close({ session });
console.log('Done.');
