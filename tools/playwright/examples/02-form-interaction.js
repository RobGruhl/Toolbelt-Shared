#!/usr/bin/env node

/**
 * 02 — Form interaction
 * Navigate to a form, fill fields, click submit, verify result.
 * Uses the TodoMVC demo app as a test target.
 */

import { open, type, press, snapshot, close } from '../lib/playwright.js';

const session = 'demo-form';

console.log('Opening TodoMVC...');
open('https://demo.playwright.dev/todomvc/', { session });

console.log('\nAdding first todo...');
type('Buy groceries', { session });
press('Enter', { session });

console.log('Adding second todo...');
type('Water the plants', { session });
press('Enter', { session });

console.log('Adding third todo...');
type('Read a book', { session });
press('Enter', { session });

console.log('\nPage snapshot after adding todos:');
const snap = snapshot({ session });
console.log(snap);

console.log('\nClosing browser...');
close({ session });
console.log('Done.');
