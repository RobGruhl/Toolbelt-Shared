# Playwright CLI Configuration

## Config File

Playwright CLI loads `.playwright/cli.config.json` from the current directory by default. hp runs every call from the tool dir and pins `--config` to that file, so the vendored config (`isolated: true`, channel chrome, headless, no `cdpEndpoint`, no `userDataDir`) always applies.

**Through hp none of the overrides on this page is reachable.** `hp … --config=…`, `--persistent` and `--profile` exit 2 before anything runs, and every `PLAYWRIGHT_MCP_*` / `PLAYWRIGHT_CLI_*` environment variable is stripped from the child process. In particular `browser.cdpEndpoint`, `browser.remoteEndpoint`, `browser.userDataDir` and `browser.isolated: false` — each of which would point a "read" verb at a real, signed-in profile — can only be expressed by running `playwright-cli` directly, outside the belt's gates; the gated route to a real profile is `hp connect`. The rest of this page documents the upstream CLI for reference:

```bash
playwright-cli --config path/to/config.json open example.com   # upstream only; refused by hp
```

## Config Schema

```json
{
  "browser": {
    "browserName": "chromium",
    "isolated": false,
    "userDataDir": "/path/to/profile",
    "launchOptions": {
      "headless": true,
      "channel": "chrome"
    },
    "contextOptions": {
      "viewport": { "width": 1280, "height": 720 }
    },
    "cdpEndpoint": "http://localhost:9222",
    "remoteEndpoint": "ws://...",
    "initScript": ["path/to/script.js"]
  },
  "outputDir": "output",
  "outputMode": "stdout",
  "console": {
    "level": "info"
  },
  "network": {
    "allowedOrigins": ["https://example.com"],
    "blockedOrigins": ["https://ads.example.com"]
  },
  "testIdAttribute": "data-testid",
  "timeouts": {
    "action": 5000,
    "navigation": 60000
  },
  "codegen": "typescript",
  "saveVideo": {
    "width": 800,
    "height": 600
  }
}
```

## Key Options

| Option | Default | Description |
|--------|---------|-------------|
| `browser.browserName` | `chromium` | Browser engine: chromium, firefox, webkit |
| `browser.isolated` | `false` | Keep profile in memory only (no disk persistence) |
| `browser.userDataDir` | temp dir | Path for persistent browser profile |
| `browser.launchOptions.headless` | `true` | Run without GUI |
| `browser.launchOptions.channel` | — | Browser channel: chrome, msedge |
| `outputDir` | `.` | Directory for screenshots, PDFs, traces |
| `outputMode` | `stdout` | `stdout` or `file` for snapshots/logs |
| `timeouts.action` | `5000` | Default action timeout (ms) |
| `timeouts.navigation` | `60000` | Default navigation timeout (ms) |
| `testIdAttribute` | `data-testid` | Attribute for test ID selectors |
| `codegen` | `typescript` | Language for code generation: typescript, none |

## Environment Variables

All config options have env var equivalents prefixed with `PLAYWRIGHT_MCP_`. hp removes all of them (and `PLAYWRIGHT_CLI_*`, `PWTEST_*`) from the child environment; set `HP_HOME` / `PLAYWRIGHT_OUTPUT_DIR` / `CHROME_PATH` for hp instead:

| Variable | Description |
|----------|-------------|
| `PLAYWRIGHT_CLI_SESSION` | Default session name |
| `PLAYWRIGHT_MCP_BROWSER` | Browser: chrome, firefox, webkit, msedge |
| `PLAYWRIGHT_MCP_HEADLESS` | Run headless |
| `PLAYWRIGHT_MCP_VIEWPORT_SIZE` | Viewport: "1280x720" |
| `PLAYWRIGHT_MCP_OUTPUT_DIR` | Output directory |
| `PLAYWRIGHT_MCP_OUTPUT_MODE` | stdout or file |
| `PLAYWRIGHT_MCP_TIMEOUT_ACTION` | Action timeout (ms) |
| `PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION` | Navigation timeout (ms) |
| `PLAYWRIGHT_MCP_ISOLATED` | Memory-only profile |
| `PLAYWRIGHT_MCP_USER_DATA_DIR` | Profile persistence path |
| `PLAYWRIGHT_MCP_EXECUTABLE_PATH` | Custom browser binary |
| `PLAYWRIGHT_MCP_PROXY_SERVER` | Proxy: "http://proxy:3128" |
| `PLAYWRIGHT_MCP_DEVICE` | Emulate device: "iPhone 15" |
| `PLAYWRIGHT_MCP_USER_AGENT` | Custom user agent |
| `PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS` | Ignore HTTPS errors |
| `PLAYWRIGHT_MCP_NO_SANDBOX` | Disable sandbox |

## Minimal Config

For most use cases, the defaults work. A minimal config:

```json
{
  "browser": {
    "browserName": "chromium"
  },
  "outputDir": "output",
  "outputMode": "stdout"
}
```
