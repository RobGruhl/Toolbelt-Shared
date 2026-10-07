#!/usr/bin/env node

/**
 * 04 — Chat Completions API
 * Model-specific, token-priced. Supports system prompts, search modes.
 * This is the OpenAI-compatible endpoint.
 */

import 'dotenv/config';
import { chat } from '../lib/perplexity.js';
import { MODELS } from '../lib/constants.js';

// Basic chat with sonar-pro (default)
console.log('=== sonar-pro (default) ===\n');
const result = await chat('What are the key differences between Rust and Go for backend development?');
console.log('Answer:', result.answer.substring(0, 500), '...');
console.log('\nCitations:', result.citations);

// With system prompt
console.log('\n=== With system prompt ===\n');
const withSystem = await chat('Explain quantum entanglement', {
  systemPrompt: 'You are a physics teacher explaining to a high school student. Use simple analogies.',
  model: MODELS.SONAR,  // cheaper model for simpler queries
});
console.log('Answer:', withSystem.answer.substring(0, 500), '...');

// Academic search mode
console.log('\n=== Academic search mode ===\n');
const academic = await chat('Recent advances in CRISPR gene therapy 2025-2026', {
  searchMode: 'academic',
});
console.log('Answer:', academic.answer.substring(0, 500), '...');
console.log('\nCitations:', academic.citations);
