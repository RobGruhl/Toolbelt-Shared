#!/usr/bin/env node

/**
 * 07 - Export as SRT
 * Fetch transcript and write as .srt subtitle file.
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { fetchTranscript } from '../lib/transcript.js';

const videoId = process.argv[2] || 'dQw4w9WgXcQ';
const outFile = process.argv[3] || `output/${videoId}.srt`;

console.log(`Fetching transcript for: ${videoId}`);

const segments = await fetchTranscript(videoId);

function toSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

const srt = segments.map((seg, i) => {
  const start = toSrtTime(seg.offset);
  const end = toSrtTime(seg.offset + seg.duration);
  return `${i + 1}\n${start} --> ${end}\n${seg.text}\n`;
}).join('\n');

writeFileSync(outFile, srt, 'utf-8');
console.log(`Wrote ${segments.length} segments to ${outFile}`);
