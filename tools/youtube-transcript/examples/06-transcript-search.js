#!/usr/bin/env node

/**
 * 06 - Transcript Search
 * Search for a term within a video's transcript, with surrounding context.
 * Useful for finding when a topic is mentioned.
 */

import 'dotenv/config';
import { searchTranscript } from '../lib/transcript.js';

const videoId = process.argv[2] || 'dQw4w9WgXcQ';
const query = process.argv[3] || 'give you up';

console.log(`Searching "${query}" in transcript of: ${videoId}\n`);

const matches = await searchTranscript(videoId, query, { contextSegments: 1 });

if (matches.length === 0) {
  console.log('No matches found.');
} else {
  console.log(`Found ${matches.length} match(es):\n`);

  for (const { match, context } of matches) {
    console.log(`--- Match at ${match.time} ---`);
    for (const seg of context) {
      const marker = seg.offset === match.offset ? '>>>' : '   ';
      console.log(`${marker} [${seg.time}] ${seg.text}`);
    }
    console.log();
  }
}
