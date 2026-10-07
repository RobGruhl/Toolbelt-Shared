#!/usr/bin/env node

/**
 * 08 — Authentication flow with persistent state
 * Demonstrates logging in, saving storage state, and restoring it.
 * State persists only via state-save files under output/ (a credential) or an hp launch-debug profile.
 *
 * This example uses a generic flow. Replace the URL and selectors
 * with your actual login page.
 */

import { open, snapshot, fill, click, stateSave, stateLoad, close } from '../lib/playwright.js';

const session = 'demo-auth';
const stateFile = 'auth-state.json';

console.log('=== Auth Flow Demo ===');
console.log('This example shows the pattern for login + state persistence.\n');

// Step 1: Open with persistent profile
console.log('1. Opening browser (isolated profile)...');
open('https://example.com', { session, headed: false });

// Step 2: Take snapshot to see the page
console.log('2. Taking snapshot to identify form elements...');
const snap = snapshot({ session });
console.log(snap.substring(0, 500));

// Step 3: Save state (would contain cookies after login)
console.log('\n3. Saving storage state...');
const saveResult = stateSave(stateFile, { session });
console.log(saveResult);

console.log('\n4. In a real flow, you would:');
console.log('   - snapshot() to find login form refs');
console.log('   - fill(ref, "username") + fill(ref, "password")');
console.log('   - click(ref) on the submit button');
console.log('   - stateSave("auth-state.json") to persist cookies');
console.log('   - stateLoad("auth-state.json") in future sessions');

console.log('\nClosing browser...');
close({ session });
console.log('Done.');
