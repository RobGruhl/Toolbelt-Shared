# YouTube Captions System

## Two Types of Captions

### Auto-Generated (ASR)

YouTube automatically generates captions using speech recognition for most uploaded videos.

- Accuracy: ~60-70% (varies with audio quality, accent, background noise)
- Available in limited languages
- **Not** indexed by Google/YouTube for search/SEO
- May have overlapping/duplicate text segments (progressive display)
- Not available for: very long videos, long initial silence, poor audio quality

### Manual/Uploaded

Creators can add captions by:
- Typing them manually in YouTube Studio
- Uploading subtitle files (.srt, .vtt, .sbv)
- Using "auto-sync" — uploading a plain transcript that YouTube aligns to audio

- Accuracy: near 100%
- **Are** indexed for search/SEO
- Available in any language the creator adds

## Which Do You Get?

When you fetch a transcript, the library returns whatever caption track YouTube serves for the requested language. If manual captions exist, those are preferred. If only auto-generated exist, you get those.

You cannot currently distinguish between the two via this library — both return the same segment format.

## Caption Availability

Not all videos have captions:
- Creator can disable captions entirely
- Some videos predate auto-captioning
- Live streams may not have captions until after processing
- Age-restricted or private videos may require auth

## Languages

- Auto-generated: limited set (mostly major languages)
- Manual: any language the creator adds
- YouTube can auto-translate manual captions to other languages

To request a specific language:
```js
const segments = await fetchTranscript(videoId, { lang: 'es' });
```

If the requested language isn't available, the library throws an error.
