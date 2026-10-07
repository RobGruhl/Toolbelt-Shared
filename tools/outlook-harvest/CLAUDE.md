# omh — the agent contract

## Read first

- **What:** read-only, byte-exact export of a personal Outlook.com / Hotmail mailbox through
  Microsoft Graph. It is gmh's Microsoft twin.
  - `export` writes each message's MIME bytes (`/messages/{id}/$value`) to `<id>.eml` and a
    metadata-only `index.jsonl`, in **gmh's shape**.
  - So `gmh links`, `gmf unsub-plan` and jev-test's loader read an omh export unchanged.
  - One file, no dependencies.
- **Auth:** the operator's own public app registration (no secret) and a **device code**. The
  human enters the code at microsoft.com/devicelogin on any device; a phone works. The Graph
  permission is exactly `Mail.Read`, or the token is refused.
- **First read:** `node omh.mjs whoami` (folder totals).
- **Writes:** none to the mailbox: no send, move, delete or settings code, and no permission that
  could do any of them. `export` writes local files into the directory the operator named.
- **Live here?** `bin/toolbelt doctor outlook-harvest`.

```
omh auth [--client-id GUID]                 device-code sign-in; the client id is saved once
omh status [--account EMAIL] [--json]       token presence, mode, scope, expiry (no network)
omh whoami [--account EMAIL] [--json]       folder totals and unread counts
omh list   [--folder F] [--since D] [--until D | --search Q] [--max N] [--json]
omh export [same selection] --out DIR [--max N] [--explain] [--json]
```

Folders: `all` (the default), `inbox`, `junkemail`, `deleteditems`, `sentitems`, `drafts`,
`archive`. Dates are `YYYY-MM-DD` (UTC). `--search` is Graph KQL and cannot be combined with dates.

**Run `export --explain` first and show the human the count** before any export over the
default 500.

**`omh auth`:** an agent may start it and relay the printed code; only the human can complete
the sign-in, on Microsoft's page, which works from a phone. The agent never enters the code,
never signs in, and never consents on the human's behalf.

## One-time setup (the human)

1. Sign in at https://entra.microsoft.com with the mailbox's Microsoft account. Go to
   **App registrations → New registration**.
   - Name: `toolbelt-outlook-harvest`.
   - Supported account types: **Personal Microsoft accounts only**.
   - No redirect URI.
2. **Authentication → Advanced settings → Allow public client flows: Yes**.
3. **API permissions → Add → Microsoft Graph → Delegated → `Mail.Read`**. Remove anything else
   (a default `User.Read` is fine to remove; omh does not use it). The token is refused if its
   Graph permissions are not exactly `Mail.Read`.
4. Copy the **Application (client) ID** (a GUID, not a secret). Run
   `node omh.mjs auth --client-id <GUID>`, open the printed URL, enter the code, and consent.

Microsoft has been restricting new app registrations for personal accounts that have no
directory. If step 1 asks for one, creating a free Azure account creates a default directory.

## What export writes

- **`DIR/<id>.eml`:** exact MIME, mode 600, written to `.part` then renamed. `<id>` is the first
  24 hex characters of sha256(Graph immutable id), which is stable and safe on case-insensitive
  disks.
- **`DIR/index.jsonl`:** one line per attempt, append-only, 600.
  - Success: `{id, graph_id, threadId (conversationId), labelIds: [folder display name],
    internalDate (epoch ms string), sha256, bytes, source_link (Graph webLink), exported_at}`.
  - Failure: `{id, graph_id, error, failed_at}`.
  - The last line for an id is its current state.
- **Resume:** an id is skipped when its latest line is a success and its `.eml` has exactly the
  recorded byte count.

## Gotchas

- `/me/messages` spans every folder, including **Junk Email**. `labelIds` names the folder, so
  junk is visible in the index. Hotmail's own junk filtering is a signal, not ground truth.
- Graph ids change when a message moves unless requested as immutable. omh always sends
  `Prefer: IdType="ImmutableId"`.
- Throttling is per mailbox: 429s honor `Retry-After`. Concurrency is 4.
- `--search` uses Graph's `$search` (KQL: `from:`, `subject:`, words). Results are relevance
  ordered, not date ordered, and **capped at 275 per query** (a count of exactly 275 means
  "at least"). Bound the window inside the KQL itself, e.g.
  `--search "renewal received>=2025-09-01"`, since `$search` cannot be combined with
  `--since`/`--until`, and split terms until each query returns fewer than 275.
