# API Reference

Perplexity has two distinct API endpoints. Both use the same API key and base URL.

## Base URL

```
https://api.perplexity.ai
```

## Authentication

All requests use Bearer token auth:

```
Authorization: Bearer pplx-your-key-here
```

---

## 1. Search API — `POST /search`

Flat-rate web search. No model selection. Returns search results with an AI-synthesized answer.

### Request

```json
{
  "query": "string or string[]",
  "max_results": 10,
  "max_tokens": 10000,
  "max_tokens_per_page": 4096,
  "search_domain_filter": ["example.com", "-blocked.com"],
  "search_language_filter": ["en"],
  "search_recency_filter": "day|week|month|year",
  "search_after_date_filter": "2026-01-01",
  "search_before_date_filter": "2026-02-01",
  "search_mode": "web|academic|sec",
  "country": "US"
}
```

Only `query` is required. Everything else is optional.

### Response

```json
{
  "id": "request-id",
  "results": [
    {
      "title": "Page Title",
      "url": "https://...",
      "snippet": "Relevant page content excerpt...",
      "date": "2026-01-15",
      "last_updated": "2026-01-20"
    }
  ]
}
```

**No `answer` field.** The Search API returns raw search results, not a synthesized answer. Each result has a `snippet` with extracted page content. Use the Chat Completions API if you need a synthesized answer.

### Key behaviors
- `query` can be a string or array of strings (batch search, max 5)
- Domain filter uses a single array: positive entries are allow-list, `-prefixed` entries are block-list
- Date filters use ISO format (`YYYY-MM-DD`)
- No model parameter — this endpoint doesn't use LLM models
- Results include long `snippet` fields with extracted page content (not just short previews)

---

## 2. Chat Completions API — `POST /chat/completions`

OpenAI-compatible chat endpoint with search grounding. Token-priced. Model selection required.

### Request

```json
{
  "model": "sonar-pro",
  "messages": [
    { "role": "system", "content": "Optional system prompt" },
    { "role": "user", "content": "Your question" }
  ],
  "stream": false,
  "search_domain_filter": ["example.com"],
  "search_mode": "web",
  "search_recency_filter": "week",
  "response_format": { "type": "json_schema", "json_schema": { ... } },
  "max_tokens": 4096,
  "return_images": false,
  "return_related_questions": false,
  "reasoning_effort": "high",
  "num_search_results": 10
}
```

Only `model` and `messages` are required.

### Response

```json
{
  "id": "chatcmpl-...",
  "model": "sonar-pro",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "Synthesized answer text..."
      }
    }
  ],
  "citations": ["https://source1.com", "https://source2.com"],
  "search_results": [
    {
      "title": "Source Title",
      "url": "https://...",
      "snippet": "Brief excerpt...",
      "date": "2026-01-15"
    }
  ],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 256,
    "total_tokens": 298
  }
}
```

### Key behaviors
- OpenAI SDK compatible (swap base URL)
- Streaming uses SSE (Server-Sent Events) — citations arrive in the final chunk
- `response_format` supports JSON Schema and regex
- `reasoning_effort` only applies to `sonar-reasoning-pro`
- `search_mode` values: `web` (default), `academic`, `sec`

---

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Bad request (invalid params) |
| 401 | Invalid or missing API key |
| 403 | Insufficient permissions |
| 429 | Rate limit exceeded |
| 500 | Server error |
