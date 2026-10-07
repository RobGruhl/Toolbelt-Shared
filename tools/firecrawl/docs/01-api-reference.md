# Firecrawl API Reference (v2)

## Base URL

```
https://api.firecrawl.dev/v2
```

## Authentication

Bearer token in `Authorization` header. Key format: `fc-...`

```
Authorization: Bearer fc-your-key-here
```

## Endpoints

### POST /v2/search

Search the web. Returns URLs with title and description.

**Request:**

```json
{
  "query": "web scraping tools",
  "limit": 5,
  "lang": "en",
  "country": "us",
  "location": "California",
  "tbs": "qdr:w",
  "scrapeOptions": { "formats": ["markdown"] }
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query (supports `site:` operator) |
| `limit` | number | — | Max results to return |
| `lang` | string | — | Language code (e.g., "en") |
| `country` | string | — | Country code (e.g., "us") |
| `location` | string | — | Location string (e.g., "Germany") |
| `tbs` | string | — | Time filter: `qdr:h` (hour), `qdr:d` (day), `qdr:w` (week), `qdr:m` (month), `qdr:y` (year) |
| `scrapeOptions` | object | — | Apply scrape options to results (same params as /scrape) |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "url": "https://example.com/page",
      "title": "Page Title",
      "description": "Page description text",
      "markdown": "...",
      "metadata": { }
    }
  ]
}
```

- `data` is an array of result objects
- `markdown` and `metadata` only present if `scrapeOptions` was provided

### POST /v2/scrape

Scrape a single URL. Returns content in requested formats.

**Request:**

```json
{
  "url": "https://example.com",
  "formats": ["markdown"],
  "onlyMainContent": true,
  "maxAge": 0
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | required | URL to scrape |
| `formats` | string[] | — | `markdown`, `html`, `rawHtml`, `links`, `screenshot`, `json`, `images` |
| `onlyMainContent` | boolean | `true` | Strip navigation, footers, sidebars |
| `maxAge` | number (ms) | `172800000` | Cache freshness window. `0` = always fresh |
| `includeTags` | string[] | — | HTML tags to include |
| `excludeTags` | string[] | — | HTML tags to exclude |
| `waitFor` | string | — | CSS selector to wait for before scraping |
| `timeout` | number (ms) | `30000` | Request timeout |
| `headers` | object | — | Custom HTTP headers |
| `location` | object | — | `{ country: "US", languages: ["en"] }` |
| `actions` | array | — | Page interactions before scraping |

**Response:**

```json
{
  "success": true,
  "data": {
    "markdown": "# Page Title\n\nContent...",
    "html": "<h1>Page Title</h1>...",
    "links": ["https://..."],
    "metadata": {
      "title": "Page Title",
      "description": "Page description",
      "sourceURL": "https://example.com",
      "statusCode": 200,
      "language": "en",
      "ogTitle": "...",
      "ogDescription": "...",
      "ogUrl": "...",
      "ogImage": "...",
      "ogSiteName": "..."
    }
  }
}
```

## Actions

Pre-scrape page interactions. Each action has a `type` and type-specific fields:

| Type | Fields | Description |
|------|--------|-------------|
| `click` | `selector` | Click an element |
| `write` | `text`, `selector` | Type text into an input |
| `press` | `key` | Press a keyboard key |
| `wait` | `milliseconds` | Wait for a duration |
| `screenshot` | — | Take a screenshot mid-action |

```json
{
  "actions": [
    { "type": "click", "selector": "#load-more" },
    { "type": "wait", "milliseconds": 2000 },
    { "type": "screenshot" }
  ]
}
```

## Error Responses

```json
{
  "success": false,
  "error": "Error message"
}
```

HTTP status codes: `401` (bad API key), `402` (billing), `429` (rate limit), `500` (server error).
