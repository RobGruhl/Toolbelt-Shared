# gmh — the agent contract

## Read first

- **What:** Read-only, byte-exact Gmail export on the operator's own OAuth grant. `export` writes
  each message's raw RFC 822 bytes straight to `<id>.eml` and a metadata-only `index.jsonl`; no
  body ever passes through a model. One file, `gmh.mjs`, zero dependencies.
- **Why it exists beside the connector:** `connectors/google-workspace` returns message bodies
  into model context — right for reading a handful, wrong for bulk. **Bulk, byte-exact or
  programmatic mail reads go through gmh; the MCP content tools are for the few messages a human
  conversation needs.**
- **Auth:** the Desktop-app OAuth client shared with `connectors/google-workspace` (Keychain item
  `google-workspace-oauth`), a grant of exactly `gmail.readonly`, tokens in
  `~/.config/toolbelt/gmail-harvest/<account>.json` (600). `gmh auth` is the human's step.
- **First read:** `node gmh.mjs whoami`
- **Writes:** none to Gmail — no write scope, no write code. `export` writes local files only, into
  the directory the operator named.
- **Live here?** `bin/toolbelt doctor gmh` — Keychain item, token file mode and scope, reachability.

## Running it

```
gmh auth [--account EMAIL]                          browser consent (human, interactive)
gmh status [--account EMAIL] [--live] [--json]      token presence, mode, scope, expiry
gmh whoami [--account EMAIL] [--json]               email, messagesTotal, threadsTotal
gmh list --query Q [--max N] [--json]               message ids + threadIds
gmh export (--query Q | --ids-file F) --out DIR [--max N] [--explain] [--json]
```

`gmh` is `node gmh.mjs` from this directory, `toolbelt run gmh -- …` from anywhere, or bare `gmh`
once `toolbelt setup gmh` has linked `/opt/homebrew/bin/gmh`. With one authorized account
`--account` is optional; with several it is required. `parseArgs` is strict: an unknown flag, a
flag that does not apply to the verb, or a stray positional is exit 2. Pass the search as
`--query "<gmail search>"`, quoted.

Exit codes: 0 ok · 1 auth, network, API or any per-message failure · 2 bad usage (including
`--max` above the ceiling and a refused `--out`).

**Run `export --explain` first and show the human the count** before any export larger than the
default 500. **Never run `gmh auth`** yourself — it opens a browser consent only the operator can
complete; hand them the command.

## Auth, in full

**Client:** the operator's own **Desktop app** OAuth client in their Cloud project, with the Gmail
API enabled and the operator listed as a test user while the consent screen is in *Testing*. gmh
reads the client id from the Keychain item's account field and the secret with
`security find-generic-password -s google-workspace-oauth -w`, through `execFile` — never argv,
never a shell, never printed. Absent the item it falls back to `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET`. Store the pair once (prompts for the secret; never on argv):
`security add-generic-password -U -s google-workspace-oauth -a "<client id>" -w`.

