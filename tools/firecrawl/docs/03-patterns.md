# Patterns

Common Firecrawl usage patterns extracted from real projects.

## Two-Stage Discovery (Search then Scrape)

The canonical Firecrawl pattern. Search finds URLs, scrape gets content.

```js
import { searchAndScrape } from '../lib/firecrawl.js';

const results = await searchAndScrape('topic query', {
  searchLimit: 5,
  delay: 1000,
});

// Each result has: url, title, description, markdown, metadata
results.forEach(r => {
  console.log(r.title, r.markdown?.length);
});
```

**When to use:** You don't know the URLs yet. You need to discover and then read content.

**When not to use:** You already have URLs. Just call `scrape()` or `batchScrape()` directly.

## Domain-Scoped Search

Use the `site:` operator in the query to restrict results to a specific domain:

```js
import { search } from '../lib/firecrawl.js';

// Only results from github.com
const { results } = await search('site:github.com firecrawl');

// Multiple domains: run separate searches
const domains = ['github.com', 'npmjs.com'];
for (const domain of domains) {
  const { results } = await search(`site:${domain} firecrawl`);
}
```

## Batch Processing with Rate Limiting

When scraping multiple URLs, always add delays between requests:

```js
import { batchScrape } from '../lib/firecrawl.js';

const results = await batchScrape(urls, {
  delay: 1500,       // 1.5s between requests
  onlyMainContent: true,
});

const successful = results.filter(r => !r.error);
const failed = results.filter(r => r.error);
```

**Rate limiting guidelines:**
- Default delay: 1000ms between requests
- For large batches (20+ URLs): increase to 2000ms
- Watch for 429 responses and back off
- The client catches errors per-URL so one failure doesn't abort the batch

## Fresh vs Cached Content

Control freshness with `maxAge`:

```js
// Always fresh (costs more, slower)
const fresh = await scrape(url, { maxAge: 0 });

// Allow 24h cache (faster, cheaper)
const cached = await scrape(url, { maxAge: 86400000 });

// Default: 48h cache
const default_ = await scrape(url);
```

Use `maxAge: 0` when:
- Content changes frequently (news, prices)
- You need the latest version
- Debugging stale results

Use default/large `maxAge` when:
- Content is stable (docs, reference pages)
- Repeated scrapes of the same URL
- Cost optimization matters

## Content Extraction Pipeline

Common pattern: search, scrape, extract structured data:

```js
import { search, scrape } from '../lib/firecrawl.js';

// 1. Find relevant pages
const { results } = await search('product reviews site:example.com');

// 2. Scrape each with specific options
for (const r of results) {
  const { markdown, metadata } = await scrape(r.url, {
    onlyMainContent: true,
    excludeTags: ['nav', 'footer', 'aside'],
  });

  // 3. Process content (feed to LLM, parse, etc.)
  console.log(`${metadata.title}: ${markdown?.length} chars`);
}
```

## Explicit API Key (Multi-Key Setup)

Use `createClient()` when managing multiple API keys or overriding the env var:

```js
import { createClient } from '../lib/firecrawl.js';

const client = createClient('fc-your-key-here');
const { results } = await client.search('query');
const { markdown } = await client.scrape('https://example.com');
```
