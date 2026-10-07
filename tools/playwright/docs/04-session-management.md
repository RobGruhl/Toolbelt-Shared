# Session Management

## How Sessions Work

Playwright CLI keeps each browser instance in a named session. Sessions are isolated — cookies, localStorage, and page state are separate per session.

By default (no `-s=` flag), commands use the "default" session.

## Named Sessions

```bash
# Open different sites in different sessions
playwright-cli -s=project-a open https://app1.example.com
playwright-cli -s=project-b open https://app2.example.com

# Commands go to the correct session
playwright-cli -s=project-a snapshot    # snapshots app1
playwright-cli -s=project-b click e5    # clicks in app2
```

## Session via Environment Variable

Set `PLAYWRIGHT_CLI_SESSION` to avoid passing `-s=` every time:

```bash
export PLAYWRIGHT_CLI_SESSION=my-project
playwright-cli open https://example.com   # uses "my-project" session
```

Useful when running a coding agent:

```bash
PLAYWRIGHT_CLI_SESSION=todo-app claude .
```

## Persistence

By default, browser profiles are in-memory. Cookies and storage survive between CLI calls within a session, but are lost when the browser closes.

For persistence across browser restarts:

> `--persistent` and `--profile` below are upstream `playwright-cli` options; hp refuses them (exit 2). Through hp, state that must outlive a session lives in a `launch-debug` profile or a `state-save` file under the output dir.

```bash
playwright-cli open https://example.com --persistent
```

This saves the profile to disk. Combined with named sessions:

```bash
playwright-cli -s=auth open https://app.com --persistent
# ... login flow ...
playwright-cli -s=auth close
# Later, profile is restored:
playwright-cli -s=auth open https://app.com --persistent
```

## Storage State

Save/restore cookies + localStorage + sessionStorage:

```bash
playwright-cli state-save auth-state.json
# ... close, restart, whatever ...
playwright-cli state-load auth-state.json
```

This is portable — you can save state from one session and load it in another.

## Managing Sessions

```bash
playwright-cli list                     # list all active sessions
playwright-cli close                    # close current session's browser
playwright-cli -s=name close            # close specific session
playwright-cli close-all                # close all browsers
playwright-cli kill-all                 # forcefully kill all browser processes
playwright-cli delete-data              # delete user data for default session
playwright-cli -s=name delete-data      # delete data for named session
```

## Monitoring Dashboard

Open a visual dashboard to see all running sessions:

```bash
playwright-cli show
```

Shows a grid of all active sessions with live screencasts. Click a session to zoom in and take over control.

## Session Patterns

### One session per project
```bash
PLAYWRIGHT_CLI_SESSION=hello-playwright claude .
```

### Parallel testing
```bash
playwright-cli -s=test-1 open https://app.com/feature-a
playwright-cli -s=test-2 open https://app.com/feature-b
# Run tests in parallel across sessions
```

### Auth persistence
```bash
playwright-cli -s=auth open https://app.com --persistent
# Login once, state survives across restarts
```

### Clean slate
```bash
playwright-cli -s=clean open https://app.com
# Memory-only, no state leaks between runs
playwright-cli -s=clean close
```
