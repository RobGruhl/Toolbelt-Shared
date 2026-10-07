# Models

Models only apply to the Chat Completions API (`/chat/completions`). The Search API (`/search`) has no model parameter.

## Model Comparison

| Model | ID | Best for | Speed | Cost |
|-------|-----|----------|-------|------|
| Sonar | `sonar` | Quick factual queries, simple lookups | Fast | Cheapest |
| Sonar Pro | `sonar-pro` | Complex queries, multi-step synthesis | Medium | Moderate |
| Sonar Reasoning Pro | `sonar-reasoning-pro` | Chain-of-thought analysis, comparisons | Slow | Moderate |
| Sonar Deep Research | `sonar-deep-research` | Exhaustive reports, due diligence | Very slow (1-5 min) | Higher |

## Selection Decision Tree

```
Is this a quick factual lookup?
  → Yes: sonar (cheapest, fastest)
  → No: ↓

Does it need multi-source synthesis?
  → Yes, but quickly: sonar-pro
  → Yes, with reasoning steps: sonar-reasoning-pro
  → Yes, exhaustively: sonar-deep-research
```

## When to use Search API instead

The Search API (`/search`) is better when you:
- Need raw search results (titles, URLs, snippets) not just an answer
- Want flat-rate pricing ($5/1K requests, no token costs)
- Don't need a specific model
- Want batch queries (array of up to 5 queries)
- Need date-range filtering on results

## Model Details

### sonar
Lightweight, cost-effective. Good for:
- "What is X?"
- Current events
- Simple factual queries

### sonar-pro
Advanced search with multi-step synthesis. Good for:
- Complex questions requiring multiple sources
- Follow-up conversations
- Academic/SEC search modes

### sonar-reasoning-pro
Chain-of-thought reasoning grounded in search. Good for:
- "Should I use X or Y?"
- Complex analysis requiring logical steps
- Informed recommendations

Supports `reasoning_effort`: `minimal`, `low`, `medium`, `high`

### sonar-deep-research
Exhaustive multi-source investigation. Good for:
- Research reports and briefings
- Due diligence
- Comprehensive comparisons

Takes 1-5 minutes. Set timeout accordingly (default in client: 360s).