**Consent (`gmh auth`):** a loopback listener on an ephemeral `127.0.0.1` port (Desktop clients
accept any loopback port, and an ephemeral one never collides with workspace-mcp's `:8000`),
PKCE S256, a random state, `access_type=offline&prompt=consent`, and `login_hint` when
`--account` is given. The URL is printed to stderr and opened with `open`; the listener waits 5
minutes. After the exchange gmh reads `users/me/profile` and saves the token under the address
Google reports — a consent granted by a different address than `--account` saves nothing.

**Scope is exactly `https://www.googleapis.com/auth/gmail.readonly`, or the token is refused** —
at consent, on every refresh, and on every read of the cache. gmh never sends
`include_granted_scopes`, so the grant carries only what it asks for. An unticked Gmail box
yields no scope and a refusal; tick it and re-run. A grant that ever comes back carrying more
than `gmail.readonly` is refused and not saved.

**Expiry:** access tokens last an hour and renew through the refresh grant with no human.
While the consent screen is in *Testing* status Google expires the refresh token **7 days after
consent**; the next call then fails with `invalid_grant` and gmh says to re-run `gmh auth`.
`status` prints the consent time and the 7-day date. Moving the consent screen to *Production*
ends the cadence.

**Cache:** `~/.config/toolbelt/gmail-harvest/<account>.json`, dir 700, file 600, written
atomically. It holds `access_token`, `refresh_token`, `expiry`, `scope`, `account`, `client_id`,
`consented_at` — never the client secret. A group/world-readable file is refused, not read:
`chmod 600` it. `status` reports path, mode, scope, expiry and refresh-token presence, never a
value.

**Revoke:** `rm ~/.config/toolbelt/gmail-harvest/<account>.json` ends gmh's use on this machine.
Revoking at the source is myaccount.google.com/permissions → remove the app — that removes every
grant on the shared client, including the connector's, which then re-consents on its next call.

## Ceilings and pre-flight

Code constants at the top of `gmh.mjs` (SENSIBILITIES #3 — raising one is a diff, not a flag):

| Constant | Value | Effect |
|---|---|---|
| `MAX_MESSAGES` | 5000 | `--max` above it exits 2. An `--ids-file` longer than `--max` exits 2. |
| `DEFAULT_MAX` | 500 | `list` and `export` stop here when `--max` is absent. |
| `CONCURRENCY` | 4 | Parallel `messages.get`. Gmail answers `429 Too many concurrent requests for user` above low concurrency. |
| `TIMEOUT_MS` | 30 000 | Per request. |
| `MAX_ATTEMPTS` | 4 | Per request, exponential backoff (1 s, 2 s, 4 s + jitter) on 429 / 5xx / rate-limit 403, honoring `Retry-After`, capped at 60 s per wait. |
| `BREAKER` | 10 | Consecutive per-message failures that stop an export; the rest are reported `not attempted`. |

A query matching more than `--max` exports the first `--max` (newest first) and says so on
stderr; re-running the same command re-lists the same ids and skips them. To get the rest, raise
`--max` to the ceiling or split the query by date. Off-hours gating (SENSIBILITIES #4) does not
apply: the load lands on the operator's own per-user quota, not a shared system.

`export --explain` is the pre-flight: it resolves the credentials, runs the list (or reads the
ids file), reads any existing `index.jsonl`, and prints the account, scope, match count against
the ceiling, the output dir, how many ids resume would skip, and the call and quota estimate
(5 units per `messages.list` page and per `messages.get`). It fetches no bodies, creates nothing
in the output dir, and keeps a refreshed token in memory only.

## What export writes

`--out` is refused when it is `/`, `$HOME` itself, or anywhere inside the Toolbelt tree
(symlinks resolved) — exported mail is private data and never lands in the belt. The dir is
created 700; a pre-existing group/world-accessible dir draws a warning.

- `DIR/<id>.eml` — `users.messages.get?format=raw`, base64url-decoded, byte for byte, mode 600,
  written to `<id>.eml.part` then renamed. A body that does not round-trip is a per-message
  failure, never a silently altered file.
- `DIR/index.jsonl` — one line per attempt, mode 600, append-only:
  `{id, threadId, labelIds, internalDate, sizeEstimate, historyId, sha256, bytes, exported_at}` on
  success, `{id, error, failed_at}` on failure. The `snippet` Gmail returns is content and is not
  stored. The last line for an id is its current state.

**Resume:** an id is skipped when its latest index line is a success and `<id>.eml` exists at
exactly the recorded `bytes`; anything else is fetched again, so re-running the same command
retries failures and repairs torn files. A per-message failure is never dropped: it is an index
line, a count in the summary, and exit 1. Auth failures and a Gmail API that refuses the project
abort the whole run instead of failing every id.

Consumers read `index.jsonl`, take the last line per id, and verify `sha256` against the file.
`--json` prints one summary object:
`{account, out, query|ids_file, matched, more_matched, exported, skipped, failed, not_attempted, bytes}`.

## Audit trail

One line per verb run to **stderr** and appended to
`~/.local/share/toolbelt/gmail-harvest/audit.log` (dir 700, file 600):

```
[gmh audit] 2026-09-23T17:04:11.210Z verb="export" account="me@example.com" query="newer_than:7d" count=312 bytes=18234411 failures=0 skipped=0 out="/Users/me/mail/week" result="done"
```

Timestamp, verb, account, query or ids-file, count, bytes, failures, out dir. Never a token,
never message content. The query is logged as typed, so the log names whatever the query names.

## What "empty" means

- `list` / `export` with 0 matches: nothing matched **that query in that account**, with spam
  and trash excluded (gmh does not set `includeSpamTrash`). Check the query in the Gmail web UI
  before reporting that no such mail exists; several web-UI operators behave differently in the
  API (below).
- `exported 0 · skipped N`: everything was already on disk — a finished resume, not a failure.
- A 404 for an id in an ids file: the message was deleted or belongs to another mailbox.

## Gmail's quirks

- **Search is Gmail's own operator language** — `from:`, `to:`, `subject:`, `label:`,
  `category:`, `in:inbox`, `is:unread`, `has:attachment`, `newer_than:7d`, `older_than:1y`,
  `after:` / `before:`, `larger:`, `rfc822msgid:`. `has:list-unsubscribe` works in the web UI and
  **not** in the API.
- **Date boundaries:** Google documents `after:`/`before:` dates as midnight Pacific; the web UI
  applies the account's timezone, so the same query can differ by a few hours at the edges. For
  exact boundaries pass epoch seconds (`after:1758585600`). `internalDate` in the index is epoch
  milliseconds UTC and is the ground truth.
- **`format=raw` vs `format=full`:** `raw` is the complete RFC 822 message as stored — headers,
  MIME structure, attachments — base64url-encoded; it is the only byte-exact form. `full` is
  Google's parsed MIME tree with per-part bodies and is not a reconstruction of the original
  bytes. gmh uses `raw` only. `sizeEstimate` is approximate; `bytes` in the index is exact.
- **Message ids vs thread ids:** gmh exports messages. `threadId` is in the index for grouping;
  a thread of five messages is five files.
- **Quota:** `messages.list` and `messages.get` cost 5 per-user quota units each; concurrency, not
  quota, is what trips first.

## Verb inventory

| Read | Form |
|---|---|
| Consent (human) | `gmh auth --account <you@example.com>` |
| Token state | `gmh status` (`--live` adds one profile read) |
| Who and how much | `gmh whoami` |
| Ids for a search | `gmh list --query "<q>" [--max N]` |
| Pre-flight | `gmh export --query "<q>" --out <dir> --explain` |
| Export | `gmh export --query "<q>" --out <dir> [--max N]` or `--ids-file <file>` |

**No Gmail write exists** — not gated, absent, with no scope that could perform one. The manifest
tiers every Gmail write as `never`: send, label changes / archive / mark read, trash / delete,
drafts, insert / import, filters / forwarding / settings. Mailbox changes run through the
connector's Apps Script pipeline (`connectors/google-workspace/CLAUDE.md`, "Gmail doctrine").

## Links from an exported message (`links`, local)

`gmh links --eml <dir>/<id>.eml [--match "unsubscribe|payment method"] [--json]` prints every
http(s) and mailto anchor as `anchor text<TAB>href`, exactly as the sender wrote it. It walks
the MIME tree itself: multipart, quoted-printable, base64, charsets, and it skips attachments.
Mail with no HTML part falls back to bare URLs from the text.

Use it whenever a next step needs a real link (a payment page, an unsubscribe page, a settings
page): an agent names the anchor text and code copies the href. A model never retypes a URL,
because tokens and tracking paths change silently. It needs no network and no auth.
