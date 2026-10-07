# Credentials, per entry

Every credential in the belt is the operator's own and lives **outside the tree** (SENSIBILITIES #11).
The table below is rendered from each manifest's `env[]` and `auth` block
(`bin/toolbelt creds --write`; `--check` fails on drift). A tool's own `CLAUDE.md` holds the quirks.

## Where a key goes

Tools resolve a key in this order and stop at the first hit; set exactly one.

1. **The environment variable** the table names — for a shell session or CI.
2. **The macOS Keychain**, where the tool supports it: a generic password whose *service* is the
   env var name, account `$USER`. `security add-generic-password -s NAME -a "$USER" -w` prompts for
   the value so it never lands in shell history.
3. **`~/.config/toolbelt/<tool>.key` or `<tool>.env`**, mode 600 — the portable default. Tools
   refuse a group- or world-readable file rather than read it.
4. **`tools/<tool>/.env`**, only where the table lists it: gitignored, mode 600, a fallback the
   operator chose. `.env.example` beside it is the template; the real `.env` is never committed.

## Before asking the operator for a key

Look for one they already have, and report where it is — never its value:

- `bin/toolbelt doctor <tool>` names the store it found, or each one it tried.
- `security dump-keychain | grep -i '"svce"' | grep -i <vendor>` lists Keychain item *names*;
  a key saved by an older project may sit under a different service name (the lowercase
  `elevenlabs-api-key` is one the elevenlabs tool also accepts).
- `grep -rlI <ENV_VAR> ~/Projects --include='.env*'` finds project `.env` files by name only.

A key found somewhere the tool does not read is moved by the operator, or the tool learns the
extra location in code and in its manifest — never by pasting the value into a chat or a command
line.

