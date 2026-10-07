# Pricing

## Search API (`/search`)

**Flat rate: $5 per 1,000 requests.** No token costs.

This is the cheapest option when you just need search results.

## Chat Completions API (`/chat/completions`)

Token-priced plus per-request fees.

### Token Costs (per 1M tokens)

| Model | Input | Output | Citation | Reasoning |
|-------|-------|--------|----------|-----------|
| sonar | $1 | $1 | — | — |
| sonar-pro | $3 | $15 | — | — |
| sonar-reasoning-pro | $2 | $8 | — | — |
| sonar-deep-research | $2 | $8 | $2 | $3 |

### Request Fees (per 1,000 requests)

Varies by search context size (Low / Medium / High):

| Model | Low | Medium | High |
|-------|-----|--------|------|
| sonar | $5 | $8 | $12 |
| sonar-pro | $6 | $10 | $14 |
| sonar-reasoning-pro | $6 | $10 | $14 |

sonar-deep-research adds $5/1K for search queries the model conducts.

## Cost Optimization

### Use Search API for simple lookups
$5/1K flat rate vs token costs. If you just need search results and a quick answer, `/search` is much cheaper.

### Use sonar for simple questions
$1/1M input+output vs $3/$15 for sonar-pro. Only upgrade to sonar-pro when you need multi-step synthesis.

### Limit search results
`maxResults: 5` instead of the default 10 reduces input tokens and often gives sufficient results.

### Batch queries with Search API
The Search API accepts arrays of up to 5 queries as a single request. One request fee for 5 searches.

### Avoid deep research for quick questions
sonar-deep-research is powerful but expensive and slow. Use `ask` / sonar-pro for most queries. Reserve deep research for genuine research reports.

## Cost Comparison Example

Answering "What is the population of Tokyo?":

| Method | Approximate cost |
|--------|-----------------|
| Search API | ~$0.005 (1 request) |
| sonar | ~$0.006 (request + ~100 tokens) |
| sonar-pro | ~$0.010 (request + ~100 tokens at higher rate) |
| sonar-deep-research | ~$0.015+ (request + many tokens + research queries) |
