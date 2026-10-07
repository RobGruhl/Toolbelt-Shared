/**
 * YouTube Transcript Client
 * Fetches structured captions from YouTube videos — no API key needed.
 * Uses YouTube's internal captions endpoint via @danielxceron/youtube-transcript.
 *
 * Each segment: { text, offset (seconds), duration (seconds), lang }
 */

import { YoutubeTranscript } from '@danielxceron/youtube-transcript';

/**
 * Extract video ID from various YouTube URL formats or bare ID
 */
export function extractVideoId(input) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }

  throw new Error(`Could not extract video ID from: ${input}`);
}

/**
 * Fetch transcript segments for a YouTube video
 *
 * @param {string} videoIdOrUrl - YouTube video ID or URL
 * @param {object} options
 * @param {string} options.lang - Language code (default: 'en')
 * @returns {Array<{text: string, offset: number, duration: number, lang: string}>}
 */
export async function fetchTranscript(videoIdOrUrl, options = {}) {
  const videoId = extractVideoId(videoIdOrUrl);
  const config = {};
  if (options.lang) config.lang = options.lang;

  const segments = await YoutubeTranscript.fetchTranscript(videoId, config);
  return segments;
}

/**
 * Fetch transcript as plain text (segments joined with spaces)
 *
 * @param {string} videoIdOrUrl - YouTube video ID or URL
 * @param {object} options
 * @param {string} options.lang - Language code (default: 'en')
 * @returns {string}
 */
export async function fetchTranscriptText(videoIdOrUrl, options = {}) {
  const segments = await fetchTranscript(videoIdOrUrl, options);
  return segments.map(s => s.text).join(' ');
}

/**
 * Fetch transcript with timestamps formatted as SRT-style timecodes
 *
 * @param {string} videoIdOrUrl - YouTube video ID or URL
 * @param {object} options
 * @returns {Array<{time: string, text: string, offsetSeconds: number}>}
 */
export async function fetchTimestamped(videoIdOrUrl, options = {}) {
  const segments = await fetchTranscript(videoIdOrUrl, options);
  return segments.map(s => ({
    time: formatTime(s.offset),
    text: s.text,
    offsetSeconds: s.offset,
  }));
}

/**
 * Search transcript for a term, returning matching segments with context
 *
 * @param {string} videoIdOrUrl - YouTube video ID or URL
 * @param {string} query - Search term (case-insensitive)
 * @param {object} options
 * @param {number} options.contextSegments - Segments before/after match (default: 1)
 * @returns {Array<{match: object, context: object[]}>}
 */
export async function searchTranscript(videoIdOrUrl, query, options = {}) {
  const segments = await fetchTranscript(videoIdOrUrl, options);
  const contextSize = options.contextSegments ?? 1;
  const regex = new RegExp(query, 'i');
  const matches = [];

  for (let i = 0; i < segments.length; i++) {
    if (regex.test(segments[i].text)) {
      const start = Math.max(0, i - contextSize);
      const end = Math.min(segments.length, i + contextSize + 1);
      matches.push({
        match: { ...segments[i], time: formatTime(segments[i].offset) },
        context: segments.slice(start, end).map(s => ({
          ...s,
          time: formatTime(s.offset),
        })),
      });
    }
  }

  return matches;
}

/**
 * Get transcript stats: word count, duration, segment count
 */
export async function transcriptStats(videoIdOrUrl, options = {}) {
  const segments = await fetchTranscript(videoIdOrUrl, options);
  const text = segments.map(s => s.text).join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  const lastSeg = segments[segments.length - 1];
  const totalDuration = lastSeg ? lastSeg.offset + lastSeg.duration : 0;

  return {
    segments: segments.length,
    words,
    duration: formatTime(totalDuration),
    durationSeconds: Math.round(totalDuration),
    lang: segments[0]?.lang || 'unknown',
  };
}

/**
 * Format seconds as MM:SS or HH:MM:SS
 */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
