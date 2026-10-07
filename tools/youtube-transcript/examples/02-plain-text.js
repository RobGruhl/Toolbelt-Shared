#!/usr/bin/env node

/**
 * 02 - Plain Text Transcript
 * Fetch transcript as a single string — useful for summarization, RAG, etc.
 */

import 'dotenv/config';
import { fetchTranscriptText, transcriptStats } from '../lib/transcript.js';

const videoId = process.argv[2] || 'dQw4w9WgXcQ';

const stats = await transcriptStats(videoId);
console.log(`Video stats: ${stats.words} words, ${stats.segments} segments, ${stats.duration} duration\n`);

const text = await fetchTranscriptText(videoId);
console.log('Full transcript:\n');
console.log(text);
