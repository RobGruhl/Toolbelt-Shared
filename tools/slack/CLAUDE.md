# slack — the agent contract

## Read first

- **What:** your company's Slack, as you: a read-only MCP server and a CLI with reads, bulk
  exports, a read-only file download, and seven CLI-only write paths.
- **Configure:** `SLACK_WORKSPACE_URL=https://yourco.slack.com/` (or a 600-mode
  `~/.config/slack-cli/config.json`). `node cli.js whoami` confirms it before any network.
- **Auth:** `node cli.js login` — a visible Chrome opens the workspace URL, you sign in however
  your company does, the session is cached to `~/.slack-cli-auth.json` (mode 600).
- **First read:** `node cli.js channel <name-or-id> --max-pages 1`.
- **Writes:** `send` / `react` / `edit` / `invite` / `add-emoji` — `--dry-run` preview → the human's yes →
  re-run with `--yes`. `upload-file.mjs` — `--yes` only. `create-channel` — a human types the
  channel name back at `/dev/tty`; there is no agent path.
- **The rule:** an agent never passes `--yes` or `--force` on its own. Show the preview, get the
  human's yes, then re-run with the flag. The flag records that a person approved; it does not
  replace them. The safety contract is [SENSIBILITIES.md](../../SENSIBILITIES.md) — #1, #2, #4,
  #6, #7, #11 are the ones this tool lives by.

## What this is

