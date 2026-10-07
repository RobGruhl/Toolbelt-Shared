#!/usr/bin/env node

/**
 * 05 - Batch Transcript Fetch
 * Fetch transcripts for multiple videos with delay to avoid rate limits.
 */

import 'dotenv/config';
import { fetchTranscriptText, transcriptStats } from '../lib/transcript.js';

const videos = [
  { id: 'dQw4w9WgXcQ', label: 'Rick Astley - Never Gonna Give You Up' },
  { id: 'jNQXAC9IVRw', label: 'Me at the zoo (first YouTube video)' },
  { id: '9bZkp7q19f0', label: 'PSY - Gangnam Style' },
];

const DELAY_MS = 1500;

console.log(`Fetching transcripts for ${videos.length} videos\n`);

for (let i = 0; i < videos.length; i++) {
  const { id, label } = videos[i];
  console.log(`[${i + 1}/${videos.length}] ${label} (${id})`);

  try {
    const stats = await transcriptStats(id);
    console.log(`  ${stats.words} words, ${stats.segments} segments, ${stats.duration}`);
  } catch (err) {
    console.log(`  Failed: ${err.message}`);
  }

  if (i < videos.length - 1) {
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
}

console.log('\nDone.');
