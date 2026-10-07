# Patterns

Patterns distilled from three production projects.

## Domain Filtering

### Allow-list for source quality
Lock searches to trusted domains for specific topics:

```js
// Cycling race information — only official + trusted cycling sites
await search('Tour de France 2026 route', {
  allowDomains: ['cyclingnews.com', 'velonews.com', 'letour.fr', 'procyclingstats.com'],
});

// TTRPG rules — only community-trusted sources
await search('Lancer RPG grapple rules', {
  allowDomains: ['reddit.com', 'massifpress.com', 'compcon.app'],
});
```

### Block-list for noise reduction
```js
await search('best mechanical keyboard', {
  blockDomains: ['reddit.com', 'quora.com', 'pinterest.com'],
});
```

### Combined: allow + block
```js
await search('race preview', {
  allowDomains: ['cyclingnews.com', 'velonews.com'],
  blockDomains: ['wikipedia.org'],  // often has spoilers
});
// API receives: ["cyclingnews.com", "velonews.com", "-wikipedia.org"]
```

## Spoiler Safety (Date Filtering)

For past events, restrict results to content published BEFORE the event to avoid spoilers:

```js
const raceDate = '2025-07-13';
const today = new Date();
const isPast = new Date(raceDate) < today;

await search('Tour de France Stage 15 preview', {
  endDate: isPast ? raceDate : undefined,
  allowDomains: ['cyclingnews.com', 'velonews.com'],
  blockDomains: ['wikipedia.org', 'sporza.be'],  // spoiler-prone
});
```

This pattern was developed in `no-spoiler-cycling` — the date filter ensures you only get preview/preview content, never results.

## Authority Tiers

From `lancer-rules-lawyer` — classify search results by authority:

```js
function classifySource(url, content) {
  if (url.includes('massifpress.com')) return 'OFFICIAL';
  if (url.includes('reddit.com') && content.includes('dev response')) return 'OFFICIAL';
  if (content.includes('consensus') || content.includes('most tables')) return 'CONSENSUS';
  if (content.includes('house rule') || content.includes('homebrew')) return 'HOUSE_RULE';
  return 'INTERPRETATION';
}
```

Use this pattern when search results have varying levels of authority and you need to surface the most reliable ones first.

## Parallel Search

Run multiple queries concurrently for comprehensive research:

```js
const queries = [
  'topic market share 2026',
  'topic technology breakthroughs 2026',
  'topic regulatory changes 2026',
];

const results = await Promise.all(
  queries.map(q => search(q, { maxResults: 5, recency: 'month' }))
);

// Each result has { answer, citations, results, raw }
```

This is faster than sequential queries and was the pattern used in `no-spoiler-cycling`'s `searchRaceComprehensive`.

## Search Mode Selection

```js
// Default web search
await chat('latest AI news');

// Academic/scholarly sources
await chat('CRISPR gene therapy advances', { searchMode: 'academic' });

// SEC filings
await chat('Apple Q4 2025 revenue breakdown', { searchMode: 'sec' });
```

## Structured Output for Programmatic Use

When you need to parse search results programmatically:

```js
const { answer } = await chat('top 5 programming languages by popularity', {
  responseFormat: {
    type: 'json_schema',
    json_schema: {
      name: 'languages',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          languages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rank: { type: 'number' },
                name: { type: 'string' },
                index_score: { type: 'number' },
              },
              required: ['rank', 'name', 'index_score'],
              additionalProperties: false,
            },
          },
        },
        required: ['languages'],
        additionalProperties: false,
      },
    },
  },
});

const data = JSON.parse(answer);
```

## Timeout Handling

Different models need different timeouts:

```js
import { DEFAULTS } from './lib/constants.js';

// sonar/sonar-pro: 30s default
await chat('quick question');

// sonar-reasoning-pro: 60s default
await reason('complex analysis');

// sonar-deep-research: 360s (6 min) default
await deepResearch('exhaustive report');

// Override for any call
await chat('query', { timeoutMs: 120_000 });
```
