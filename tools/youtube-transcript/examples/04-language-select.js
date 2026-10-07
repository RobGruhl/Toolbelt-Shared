#!/usr/bin/env node

/**
 * 04 - Language Selection
 * Fetch transcript in a specific language. Falls back to available language if requested not found.
 */

import 'dotenv/config';
import { fetchTranscript } from '../lib/transcript.js';

const videoId = process.argv[2] || 'dQw4w9WgXcQ';
const lang = process.argv[3] || 'en';

console.log(`Fetching ${lang} transcript for: ${videoId}\n`);

try {
  const segments = await fetchTranscript(videoId, { lang });
  console.log(`Got ${segments.length} segments (lang: ${segments[0]?.lang || 'unknown'})\n`);

  for (const seg of segments.slice(0, 15)) {
    const time = `${Math.floor(seg.offset / 60)}:${String(Math.floor(seg.offset % 60)).padStart(2, '0')}`;
    console.log(`  [${time}] ${seg.text}`);
  }

  if (segments.length > 15) {
    console.log(`  ... and ${segments.length - 15} more segments`);
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  console.log('\nTip: Not all videos have captions in every language.');
  console.log('Try without a language arg to get the default transcript.');
}
