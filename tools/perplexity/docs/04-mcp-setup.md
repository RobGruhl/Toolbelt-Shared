# MCP Setup

Perplexity works well as an MCP tool server, giving Claude access to web search.

## Pattern: Custom MCP Server

This is what `hello-claude-claw` does — a custom MCP server with two tools: `ask` (sonar-pro) and `deep_research` (sonar-deep-research).

The key insight: wrap the Perplexity client into MCP tools so Claude can decide when to search.

```js
// Simplified from hello-claude-claw/src/mcp/search.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { chat, deepResearch } from './lib/perplexity.js';

export function createSearchMcp() {
  return createSdkMcpServer({
    name: 'search',
    version: '1.0.0',
    tools: [
      tool('ask', 'Search the web for a sourced answer', {
        query: z.string(),
        domain_filter: z.array(z.string()).optional(),
        search_mode: z.enum(['web', 'academic', 'sec']).optional(),
      }, async (args) => {
        const { answer, citations } = await chat(args.query, {
          allowDomains: args.domain_filter?.filter(d => !d.startsWith('-')),
          blockDomains: args.domain_filter?.filter(d => d.startsWith('-')).map(d => d.slice(1)),
          searchMode: args.search_mode,
        });
        let text = answer;
        if (citations.length) {
          text += '\n\nSources:\n' + citations.map((url, i) => `[${i + 1}] ${url}`).join('\n');
        }
        return { content: [{ type: 'text', text }] };
      }),

      tool('deep_research', 'Deep multi-source investigation (1-5 min)', {
        query: z.string(),
      }, async (args) => {
        const { answer, citations } = await deepResearch(args.query);
        let text = answer;
        if (citations.length) {
          text += '\n\nSources:\n' + citations.map((url, i) => `[${i + 1}] ${url}`).join('\n');
        }
        return { content: [{ type: 'text', text }] };
      }),
    ],
  });
}
```

## SKILL.md Pattern

When using Perplexity as MCP tools with Claude Code, a SKILL.md file helps Claude decide when to use `ask` vs `deep_research`:

```markdown
## Decision Tree

| Situation | Tool |
|---|---|
| Quick factual question | ask |
| "What is X?" / "How do I..." | ask |
| Current events | ask |
| Academic sources needed | ask with search_mode: 'academic' |
| SEC filings | ask with search_mode: 'sec' |
| Specific site content | ask with domain_filter |
| Complex comparison | deep_research |
| Research report | deep_research |
| "Write me a briefing on..." | deep_research |

Rule of thumb: ask is the default. Only use deep_research when depth justifies the 1-5 minute wait.
```

## When NOT to Search

- You already know the answer (general knowledge)
- Information is in the workspace (use file tools)
- User is asking about their own codebase
