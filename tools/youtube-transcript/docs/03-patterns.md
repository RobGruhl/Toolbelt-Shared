# Patterns and Best Practices

## Rate Limiting

YouTube blocks IPs that make too many requests. Mitigations:

1. **Add delays between requests** — 1-3 seconds minimum for batch operations
2. **Run locally** — cloud provider IPs (AWS, GCP, Azure) are often pre-blocked
3. **Use rotating proxies** — residential proxies (e.g., Webshare) for heavy use
4. **Cache transcripts** — store fetched transcripts locally, avoid re-fetching

## Plain Text for LLMs

The most common pattern: fetch transcript as plain text for summarization, RAG, or Q&A.

```js
const text = await fetchTranscriptText(videoId);
// Pass to LLM: "Summarize this video transcript: " + text
```

Word counts vary: a 10-minute video typically has 1,500-2,000 words.

## Temporal Search

Search for when a topic is mentioned — useful for:
- Finding the timestamp where a person/concept is discussed
- Spoiler detection (when is a result revealed?)
- Skipping to relevant sections

```js
const matches = await searchTranscript(videoId, 'machine learning');
// Each match includes timestamp and surrounding context
```

## Export Formats

### SRT (SubRip)
Standard subtitle format. See example 07.

### Plain text
Just the words, no timestamps. See `fetchTranscriptText()`.

### Timestamped segments
Human-readable `[MM:SS] text` format. See `fetchTimestamped()`.

## Batch Processing

When fetching multiple video transcripts:

```js
const DELAY = 1500; // ms between requests
for (const id of videoIds) {
  const transcript = await fetchTranscript(id);
  // process...
  await new Promise(r => setTimeout(r, DELAY));
}
```

## Error Handling

Always wrap transcript fetches in try/catch — many videos lack captions:

```js
try {
  const segments = await fetchTranscript(videoId);
} catch (err) {
  if (err.message.includes('disabled')) {
    // Captions disabled on this video
  } else if (err.message.includes('blocked')) {
    // IP blocked — need proxy
  }
}
```

## Firecrawl vs Transcript Library

| Factor | Firecrawl scraping | This library |
|--------|-------------------|--------------|
| Data format | Markdown blob (transcript mixed with other content) | Structured array with timestamps |
| Speed | 2-5s (full page render) | <1s (single HTTP request) |
| Cost | 1 credit per page | Free |
| Timestamps | Not structured | Precise (offset + duration per segment) |
| Use case | When you also need page metadata | When you just need the transcript |

**Recommendation:** Use this library for transcript extraction. Use Firecrawl when you need the full page content (description, comments, metadata) in addition to the transcript.