<!-- creds-table:begin — derived from toolbelt.json manifests; edit env[]/auth there, then bin/toolbelt creds --write -->
| Entry | Secret env var(s) | Stored in (first found wins) | Put it there | Prove it works |
|---|---|---|---|---|
| `tools/codex-fleet` | `OPENAI_API_KEY` | `~/.codex/auth.json` (vendor, derived) | codex login | `codex login status` |
| `tools/elevenlabs` | `ELEVENLABS_API_KEY` | `Keychain: ELEVENLABS_API_KEY, else elevenlabs-api-key` (keychain, static); `~/.config/toolbelt/elevenlabs.env` (file, static) | security add-generic-password -s ELEVENLABS_API_KEY -a "$USER" -w   (then paste the key at the prompt) | `poetry run agent-voice status` |
| `tools/example-readonly` | `GITHUB_TOKEN` | `~/.config/exr/token` (file, static) | Create a fine-grained personal access token in GitHub (Settings > Developer settings) with no write permissions; export GITHUB_TOKEN or write it to ~/.config/exr/token (chmod 600) | `node exr.mjs repo octocat/Hello-World --explain` |
| `tools/firecrawl` | `FIRECRAWL_API_KEY` | `~/.config/toolbelt/firecrawl.key` (file, static) | Create a key at https://www.firecrawl.dev (API Keys), then: security add-generic-password -s toolbelt-firecrawl -a "$USER" -w   (or write it to ~/.config/toolbelt/firecrawl.key and chmod 600) | `node fc.mjs status --live` |
| `tools/gmail-harvest` | `GOOGLE_OAUTH_CLIENT_SECRET` | `~/.config/toolbelt/gmail-harvest/<account>.json` (file, derived); `keychain: generic-password service=google-workspace-oauth` (keychain, static) | node gmh.mjs auth --account <you@example.com>   (interactive browser consent; 5-minute wait) | `node gmh.mjs status   (account, scope, expiry, mode — never a token value; no network)` |
| `tools/hot-bag` | `WIFI_PASSWORD` | env only | — | `id -un` |
| `tools/nordvpn` | `NORD_USER`, `NORD_PASS` | `~/.config/toolbelt/nordvpn.env` (file, static); `~/.config/toolbelt/nordvpn/configs/` (file, static); `~/Library/Application Support/Tunnelblick/Configurations/` (vendor, static) | security add-generic-password -s toolbelt-nordvpn -a NORD_USER -w <username> && security add-generic-password -s toolbelt-nordvpn -a NORD_PASS -w <password> | `poetry run nordvpn setup` |
| `tools/openai-image` | `OPENAI_API_KEY` | `~/.config/toolbelt/openai-image.key` (file, static) | Create a key at https://platform.openai.com/api-keys in a verified organization, then: mkdir -p ~/.config/toolbelt && umask 077 && printf '%s\n' 'sk-…' > ~/.config/toolbelt/openai-image.key | `bin/toolbelt doctor openai-image` |
| `tools/oracle` | `OPENAI_API_KEY` | `Keychain: generic password, service OPENAI_API_KEY` (keychain, static) | security add-generic-password -s OPENAI_API_KEY -a "$USER" -w   # or export OPENAI_API_KEY in the shell | `bin/toolbelt doctor oracle` |
| `tools/outlook-harvest` | — | `~/.config/toolbelt/outlook-harvest/<account>.json` (file, derived); `~/.config/toolbelt/outlook-harvest/client.json` (file, static) | node omh.mjs auth --client-id <GUID>   (device code; waits up to the code's lifetime) | `node omh.mjs status   (account, scope, expiry, mode — never a token value; no network)` |
| `tools/perplexity` | `PERPLEXITY_API_KEY` | `~/.config/toolbelt/perplexity.key` (file, static) | Create a key at https://www.perplexity.ai/settings/api, then: export PERPLEXITY_API_KEY=pplx-… — or: mkdir -p ~/.config/toolbelt && printf '%s\n' pplx-… > ~/.config/toolbelt/perplexity.key && chmod 600 ~/.config/toolbelt/perplexity.key | `node pplx.mjs search ping --explain` |
| `tools/playwright` | — | `~/.cache/hello-playwright/profiles/` (file, session); `~/.cache/hello-playwright/launched/` (file, session) | — | `bin/toolbelt doctor playwright` |
| `tools/runway-ai` | `RUNWAYML_API_SECRET` | `~/.config/toolbelt/runway-ai.key` (file, static); `tools/runway-ai/.env` (file, static) | Create a key at https://dev.runwayml.com → API Keys, then either put RUNWAYML_API_SECRET=key_… in tools/runway-ai/.env (chmod 600) or: mkdir -p ~/.config/toolbelt && umask 077 && printf '%s\n' 'key_…' > ~/.config/toolbelt/runway-ai.key | `node rwy.mjs balance` |
| `tools/slack` | — | `~/.slack-cli-auth.json` (file, session); `~/.slack-cli/` (file, session) | node cli.js login | `node cli.js whoami` |
| `tools/transcription` | `OPENAI_API_KEY` | `~/.config/toolbelt/transcription.key` (file, static) | security add-generic-password -s OPENAI_API_KEY -a "$USER" -w   (prompts for the key; or export OPENAI_API_KEY) | `poetry run transcribe check` |
| `tools/video-rename` | `ANTHROPIC_API_KEY` | `~/.config/toolbelt/video-rename.env` (file, static) | Create a key at console.anthropic.com, then: printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > ~/.config/toolbelt/video-rename.env && chmod 600 ~/.config/toolbelt/video-rename.env | `poetry run video-rename analyze tests/fixtures/tiny.mp4 --explain   (prints which key source is in use, never the key)` |
| `connectors/example-mcp` | — | — | toolbelt register example-mcp --write   (interactive; the client completes the server's OAuth on first use) | `bin/toolbelt doctor example-mcp` |
| `connectors/google-workspace` | `GOOGLE_OAUTH_CLIENT_SECRET` | `~/.google_workspace_mcp/credentials/` (vendor, derived); `keychain: generic-password service=google-workspace-oauth` (keychain, static) | Call any mcp__google-workspace__* read in-session (e.g. list_calendars) — a browser consent page opens; tick EVERY scope checkbox or the grant fails with "Scope has changed" | `ls ~/.google_workspace_mcp/credentials/   (one <account>.json per granted account; never cat it — it holds the refresh token and the client secret)` |
<!-- creds-table:end -->
