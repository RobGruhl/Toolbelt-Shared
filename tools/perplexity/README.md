# hello-perplexity

Canonical reference for the Perplexity API. Clean client, runnable examples, docs.

**Perplexity is a search engine, not an LLM.** You have Claude for reasoning — Perplexity is for current web information with citations.

> ## 🔎 House rule: Search API + Agent API (Claude), never Sonar
> Two tools, both grounded in Perplexity search:
> - **`search()`** — raw ranked web results + citations, flat-rate ($5/1K), no LLM. Hand results to Claude (me) to reason over.
> - **`agent()`** — a **third-party frontier model (default Claude Sonnet 4.6)** with live web search + citations. This is the "Claude, with search" path. Endpoint `POST /v1/agent`; priced at the provider's direct rate ($3/M in, $15/M out) + ~$0.005/search.
>
> **The Perplexity Sonar models are intentionally NOT used** — no `chat()` / `reason()` / `deepResearch()` (sonar / sonar-pro / sonar-reasoning-pro / sonar-deep-research). Those stay in the lib for API-reference completeness and downstream copies, but they're not the path here. If you want a synthesized answer, use `agent()` (Claude); if you want raw sources, use `search()`.

## Quick Start

```bash
export PERPLEXITY_API_KEY=pplx-...        # or: ~/.config/toolbelt/perplexity.key (chmod 600)
node pplx.mjs search "your query" --limit 5
node pplx.mjs agent "your question" --explain   # price it first; drop --explain to run
npm install && node examples/01-basic-search.js # examples load a gitignored .env via dotenv
```

The agent contract — auth path, ceilings, audit line, quirks — is [CLAUDE.md](CLAUDE.md). The lib does **not** auto-load `.env`; it reads `$PERPLEXITY_API_KEY` or the 600-mode key file. Every call writes one `[perplexity audit]` line to stderr.

## The Search API (`/search`)

Flat-rate web search ($5/1K requests). No model. Returns raw results (`title`, `url`, `snippet`) + citations. Supports batch queries (array of up to 5 strings), domain filtering, and date ranges.

```js
import 'dotenv/config';
import { search } from './lib/perplexity.js';

const { results, citations } = await search('your query');
results.forEach(r => console.log(r.title, r.url, r.snippet));

// Explicit API key (vs env var)
import { createClient } from './lib/perplexity.js';
const pplx = createClient('pplx-...');
await pplx.search('query');
```

There is no synthesized `answer` field from `/search` — that's by design. Hand the `results` + `citations` to Claude for synthesis.

## The Agent API (`/v1/agent`) — Claude Sonnet with search

A third-party frontier model with Perplexity web-search grounding. Default model is **`anthropic/claude-sonnet-4-6`**. OpenAI `/v1/responses`-compatible. Token-priced at the provider's direct rate (no markup) + a per-search tool charge.

```js
import 'dotenv/config';
import { agent } from './lib/perplexity.js';

const { answer, citations, results, usage } = await agent('your question', {
  // model: 'anthropic/claude-sonnet-4-6',   // default; also CLAUDE_OPUS / CLAUDE_HAIKU in AGENT_MODELS
  // webSearch: true,                         // default; set false to disable the search tool
  instructions: 'Use web_search for anything recent. Cite sources.',
});
console.log(answer);            // Claude's synthesized answer
console.log(citations);         // source URLs
console.log(usage.cost.total_cost);  // $ for the call
```

Model IDs live in `AGENT_MODELS` (constants). Verified live: a Sonnet call with one web search ≈ $0.015–0.02.

## Examples

| # | File | What |
|---|------|------|
| 01 | `basic-search.js` | Simplest Search API call |
| 02 | `domain-filtering.js` | Allow/block domains |
| 03 | `date-filtering.js` | Recency + date range + spoiler safety |
| 10 | `parallel-search.js` | Concurrent search queries |
| 11 | `agent-claude.js` | **Agent API — Claude Sonnet 4.6 + web search** |

*Search + Agent examples are the ones used here. (04 chat-completions, 05 deep-research, 06 reasoning, 07 streaming, 08 structured-output, 09 openai-sdk-compat remain on disk as Sonar/Chat-API references but are **not used here** — see House rule above.)*

## Docs

- [API Reference](docs/01-api-reference.md) — Both endpoints, auth, request/response shapes
- [Models](docs/02-models.md) — Model comparison (Chat API reference only)
- [Parameters](docs/03-parameters.md) — Every parameter with examples and gotchas
- [MCP Setup](docs/04-mcp-setup.md) — Using Perplexity as MCP tools for Claude
- [Patterns](docs/05-patterns.md) — Domain filtering, spoiler safety, authority tiers, parallel search
- [Pricing](docs/06-pricing.md) — Cost per endpoint/model, optimization strategies

## Used In

- **[no-spoiler-cycling](../no-spoiler-cycling)** — Search API with domain filtering, date ranges, spoiler-safe queries
- **[lancer-rules-lawyer](../lancer-rules-lawyer)** — Search API with authority tier detection
- **[hello-claude-claw](../hello-claude-claw)** — Chat Completions via MCP tools (ask + deep_research)
