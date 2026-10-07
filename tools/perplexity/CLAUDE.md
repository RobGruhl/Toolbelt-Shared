# perplexity (`pplx`) — the agent contract

## Read first

- **What:** Perplexity is a search engine, not your reasoner. Two read-only endpoints: the
  **Search API** (`/search`, raw ranked web results + citations, flat $0.005/call) and the
  **Agent API** (`/v1/agent`, Claude with live web search, token-priced). Every call is paid
  from the operator's own account.
- **Auth:** `$PERPLEXITY_API_KEY`, else `~/.config/toolbelt/perplexity.key` (mode 600
  enforced). No login verb, nothing cached. Create a key at perplexity.ai/settings/api.
- **First read:** `node pplx.mjs search "<query>" --limit 5`
- **Writes:** none — nothing on the Perplexity side is created, changed or deleted. The
  spend is the blast radius, and it is bounded by code ceilings, not by a gate.
- **Pre-flight:** add `--explain` to any command: exact request, key redacted, worst-case
  dollars, no call made. Use it before an `agent` call you are unsure about.
- **House rule:** `search` and `agent` only. The Sonar chat/reason/deep-research functions
  remain in the lib for reference and have no CLI verb. Hand `search` results to yourself to
  reason over; use `agent` only when you want a synthesized, cited answer.

## Running it

```
node pplx.mjs search <query…> [--limit N] [--recency hour|day|week|month|year]
                     [--allow a.com,b.org] [--block x.com] [--after YYYY-MM-DD] [--before YYYY-MM-DD]
node pplx.mjs agent <question…> [--model sonnet|opus|haiku|<id>] [--max-output-tokens N]
                                [--instructions "…"] [--no-search]
… --json        raw API body
… --explain     pre-flight only
```

The query is the rest of the line, so quoting is optional. `parseArgs` is strict: an unknown
flag is exit 2 with the usage text. Exit codes: 0 ok · 1 auth, network or API failure · 2 bad
usage, including any value over a ceiling.

From the repo root: `bin/toolbelt run perplexity -- search "<query>"`.

## Ceilings and cost

Code constants in `lib/constants.js` (`CEILINGS`, `DEFAULTS`); a value above a ceiling is
refused with exit 2, never lowered. Raising one is a reviewed diff.

| Constant | Value | Effect |
|---|---|---|
| `SEARCH_MAX_RESULTS` | 20 (default 10) | `--limit`; also Perplexity's own maximum |
| `SEARCH_MAX_QUERIES` | 5 | batch queries per `search()` call (lib only) |
| `SEARCH_MAX_TOKENS` | 20 000 | content tokens a `/search` returns (lib only) |
| `AGENT_MAX_OUTPUT_TOKENS` | 4096 (default 2048) | `--max-output-tokens`; **always sent**, so an answer cannot run up an unbounded bill |
| `CHAT_MAX_TOKENS` | 4096 (default 2048) | `chat()` in the lib; always sent |
| timeouts | 30 s search · 120 s agent | `AbortSignal.timeout`; a timeout exits 1 and is not retried |

Price at the ceilings: `search` $0.005; `agent` ≈ $0.07 on Sonnet ($3/M in, $15/M out, plus
$0.005 per web search), ≈ $0.11 on Opus, ≈ $0.03 on Haiku. A typical Sonnet answer is
$0.015–0.02. `--explain` prints the worst case; the audit line prints the actual.

## Audit trail

`request()` in `lib/perplexity.js` writes one line to **stderr** after every paid call —
success, API error or timeout — so the trail is the same whether you use the CLI, the examples
or an import:

```
[perplexity audit] 2026-08-22T17:04:11.210Z endpoint=/v1/agent model=anthropic/claude-sonnet-4-6 status=200 ms=8421 in_tokens=1843 out_tokens=412 total_tokens=2255 cost_usd=0.0117 searches=1
```

Never the key, the query or the response. `/search` reports no usage, so its line carries
endpoint, status and elapsed time only — the price is the flat rate. A streamed `chat()` logs
the open without tokens (usage arrives in the final SSE chunk the caller consumes). `--explain`
emits no line because nothing ran. Redirect stderr to keep the trail greppable.

## Auth

`resolveKey()` in `lib/perplexity.js`: explicit key (`createClient('pplx-…')`), else
`$PERPLEXITY_API_KEY`, else `~/.config/toolbelt/perplexity.key` read and trimmed. A group- or
world-readable key file is refused with `chmod 600 it first`. None present is exit 1 naming
both sources; there is no unauthenticated mode. The key travels in a header, never on argv,
and `--explain` renders it as `Bearer ***`.

The lib does not load `.env`. The examples do (`import 'dotenv/config'`), which is why
`npm install` exists; a gitignored in-tree `.env` is their deprecated fallback — the key file
above is the canonical home. `401` means the key is dead or revoked; rotate it in the console.

## What "empty" means

- `search` with 0 results: nothing matched **these filters** — a tight `--allow` list, a
  narrow date window or `--recency hour` are the usual cause. Not proof the thing does not exist.
- `agent` with an empty answer and `--json` showing only `search_results` blocks: the model
  hit `max_output_tokens` before writing, or declined; re-run with a higher `--max-output-tokens`
  (up to the ceiling) or a narrower question.

## The API's quirks

- One domain filter array: allow entries positive, block entries `-prefixed`, at most 20 in
  total; `--allow`/`--block` build it.
- Date filters take `YYYY-MM-DD` and use the newer names (`search_after_date_filter`); the CLI
  validates the shape before any request.
- `/search` has **no answer field** — `snippet` per result is the content. `agent`'s answer
  is `output[] (type:message).content[].text`; sources are `output[] (type:search_results)`.
- Agent model ids are `vendor/model` (`anthropic/claude-sonnet-4-6`); the CLI aliases
  `sonnet`/`opus`/`haiku` to the ids in `AGENT_MODELS`. An unknown id is sent as typed and
  `--explain` says it cannot price it.
- Rate limiting is HTTP 429; `pplx` reports it and exits 1 without retrying.
- Batch search (an array of up to 5 queries) exists in the lib only; the CLI sends one query.

## Verb inventory

| Read | Form |
|---|---|
| Raw web results | `pplx search <query> [--limit N] [filters]` |
| Cited answer (Claude + search) | `pplx agent <question> [--model …]` |
| Machine output | `… --json` |
| Pre-flight + price | `… --explain` |
| Help + ceilings | `pplx --help` |

**No write verbs exist** — not gated, absent. `chat()`, `reason()` and `deepResearch()` (Sonar
models) are importable from `lib/perplexity.js`, carry the same ceilings and audit line, and
have no CLI verb; the manifest lists them as tier `never` on the CLI surface.

## Layout

```
pplx.mjs            the CLI (parse, --explain, render); imports the lib
lib/perplexity.js   search(), agent(), chat(), deepResearch(), reason(), createClient();
                    resolveKey(), assertCeiling(), auditLine()
lib/constants.js    endpoints, models, DEFAULTS, CEILINGS, PRICING, KEY_FILE
examples/01-11      runnable references (need npm install and a key); 04-09 are Sonar-path
docs/01-06          API reference, models, parameters, MCP setup, patterns, pricing
test/               node --test, no network
```
