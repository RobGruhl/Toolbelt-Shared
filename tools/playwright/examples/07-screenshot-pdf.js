#!/usr/bin/env node

/**
 * 07 — Screenshots and PDFs
 * Capture full-page screenshots and save pages as PDF.
 * Demonstrates the save-as commands.
 */

import { open, screenshot, pdf, close } from '../lib/playwright.js';

const session = 'demo-capture';

console.log('Opening playwright.dev...');
open('https://playwright.dev', { session });

console.log('\nTaking screenshot...');
const ssResult = screenshot(undefined, {
  session,
  filename: 'playwright-homepage.png',
});
console.log(ssResult);

console.log('\nSaving as PDF...');
const pdfResult = pdf({
  session,
  filename: 'playwright-homepage.pdf',
});
console.log(pdfResult);

console.log('\nClosing browser...');
close({ session });
console.log('Done. Check output/ directory for files.');
