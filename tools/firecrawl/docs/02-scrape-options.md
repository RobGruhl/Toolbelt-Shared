# Scrape Options

Deep dive into `/v2/scrape` parameters and what they return.

## Formats

The `formats` array controls what content is returned. Request multiple at once.

| Format | Returns | Use case |
|--------|---------|----------|
| `markdown` | Clean markdown text | Content extraction, LLM input |
| `html` | Processed HTML | When you need structure |
| `rawHtml` | Unmodified page HTML | Debugging, archiving |
| `links` | Array of URLs on the page | Link discovery, crawling |
| `screenshot` | Base64 PNG | Visual verification |
| `json` | Structured data (needs schema/prompt) | Data extraction |
| `images` | Image URLs from the page | Media extraction |

```json
{ "formats": ["markdown", "links", "screenshot"] }
```

## Content Filtering

### onlyMainContent (default: true)

Strips navigation, footers, sidebars, ads. Almost always want this on for content extraction. Turn off for full-page archiving.

### includeTags / excludeTags

Fine-grained HTML tag filtering:

```json
{
  "includeTags": ["article", "main"],
  "excludeTags": ["nav", "footer", "aside"]
}
```

### waitFor

Wait for a CSS selector to appear before scraping. Essential for JS-rendered content:

```json
{ "waitFor": "#dynamic-content" }
```

## Caching

### maxAge (default: 172800000 = 48 hours)

Controls cache freshness in milliseconds. Set to `0` for always-fresh scrapes. Cached results are faster and cheaper.

```json
{ "maxAge": 0 }           // Always fresh
{ "maxAge": 3600000 }     // 1 hour cache
{ "maxAge": 86400000 }    // 24 hour cache
```

## Metadata Fields

Every scrape returns `metadata` with these fields (when available):

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Page `<title>` |
| `description` | string | Meta description |
| `language` | string | Page language |
| `sourceURL` | string | Final URL (after redirects) |
| `statusCode` | number | HTTP status code |
| `ogTitle` | string | Open Graph title |
| `ogDescription` | string | Open Graph description |
| `ogUrl` | string | Open Graph URL |
| `ogImage` | string | Open Graph image URL |
| `ogSiteName` | string | Open Graph site name |
| `keywords` | string | Meta keywords |
| `robots` | string | Robots meta tag |

## Localization

Override the request's geographic origin:

```json
{
  "location": {
    "country": "DE",
    "languages": ["de", "en"]
  }
}
```

## JSON Extraction

Use the `json` format with a schema or prompt for structured data extraction:

```json
{
  "formats": ["json"],
  "jsonOptions": {
    "schema": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "price": { "type": "number" }
      }
    },
    "prompt": "Extract the product title and price"
  }
}
```
