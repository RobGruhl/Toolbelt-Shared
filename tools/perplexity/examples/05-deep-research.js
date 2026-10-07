#!/usr/bin/env node

/**
 * 05 — Deep Research
 * Uses sonar-deep-research model with a 6-minute timeout.
 * Conducts exhaustive multi-source investigation. Takes 1-5 minutes.
 * Use for thorough reports, not quick questions.
 */

import 'dotenv/config';
import { deepResearch } from '../lib/perplexity.js';

console.log('Starting deep research (this takes 1-5 minutes)...\n');
const start = Date.now();

const { answer, citations } = await deepResearch(
  'Compare the current state of nuclear fusion energy projects worldwide. ' +
  'Cover ITER, Commonwealth Fusion Systems, TAE Technologies, and any Chinese programs. ' +
  'Include funding levels, projected timelines, and technical approaches.'
);

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`Completed in ${elapsed}s\n`);
console.log('Answer:', answer);
console.log(`\n${citations.length} citations:`);
citations.forEach((url, i) => console.log(`  [${i + 1}] ${url}`));
