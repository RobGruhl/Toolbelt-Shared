#!/usr/bin/env node

/**
 * 01 - Basic Transcript Fetch
 * Fetch the transcript of a YouTube video and print the first 10 segments.
 */

import 'dotenv/config';
import { fetchTranscript } from '../lib/transcript.js';

const videoId = process.argv[2] || 'dQw4w9WgXcQ';

console.log(`Fetching transcript for: ${videoId}\n`);

const segments = await fetchTranscript(videoId);

console.log(`Got ${segments.length} segments\n`);
console.log('First 10 segments:');
for (const seg of segments.slice(0, 10)) {
  const time = `${Math.floor(seg.offset / 60)}:${String(Math.floor(seg.offset % 60)).padStart(2, '0')}`;
  console.log(`  [${time}] ${seg.text}`);
}
