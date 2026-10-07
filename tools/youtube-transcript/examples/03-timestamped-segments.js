#!/usr/bin/env node

/**
 * 03 - Timestamped Segments
 * Fetch transcript with human-readable timestamps (MM:SS format).
 */

import 'dotenv/config';
import { fetchTimestamped } from '../lib/transcript.js';

const videoId = process.argv[2] || 'dQw4w9WgXcQ';

console.log(`Fetching timestamped transcript for: ${videoId}\n`);

const segments = await fetchTimestamped(videoId);

for (const seg of segments) {
  console.log(`[${seg.time}] ${seg.text}`);
}
