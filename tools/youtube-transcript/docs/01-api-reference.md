# YouTube Transcript API Reference

## How It Works

YouTube videos have captions (auto-generated or manually uploaded) served via an internal endpoint. The `@danielxceron/youtube-transcript` package extracts these by:

1. Fetching the video page HTML
2. Extracting the player response JSON (contains caption track metadata)
3. Fetching the captions XML from the track URL
4. Parsing XML into structured segments

**No API key required.** This uses YouTube's internal (undocumented) endpoints, not the official YouTube Data API v3.

## Segment Shape

```js
{
  text: string,      // Caption text for this segment
  offset: number,    // Start time in seconds (e.g., 18.8)
  duration: number,  // Duration in seconds (e.g., 7.16)
  lang: string       // Language code (e.g., 'en')
}
```

## Package API

### `YoutubeTranscript.fetchTranscript(videoId, config?)`

Primary method. Tries HTML scraping first, falls back to InnerTube API.

```js
import { YoutubeTranscript } from '@danielxceron/youtube-transcript';
const segments = await YoutubeTranscript.fetchTranscript('dQw4w9WgXcQ');
const segments = await YoutubeTranscript.fetchTranscript('dQw4w9WgXcQ', { lang: 'es' });
```

### `YoutubeTranscript.fetchTranscriptWithHtmlScraping(videoId, config?)`

Force HTML scraping only (no InnerTube fallback).

### `YoutubeTranscript.fetchTranscriptWithInnerTube(videoId, config?)`

Force InnerTube API only (no HTML scraping).

### `YoutubeTranscript.retrieveVideoId(input)`

Extract video ID from URL or validate bare ID.

## Input Formats

All methods accept:
- Bare ID: `dQw4w9WgXcQ`
- Watch URL: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
- Short URL: `https://youtu.be/dQw4w9WgXcQ`
- Embed URL: `https://www.youtube.com/embed/dQw4w9WgXcQ`
- Shorts URL: `https://www.youtube.com/shorts/dQw4w9WgXcQ`

## Error Types

- **TranscriptDisabledError** — Video has captions disabled
- **TranscriptNotAvailableError** — No captions in requested language
- **TranscriptNotAvailableLanguageError** — Language not available
- **VideoUnavailableError** — Video is private, deleted, or region-blocked
- **RequestBlockedError** — IP is blocked by YouTube (use proxy)
