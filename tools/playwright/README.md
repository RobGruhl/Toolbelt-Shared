# playwright (`hp`)

Token-cheap browser automation for coding agents, over the locally installed
[`@playwright/cli`](https://github.com/microsoft/playwright-cli). A snapshot is an accessibility
tree with element refs (≈200 tokens), not a screenshot. The agent contract — gates, exit codes,
what attaching to a real Chrome exposes — is [CLAUDE.md](CLAUDE.md).

## Quick start

```bash
npm install                                  # @playwright/cli + playwright-core, local only
node hp.mjs open https://example.com         # isolated, headless, in-memory profile
node hp.mjs snapshot                         # refs: e1, e5, …
node hp.mjs click e5
node hp.mjs screenshot --filename=page.png   # → output/page.png
node hp.mjs close
```

No API key. Google Chrome must be installed (`brew install --cask google-chrome`).

## Two browser classes

| | isolated (default) | attached (`connect`) |
|---|---|---|
| Profile | empty, in memory, dies on `close` | a running Chrome: your real logins, all at once |
| Page actions and navigations (`goto`, `reload`, …) | free | `--attached-writes` per call, audited; `open` refused (`close` detaches) |
| How you get it | `hp open` | `hp connect -s <n> --cdp=chrome` after typing the target at `/dev/tty` (headless callers stage for `toolbelt approve playwright <code>`) |
| Middle ground | `hp launch-debug` → `hp connect --cdp=http://127.0.0.1:9222`: Chrome on a tool-owned profile you log into once; attaches ungated, page actions still need `--attached-writes` | |

## Library

```js
import { open, snapshot, click, fill, screenshot, close } from './lib/playwright.js';
open('https://example.com', { session: 'job' });
const refs = snapshot({ session: 'job' });
click('e5', { session: 'job' });
screenshot(undefined, { session: 'job', filename: 'page.png' });   // output/page.png
close({ session: 'job' });
```

Every function spawns `hp.mjs`, so the same gates apply; a non-zero exit throws.

## Examples

| # | File | What |
|---|------|------|
| 01 | `basic-navigation.js` | Open URL, take screenshot |
| 02 | `form-interaction.js` | Fill form, type, press Enter |
| 03 | `session-management.js` | Named sessions, parallel browsers |
| 04 | `snapshot-and-refs.js` | Accessibility tree, element refs |
| 05 | `network-mocking.js` | Route mocking for testing |
| 06 | `multi-tab.js` | Tab management |
| 07 | `screenshot-pdf.js` | Screenshots and PDF export |
| 08 | `auth-flow.js` | Login and storage-state save/load |

## Docs

- [CLI Reference](docs/01-cli-reference.md) · [CLI vs MCP](docs/02-cli-vs-mcp.md) ·
  [Configuration](docs/03-configuration.md) · [Session Management](docs/04-session-management.md)