The Slack-CLI approach: one shared engine (`auth.js`, `lib/`) behind two surfaces. The **MCP
server** (`server.js`) exposes only reads, so an agent session holds nothing that can post.
The **CLI** (`cli.js`) has the same reads plus bulk exports and every write, each write tiered
to its blast radius: reversible (`react`, `send`, `edit`, `invite`, `add-emoji`) preview
then confirm at `/dev/tty`, with `--yes` honored once a human has approved the preview;
private-to-you (`upload-file.mjs`) is `--yes` only; irreversible (`create-channel`) requires the
operator to type the channel name back and has no flag at all. Nothing here deletes, kicks,
archives, renames, or joins. Auth is the operator's own browser session — the `xoxc` token
and cookies Slack already gave them — so the tool can do exactly what the operator can do in
the Slack client, and nothing more (SENSIBILITIES #13).

## Configuration

Resolution order for every setting is environment variable, then
`~/.config/slack-cli/config.json`, then the default. The config file must be mode 600 — a
group- or world-readable file is refused, not read.

| Setting | Env | Config key | Default | Meaning |
|---|---|---|---|---|
| Workspace | `SLACK_WORKSPACE_URL` | `workspace_url` | **required** | `https://yourco.slack.com/` or `https://grid-yourco.enterprise.slack.com/`; every API call and the login go through it |
| Enterprise id | `SLACK_ENTERPRISE_ID` | `enterprise_id` | captured at login | the id the Edge API (user/channel search) is addressed by — `E…` org id on Enterprise Grid, `T…` team id otherwise; `auth.test` supplies it at login, so set this only to override |
| Permalink host | `SLACK_PERMALINK_URL` | `permalink_url` | the workspace URL | where `archives/...` links are built; on Grid the API host and the link host differ |
| Off-hours window | `SLACK_BUSINESS_HOURS` | `business_hours` | `06-18` | `HH-HH`, 24-hour, Monday–Friday |
| Window zone | `SLACK_BUSINESS_TZ` | `business_tz` | this machine's zone | an IANA zone such as `America/New_York` |
| Chrome profile | `SLACK_CLI_PROFILE` | — | `~/.slack-cli/` | the SSO session's profile dir |
| Chrome binary | `CHROME_PATH` | — | auto-detected | |
| Proxy CA | `NODE_EXTRA_CA_CERTS` | — | — | augment the trust store; never disable verification |

A missing workspace stops every command with the env var and the file path named, before a
browser opens. `node cli.js whoami` prints the workspace and its source first, so it is the
cheapest "is this configured?" check.

**First run:** `npm install`, set the workspace, `node cli.js login`. Chrome opens the
workspace URL; sign in with whatever your company uses (SSO, MFA, password — the tool only
waits for a tab to reach `app.slack.com`); the window closes itself once the token and
cookies are cached. Any later read that finds the cache missing or rejected re-opens Chrome.

## Commands and their gates

```bash
# identity and pre-flight (no gate)
node cli.js whoami                         # workspace + who you are
node cli.js login                          # force a fresh sign-in
node cli.js probe [channel]                # one-call health check, exit 0/1

# discover channels (no gate)
node cli.js list-channels                  # conversations.list
node cli.js find-channels sre noc ai       # Edge-API keyword discovery
node cli.js channel-toc                    # broad sweep → channel-catalog.json + CHANNELS.md (local, gitignored)

# search and export (-f md|json|csv, --after/--before, -o file)
node cli.js channel <name-or-id> --max-pages 1           # one page; off-hours gate waived for a private channel you're in
node cli.js channel <name-or-id> --after 2025-01-01      # bulk: off-hours gate
node cli.js my-messages --after 2025-01-01               # off-hours gate
node cli.js mentions / reactions / threads               # off-hours gate
node cli.js year-review --year 2025                      # off-hours gate
node cli.js thread <permalink | channel ts>              # one thread, parent + replies (no gate)

# download attachments (read-only GET, no gate)
node cli.js download --url <message-or-file-permalink> -o data/
node cli.js download <channel> --ts <ts> -o data/

# writes — every one is CLI-only
node cli.js send <#channel|@person|C…|U…> --file note.md --dry-run   # preview
node cli.js send <recipient> --file note.md --yes                    # after the human's yes
node cli.js react <channel> <ts> --emoji eyes --dry-run              # then --yes
node cli.js edit <channel> <ts> --append "…" --dry-run               # then --yes
node cli.js invite <channel> <people...> --dry-run                   # then --yes
node cli.js add-emoji <name> <image.png> --dry-run                  # then --yes
node upload-file.mjs <recipient> --file img.png [--thread-ts <ts>] --dry-run   # then --yes
node cli.js create-channel <name> [--private] --dry-run              # prints the command a human runs

# MCP (read-only) — register the server, then restart the client
../../bin/toolbelt register slack          # preview; --write merges into ~/.claude.json

# diagnostics
./diagnose.sh            # macOS/Linux; --reset deletes the session caches
./diagnose.ps1           # Windows;     -Reset
node test.js             # unit tests, no network; --live adds integration tests (needs SLACK_TEST_CHANNEL)
```

| Verb | Tier | Gate | Exit without a TTY and without the flag |
|---|---|---|---|
| reads, `download`, `thread`, `probe`, `whoami`, `login` | read | none | — |
| bulk reads (`my-messages`, `channel` multi-page, `mentions`, `reactions`, `threads`, `year-review`) | read | off-hours window; `--force` overrides with a warning | exit 1 during business hours |
| `send` | write-gated | preview → type `send` at `/dev/tty`; `--yes` after the human approved | exit 2 + the ways forward |
| `react` | write-gated | preview → type `react`; `--yes`; `--remove` is the undo | exit 2 |
| `edit` | write-gated | fetch + diff → type `edit`; `--yes`; backup written first; `--allow-lossy` to drop files/attachments | exit 2 |
| `invite` | write-gated | preview names privacy + each invitee's email → type `invite`; `--yes` | exit 2 |
| `add-emoji` | write-gated | preview checks format, size, name collision → type `emoji`; `--yes`; undo is a human in Customize Workspace | exit 2 |
| `upload-file.mjs` | write-gated | `--yes` only; **no TTY prompt** | exit 0, nothing sent |
| `create-channel` | write-gated | type the channel name back at `/dev/tty`; **no `--yes`, no bypass** | exit 2 + the staged command |
| delete, kick, archive, rename, join | never | no verb exists | — |

### How an agent drives a write

1. Run the verb with `--dry-run`. It resolves the target through the API and prints a preview:
   who really receives it (real name, bot, deactivated), the channel's privacy, the diff, the
   email of each invitee. Nothing is sent.
2. Show the human that preview and ask. A standing instruction that covers the exact action
   (for example "react `:done:` to each message you process") counts as the yes.
3. Re-run with `--yes`. Success prints JSON with `ts` and `permalink`; detect success by that,
   not by prose. Every mutation also emits an `EDIT_AUDIT` / `INVITE_AUDIT` / `REACT_AUDIT`
   stderr line, `add-emoji` an `EMOJI_AUDIT` line, and `create-channel` an `AUDIT` line.

`create-channel` has no step 3 for an agent. Its `--dry-run` prints the exact command; hand that
to the human to run in a real terminal window (not a piped `!` prefix — the typed-echo prompt
needs a controlling terminal). Exit 2 is a missing acknowledgement, not a refusal.

Never call `chat.postMessage`, `chat.update`, `conversations.invite`, `emoji.add`, or `conversations.create`
through `callSlackApi` directly. The identity checks, previews, backups, and audit lines live in
the verbs.

### Facts that change how you write

- **Slack mrkdwn, not Markdown:** `*bold*`, `_italic_`, `~strike~`, `<https://url|label>`,
  bullets as `•` or `-`. `**bold**` renders as literal asterisks. `--dry-run` shows raw text, so
  it will not catch this. Prefer `--file` for anything multi-line.
- `send` takes `#channel`, `@handle`, a display name, or a `C…`/`U…` id; **an email address is
  not a recipient form.** Two or more people open a group DM. `send <U…> --dry-run` doubles as a
  read-only identity resolve (real name, deactivated or not), with nothing sent.
- `send` to a public channel you have not joined fails `not_in_channel` and posts nothing;
  joining is your click in the Slack UI. There is no programmatic join, by design.
- `edit`: prefer `--append` and `--sub` (derived from the current text) over `--text`/`--file`
  (wholesale). `--sub` insists on a unique match unless `--all`. The ts comes from the
  permalink's `p` number with a dot six digits from the end: `p1786726124146599` →
  `1786726124.146599`. A no-op edit exits 0 with `{"ok":true,"unchanged":true}`.
- `invite`: one `conversations.invite` per person; partial success is reported, never rolled
  back; `already_in_channel` counts as success (`alreadyMembers[]`), so a re-run is safe. A
  clean name resolve is not proof of the right person — the email in the preview is.
- `add-emoji`: PNG, GIF or JPEG, at most 128 KB (Slack's limit, checked before any network).
  Slack shows emoji at 128 px at most and usually at 22–32 px, so make a square 128×128 PNG with a
  transparent background: downscale a large render with a filtering resize (Lanczos), never
  nearest-neighbour, unless the art is pixel art on a grid. A name already in `emoji.list` is
  refused before the prompt; `error_name_taken_i18n` means it collides with a standard emoji. A
  workspace that restricts custom emoji to admins refuses the call.
- Private channels usually need the `C…` id rather than `#name` — name resolution for private
  channels depends on `conversations.list`, which may be restricted (below).
- Verify a delivery with `conversations.history`, not the `channel` export: search indexing
  lags and a just-posted message can read as zero results.

## The MCP server

`server.js`, registered as `slack`, stdio transport. Seven tools, all reads:
`read_slack_thread` (a permalink → message + replies), `get_channel_messages`,
`search_slack_channel`, `search_user_messages`, `lookup_user`, `list_my_channels`,
`search_mentions`. There is no write tool and no off-hours gate on this surface; result sizes
are capped in code (10–50 per call). Auth is the same cached session; when Slack rejects it the
server deletes the cache and opens Chrome for a fresh sign-in. A session holding this server
can read your Slack; it cannot post.

## Enterprise Grid

The tool works on a single workspace and on Enterprise Grid; three things differ on Grid.

- **Channel listing may be admin-restricted.** `conversations.list`, `users.conversations`, and
  `conversations.members` can return `enterprise_is_restricted` for a browser token. When they
  do, `list-channels` and `list_my_channels` fail with that code and the keyword-discovery path
  is the fallback: `find-channels <keywords>` and `channel-toc` use the Edge API
  `channels/search`, which is query-driven — a broad sample, not a complete dump. The same
  restriction is why `invite` attempts no membership pre-check anywhere.
- **Creating a channel needs a workspace.** The org-level API fails `cannot_create_channel`
  without a `team_id`; `create-channel` resolves your own workspace from `users.info →
  enterprise_user.teams` and takes `--team <T…>` when you belong to more than one.
- **Two hosts.** The API goes through the org URL you configured
  (`grid-yourco.enterprise.slack.com`); the links people share use the workspace host. Set
  `SLACK_PERMALINK_URL` if you want generated permalinks in the familiar form; both forms
  resolve in Slack.

## Storage

| Path | Mode | Holds |
|---|---|---|
| `~/.config/slack-cli/config.json` | 600 (enforced) | workspace and the optional settings above; no secrets today |
| `~/.slack-cli-auth.json` | 600 | xoxc token + cookies + the workspace host they belong to; ignored if the configured workspace differs |
| `~/.slack-cli/` | dir | Chrome profile with the SSO session (`SLACK_CLI_PROFILE` overrides) |
| `data/` | gitignored | exports, `edit-backups/<channel>-<ts>.json` (600), bulk-pull output |
| `channel-catalog.json`, `CHANNELS.md` | gitignored | the keyword-discovery catalog; regenerate locally, never commit (channel names and topics carry incidental PII) |

Revoke: `./diagnose.sh --reset` removes both session caches; sign out of Slack in the browser to
invalidate the token server-side. No verb prints the token; diagnostics report path and mode.

## Known limitations

- **No message delete.** An accidental post is edited down with `edit`, not removed. A delete
  verb would be strictly more destructive than `edit` (nothing to back up to) and would need
  its own gate.
- **No channel management beyond create and invite.** Archive, rename, kick, set-purpose on an
  existing channel have no verb; the post-create `setPurpose`/`setTopic`/`inviteMembers` run only
  inside `create-channel`. `invite` can add someone and nothing here removes them.
- **The `/dev/tty` gates need a Unix controlling terminal.** On Windows, `openSync('/dev/tty')`
  fails, so the gated verbs behave as if no TTY exists: exit 2 with the `--yes` path for
  `send`/`react`/`edit`/`invite`, and no path at all for `create-channel` (use the Slack UI).
- **Edge API addressing is learned, not documented.** The user/channel search service is an
  undocumented Slack internal keyed by the org or team id captured from `auth.test` at login; on
  a single (non-Grid) workspace that id is the `T…` team id. If discovery fails with a plain
  Edge error, pin `SLACK_ENTERPRISE_ID`.
- **Search `from:` takes the account's username**, not its `U…` id; `resolveUsername()` maps a
  display name to it. Companies that provision usernames as employee numbers see digits there.
- **Long messages split.** Slack expands bare emails to `mailto:` links, so a message under the
  limit can post as two.
- Rate limits: HTTP 429 and `ratelimited` are retried with `Retry-After` capped at 60 s, three
  attempts; `probe`'s JSON reports `rateLimited` so bulk scripts can stop early.
