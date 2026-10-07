# Parameters Reference

## Search API Parameters

### query (required)
- **Type:** `string | string[]`
- **Endpoint:** `/search`
- String for single query, array of up to 5 strings for batch search.

### max_results
- **Type:** `integer`
- **Default:** `10`
- Number of search results to return.

### max_tokens
- **Type:** `integer`
- **Default:** `10000`
- Overall token budget for the response.

### max_tokens_per_page
- **Type:** `integer`
- **Default:** `4096`
- Token limit per source page. Lower values = faster but less detail per source.

### search_domain_filter
- **Type:** `string[]`
- Allow-list and block-list in one array.
- Positive: `["nytimes.com"]` — only search this domain
- Negative: `["-reddit.com"]` — exclude this domain
- Mixed: `["nytimes.com", "-reddit.com"]`
- **Gotcha:** Max 20 domains. Can't combine more than that.

### search_recency_filter
- **Type:** `"hour" | "day" | "week" | "month" | "year"`
- Restricts results by publication recency.
- **Gotcha:** Can't combine with date filters.

### search_after_date_filter / search_before_date_filter
- **Type:** `string` (ISO format: `YYYY-MM-DD`)
- Filter by publication date range.
- **Gotcha:** These are the newer parameter names. The old `search_start_published_date` / `search_end_published_date` (MM/DD/YYYY format) may still work but use ISO format.

### search_mode
- **Type:** `"web" | "academic" | "sec"`
- `academic`: prioritizes scholarly sources (papers, journals)
- `sec`: targets SEC EDGAR filings
- Works on both Search and Chat Completions endpoints.

### country
- **Type:** `string` (ISO code, e.g., `"US"`)
- Geographic targeting for search results.

### search_language_filter
- **Type:** `string[]` (ISO 639-1 codes, e.g., `["en", "fr"]`)
- Filter results by language.

---

## Chat Completions Parameters

### model (required)
- **Type:** `string`
- One of: `sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research`

### messages (required)
- **Type:** `array` of `{role, content}` objects
- Roles: `system`, `user`, `assistant`
- Standard OpenAI chat format.

### stream
- **Type:** `boolean`
- **Default:** `false`
- SSE streaming. Citations arrive in the final chunk.

### response_format
- **Type:** `object`
- JSON Schema: `{ type: "json_schema", json_schema: { name, strict, schema } }`
- Forces structured output conforming to the schema.
- **Gotcha:** `strict: true` requires `additionalProperties: false` on all objects.

### reasoning_effort
- **Type:** `"minimal" | "low" | "medium" | "high"`
- Only for `sonar-reasoning-pro`. Controls depth of chain-of-thought.

### return_images
- **Type:** `boolean`
- **Default:** `false`
- Include images in the response.

### return_related_questions
- **Type:** `boolean`
- **Default:** `false`
- Include related follow-up questions.

### max_tokens
- **Type:** `integer`
- Max output tokens. Up to 128,000.

### num_search_results
- **Type:** `integer`
- How many web sources to consult before generating the answer.

---

## Client Library Mapping

The `lib/perplexity.js` client uses camelCase options that map to snake_case API parameters:

| Client option | API parameter |
|---------------|---------------|
| `maxResults` | `max_results` |
| `maxTokens` | `max_tokens` |
| `maxTokensPerPage` | `max_tokens_per_page` |
| `allowDomains` | `search_domain_filter` (positive) |
| `blockDomains` | `search_domain_filter` (negative, `-` prefix) |
| `recency` | `search_recency_filter` |
| `startDate` | `search_after_date_filter` |
| `endDate` | `search_before_date_filter` |
| `searchMode` | `search_mode` |
| `systemPrompt` | First message with `role: "system"` |
| `responseFormat` | `response_format` |
| `returnImages` | `return_images` |
| `returnRelatedQuestions` | `return_related_questions` |
| `numSearchResults` | `num_search_results` |
| `reasoningEffort` | `reasoning_effort` |
| `timeoutMs` | `AbortSignal.timeout()` (client-side) |
