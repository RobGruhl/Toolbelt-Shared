# Playwright CLI vs Playwright MCP

Two official Playwright packages for AI agents. Different trade-offs.

## When to Use Which

| Factor | CLI (`@playwright/cli`) | MCP (`@playwright/mcp`) |
|--------|------------------------|------------------------|
| **Agent type** | Coding agents (Claude Code, Copilot) | Autonomous agents, chatbots |
| **Token efficiency** | Better — concise CLI commands | Worse — loads tool schemas + accessibility trees |
| **Context window** | Minimal footprint | Large footprint per interaction |
| **State management** | Named sessions, persistent profiles | Persistent browser context |
| **Introspection** | Snapshot on demand | Rich page structure always available |
| **Self-healing** | Agent re-snapshots and adapts | Built-in iterative reasoning |
| **Setup** | `npm install -g @playwright/cli` | MCP server config in claude_desktop_config.json |
| **Package** | `@playwright/cli` | `@playwright/mcp` |

## CLI Advantages

- **Token-efficient**: Does not force page data into LLM context. The agent decides when to snapshot.
- **Skills-based**: Can install skills (`playwright-cli install --skills`) for agent integration.
- **Session isolation**: Named sessions (`-s=name`) for parallel automation.
- **Direct shell access**: Works in any environment that can run shell commands.
- **Headless by default**: No GUI overhead. Pass `--headed` when you want to watch.

## MCP Advantages

- **Persistent state**: Browser context maintained across tool calls without explicit session management.
- **Rich introspection**: Full page structure available for iterative reasoning.
- **Self-healing**: Can adapt to page changes with continuous context.
- **Long-running workflows**: Better for multi-step autonomous loops.
- **No shell dependency**: Works through MCP protocol, no execSync needed.

## Token Comparison

A typical "open page + click button" flow:

**CLI** (~200 tokens):
```
playwright-cli open https://example.com
playwright-cli click e5
```

**MCP** (~2000+ tokens):
- Tool schema loaded into context
- Full accessibility tree returned per interaction
- Each tool call includes verbose response structure

## Decision Tree

1. Building a **coding agent** workflow (Claude Code, scripts)? → **CLI**
2. Need to automate **within a chat interface**? → **MCP**
3. Running **parallel browser sessions**? → **CLI** (named sessions)
4. Need **continuous page monitoring**? → **MCP** (persistent context)
5. Token budget is tight? → **CLI**
