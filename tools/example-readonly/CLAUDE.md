# exr — the agent contract

## Read first

- **What:** Read-only CLI over the public GitHub REST API; one file, no install.
- **Auth:** optional — `$GITHUB_TOKEN`, else `~/.config/exr/token` (mode 600 enforced). Without either it works at GitHub's unauthenticated rate.
- **First read:** `node exr.mjs repo octocat/Hello-World`
- **Writes:** none — every request is a GET; there is no write code to gate.
- **Live here?** `bin/toolbelt doctor exr` says whether it is live on this machine.

**This tool is the template — copy it.** `tools/example-readonly/` is the smallest complete
read-only belt tool: one ESM file, a manifest whose every safeguard is true of the code, a test
file for the pure parts, and this contract. To start a read-only tool for your own system, copy
the directory, rename the verbs, swap `API` and the request builder, and keep every pattern.
The markers `SENSIBILITIES #n` in `exr.mjs` show where each one lives.

## Running it

```
node exr.mjs repo <owner/name>                  stars, forks, open issues, default branch, last push
node exr.mjs releases <owner/name> [--limit N]  most recent releases
node exr.mjs search <query> [--limit N]         repositories matching a GitHub search query
… --json                                        the raw API body, for machines
… --explain                                     pre-flight: URL and headers, no call made
```

`search` takes the rest of the line as the query, so quoting is optional; GitHub's search
qualifiers (`language:rust`, `stars:>1000`, `org:<name>`) pass straight through. Flags are
exactly `--limit`/`-n`, `--json`, `--explain`, `--help`/`-h`, `--version`; `parseArgs` is strict,
so an unknown flag is a usage error: exit 2 with the usage text.

Exit codes: 0 ok · 1 auth, network or API failure · 2 bad usage (including a `--limit` above the
ceiling and a target that is not `owner/name`).

## Auth

`resolveToken()` checks two sources in order:

1. **`$GITHUB_TOKEN`** — wins when set and non-blank.
2. **`~/.config/exr/token`** — read and trimmed. A group- or world-readable file (`mode & 0o077`)
   is **refused** with `chmod 600 it first`, not read. That refusal is what makes the file path
   safe to recommend over an export in a shell rc file, which every subprocess inherits.

Neither present is not an error: the tool runs unauthenticated. The token is never printed,
never logged, never placed on argv; `--explain` renders the header as `Authorization: Bearer ***`.

A fine-grained personal access token with **no write permissions** is the right credential: the
tool would not use write scopes, and a token that cannot write cannot be misused if it leaks.
Revoke it in GitHub's developer settings; there is no `login`/`logout` verb here.

A token changes exactly one thing — the rate limit (below). Private repositories the token can
see also become visible, so the same command can answer differently with and without one.

## Ceilings and pre-flight

Code constants at the top of `exr.mjs` (SENSIBILITIES #3 — raising one is a diff, not a flag):

| Constant | Value | Effect |
|---|---|---|
| `MAX_LIMIT` | 100 | `--limit` above it exits 2 naming the constant. Also GitHub's own `per_page` maximum. |
| `DEFAULT_LIMIT` | 10 | Used by `releases` and `search` when `--limit` is absent. |
| `TIMEOUT_MS` | 20 000 | `AbortController` on every request. A timeout exits 1 and is not retried. |

A too-high `--limit` is refused rather than silently lowered, so the caller learns the ceiling
exists instead of believing they received what they asked for.

`--explain` is the SENSIBILITIES #5 pre-flight. It builds the same request the real call would
send and prints it — URL, headers with the token redacted, which rate limit applies, the
timeout — then returns before any network code runs. It still resolves the token, so a loose
key file fails in `--explain` exactly as it would in a real call; that is the point of a
pre-flight. Chain it in a smoke test: it proves the tool parses and composes without spending a
request.

## Audit trail

One line to **stderr**, immediately before the fetch (SENSIBILITIES #7 — optional for reads,
here so the template shows the shape):

```
[exr] 2026-08-22T17:04:11.210Z verb=repo target="octocat/Hello-World"
```

Timestamp, verb, target. Never the token, never the response. There is no log file; redirect
stderr if you want the trail greppable. `--explain` emits no audit line because nothing ran.

## What "empty" means

- `search` with 0 items: nothing matched **under this principal's visibility**. Private
  repositories never appear unauthenticated, so 0 is not "does not exist".
- `releases` with 0 items: the project publishes no GitHub releases. Many projects tag without
  releasing; `git ls-remote --tags` shows those.
- `repo` never returns empty — it is found, or it is a 404.

## The GitHub API's quirks

- **Rate limits are per source IP when unauthenticated: 60 requests/hour, and `search` has its
  own 10/minute.** Everyone behind the same corporate egress shares that 60. Exhaustion answers
  HTTP 403 or 429 with `x-ratelimit-remaining: 0`; exr reports the reset time and exits 1
  without retrying. A token raises the budget to 5000/hour, scoped to the token's owner.
- **404 means "not found *or* not visible".** GitHub hides private repositories behind the same
  404 it uses for nonexistent ones, so the message says both. Re-run with a token that can see the
  organisation before concluding a repository is gone.
- `--json` prints the API body verbatim — the full object for `repo`, an array for `releases`,
  and `{total_count, incomplete_results, items}` for `search`. Field names follow GitHub's
  documentation; the human rendering picks a handful.
- Every request carries `User-Agent: exr/<version>`; GitHub rejects requests without one.
- Requests pin `X-GitHub-Api-Version: 2022-11-28`, so a future default API version cannot
  change the field names under the renderer.

## Verb inventory

| Read | Form |
|---|---|
| One repository | `exr repo <owner/name>` |
| Recent releases | `exr releases <owner/name> [--limit N]` |
| Repository search | `exr search <query> [--limit N]` |
| Machine output | `… --json` |
| Pre-flight only | `… --explain` |
| Help + ceilings | `exr --help` |

**No write verbs exist** — not gated, *absent*. The manifest lists the GitHub writes (issues,
pull requests, stars, repositories, releases) as tier `never` so the boundary is data, not prose.
The target must match `owner/name` exactly; a URL, a path, or a query string in the target is
rejected before any request is built, so a caller cannot reshape the URL.

## Copying this into your own tool

Keep these when you adapt it:

- the ceilings as exported constants near the top, and a test that asserts their values;
- a pure `buildRequest` + `redactHeaders` pair, so `--explain` and the real call cannot drift
  apart, and so the redaction is testable without a network;
- `resolveToken` with injectable `env`/`keyFile`, so the permission refusal is tested against a
  temp file, never your real one;
- one network function every verb passes through, so the audit line, timeout and error
  vocabulary are the same everywhere;
- a manifest whose `safeguards[]` describe only what the code enforces, and a `never` verb for
  every write the underlying platform offers.
