# playwright (`hp`) — the agent contract

## Read first

- **What:** token-cheap browser automation. `hp` wraps the locally installed `@playwright/cli`
  (≈200 tokens per step: a snapshot is an accessibility tree with `e5`-style refs, not pixels).
  Two browser classes: the **isolated** in-memory profile every session gets by default, and an
  **attached** running Chrome reached over CDP, which is the operator's real, signed-in browser.
- **Auth:** none of its own. `npm install` in this dir (`toolbelt setup playwright`), Google
  Chrome present. No key, no login verb. `bin/toolbelt doctor playwright` says whether it is live.
- **First read:** `node hp.mjs open https://example.com && node hp.mjs snapshot`
- **Writes:** page actions (`click`, `fill`, `type`, `eval`, …) and navigations (`open`, `goto`,
  `reload`, `go-back`, `go-forward`) run free on the isolated profile.
  `connect -s <name> --cdp=chrome` (any real profile) is a typed-echo gate at `/dev/tty`; from
  your process it stages and prints `toolbelt approve playwright <code>` — hand that to the
  user. On an attached real profile every page action also needs `--attached-writes`.
- **The rule:** never pass `--attached-writes` or `--remote-ok` on your own. They record that a
  person approved a specific action; they do not replace one. A standing instruction that names
  the exact action counts as the yes. `--config`, `--persistent`, `--profile` (outside
  `launch-debug`), `--cdp`/`--endpoint`/`--extension` (outside `connect`) and `--session` are
  exit 2 on every verb, and so are every single-character flag (`--s=real` is upstream's
  `--session=real`; `--g`, `--h`, `--v` likewise) and any dash-led positional, including after
  `--` and negative numbers (upstream's parser reads `-s=real` and `-1` there as options):
  there is no argv route to another profile, browser or session.

```bash
node hp.mjs open https://example.com                 # isolated, headless; --headed to watch
node hp.mjs snapshot                                 # refs for the next step
node hp.mjs click e5 / fill e10 "text" / press Enter
node hp.mjs screenshot --filename=page.png           # → output/page.png (only place files land)
node hp.mjs pdf --filename=page.pdf
node hp.mjs console / network / tab-list
node hp.mjs -s=job2 open https://…                   # named session = separate browser
node hp.mjs close [-s=job2]
node hp.mjs status                                   # what is attached, what hp launched
```

Exit codes: `0` done or previewed · `1` failed or declined · `2` usage, gate missing, or a
refused path · `3` staged, waiting for a human · `4` a gate needed a terminal and had none.
Every verb takes `--explain`: the plan, nothing run.

## Why the isolated profile is the default

The real Chrome profile carries every logged-in session the operator has — mail, code hosting,
banking, work SSO — and CDP has no per-site permission: once attached, `fill`, `click` and
`eval` are authenticated actions under the operator's name on whichever site a tab shows, and
the page content itself is untrusted input that can steer an agent. Chrome's own reason for
ignoring `--remote-debugging-port` on the default user-data-dir (Chrome ≥ 136) is exactly
cookie theft over that port. So: the empty, anonymous profile is free; reaching a real one is a
separate verb a human completes.

## Attaching to a running Chrome (CDP)

| Route | Who consents | Profile class | Gate |
|---|---|---|---|
| `hp launch-debug [--port 9222] [--profile <name>]` then `hp connect -s <n> --cdp=http://127.0.0.1:9222` | nobody needed | tool-owned profile under `~/.cache/hello-playwright/profiles/<name>` | none on the attach; audited; page actions still need `--attached-writes` |
| `hp connect -s <n> --cdp=chrome` (or `msedge`) | the human first enables `chrome://inspect/#remote-debugging` in that browser | **real** | type `chrome` back at `/dev/tty`; staged otherwise |
| `hp connect -s <n> --cdp=<loopback url>` hp did not launch | whoever opened that port | **real** | typed echo of the URL; staged otherwise |
| `hp connect -s <n> --extension[=chrome]` | the Playwright MCP Bridge extension's per-tab popup, *and* the typed echo | **real** | typed echo; staged otherwise |
| a non-loopback `--cdp`/`--endpoint` | — | refused | `--remote-ok` widens; still gated |

`launch-debug` exists so the common need — "log in once by hand, then drive it headless" — never
touches the real profile: it opens Chrome headed on a tool-owned user-data-dir, waits for
`/json/version`, prints the endpoint and records the pid. Sign in there; it persists across
launches under that profile name. A `--profile` is a *name*, one path segment; a path is a
usage error, which is what keeps the default user-data-dir out by construction.

What the gate shows before asking: the target, that every signed-in site becomes reachable at
once, why no flag can stand in for the typed word, what yes and no each do, and the
`chrome://inspect` precondition. The typed word is the target itself (`chrome`, or the URL) —
`yes`, `y` and Enter abort. There is no `--yes`/`--force` on `connect`; both are usage errors.

Attached, the surface splits:

- free: `snapshot`, `screenshot`, `pdf`, `console`, `network`, `tab-list`, the `*-list`/`*-get`
  storage reads. `cookie-list`/`cookie-get`/`state-save` on a real profile print or save real
  session credentials — treat that output as a secret, never paste it into a chat or a commit.
- `--attached-writes` per call (bare; `--attached-writes=false` is a usage error): every page
  action and every navigation — `goto`, `reload`, `go-back`, `go-forward` — because a GET
  under the operator's cookies (logout, unsubscribe, OAuth consent, an admin URL) is as
  authenticated as a click. `open` on an attached session is refused even with the flag:
  upstream would stop that session to start a fresh browser, which is a silent detach; run
  `hp close -s <n>` (audited) or open under another name. Exit 2 names the endpoint and the flag.
  Each approved call writes an audit line. Right before each page action hp asks
  `playwright-cli list --json` — the registry the action itself runs against, keyed to this
  directory under the OS cache dir, outside `HP_HOME` — whether the session is attached. Every
  attached session is gated, a Chrome `launch-debug` opened included: upstream records no
  endpoint, and `HP_HOME` is writable by whoever runs hp, so no record hp keeps can prove
  which browser a session is on and none is allowed to narrow the gate (`sessions.json` only
  labels the endpoint in `status` and audit lines). `PWTEST_*`, which moves playwright-cli's
  registry, is stripped from the child. If `list` fails, the action exits 2 and `hp status`
  shows why. One extra playwright-cli call per page action is the cost.
- `hp close -s <n>` detaches (when playwright-cli reports the session attached) and leaves
  the external browser running. It quits only a Chrome
  `launch-debug` started (`hp close --port N` for one nothing is attached to).

`connect` and `approve` are CLI-only and on no MCP surface. Configuration cannot attach
silently: `.playwright/cli.config.json` carries no `cdpEndpoint` or `userDataDir`, hp pins
`--config` to that file on `open`/`attach`, refuses a caller's `--config`/`--persistent`/
`--profile`, and strips every `PLAYWRIGHT_MCP_*`/`PLAYWRIGHT_CLI_*`/`PWTEST_*` variable (the
upstream CLI reads `PLAYWRIGHT_MCP_CDP_ENDPOINT`, `_USER_DATA_DIR`, `_ISOLATED`, `_CONFIG`,
`_EXTENSION`, and `PWTEST_DAEMON_SESSION_DIR` for its registry) from the child environment. The upstream docs under `docs/` describe those keys; none is reachable
through hp.

## The staged attach

Headless, a real-profile `connect` writes `~/.cache/hello-playwright/pending/<code>.json`
(dir 700, file 600, the target and session name only, 15-minute expiry) and exits 3:

```
staged — confirm with: toolbelt approve playwright k3x9q2
```

Give the user that line. At a real terminal it shows the same text the gate would, takes the
typed target, attaches once and deletes the record. Do not retry `connect`, do not read the
pending file to "confirm" it yourself, do not ask for the confirmation in chat. `approve --list`
shows what is pending; `--discard <code>` drops one.

## Ceilings, files, audit

| Constant (`hp.mjs`) | Value | Effect |
|---|---|---|
| `EXEC_TIMEOUT_MS` | 60 000 | one `playwright-cli` invocation; a hang exits 1 |
| `LAUNCH_WAIT_MS` | 15 000 | `launch-debug` kills Chrome and exits 1 if `/json/version` never answers |
| `PENDING_TTL_S` | 900 | a staged connect expires; pruned on every touch |

Files: every `--filename` (`screenshot`, `pdf`, `snapshot`, `state-save`) resolves under
`PLAYWRIGHT_OUTPUT_DIR` (default `tools/playwright/output/`, gitignored). Absolute paths and
`..` are exit 2 before anything runs. The default snapshot/screenshot names the upstream CLI
picks also land there.

Audit: `[hp audit] <iso> verb=… session=… endpoint=… profile=… result=…` to stderr and
`~/.cache/hello-playwright/audit.log` (600) on `connect`, detach, `launch-debug`, quitting a
launched Chrome, and each `--attached-writes` action. Never page content or cookie values.
"What did the agent do in my real browser on Tuesday" is `grep profile=real`.

## Library

`lib/playwright.js` exports one function per verb (`open`, `snapshot`, `click`, `fill`,
`screenshot`, `pdf`, `connect`, `launchDebug`, `close`, …). Each spawns `hp.mjs` in a child
process, so every gate and exit code above applies unchanged; a non-zero exit throws with
`.status`. `attachedWrites: true` in the options is the library form of the flag and carries the
same rule. `examples/01–08` are runnable walkthroughs (`node examples/01-basic-navigation.js`).

## Quirks

- **Refs come from the last snapshot** and change when the page does; snapshot again after any
  navigation before clicking.
- `type` goes to the focused element; `fill` takes a ref and clears the field first.
- Sessions are in-memory: cookies survive between calls and die on `close`. Persist state only
  through `launch-debug` profiles or a `state-save` file under the output dir, and remember the
  latter is a credential.
- `-s=<name>` is the session; hp always passes it explicitly, refuses `--session` and any
  `-s`/`--x` token smuggled as a positional (even after `--`), and strips
  `PLAYWRIGHT_CLI_SESSION` from the child so nothing can redirect a call to an attached session.
- `playwright-cli` is the `node_modules/.bin` copy, run from this directory, with the config in
  `.playwright/cli.config.json` (`isolated: true`, channel `chrome`, headless). A global
  `playwright-cli` on PATH is not used; older builds lack `attach`.
- Attaching over CDP is Chromium-only and lower fidelity than a Playwright-launched browser:
  some emulation and route interception do not work on a browser Chrome launched with its own
  flags.
- `kill-all`, `delete-data`, `show`, `devtools`, tracing and video are not reachable through hp.

## `output/` can hold private page content

Snapshots (`page-*.yml`), console logs and screenshots record what the page showed. On pages
opened from a personal link (unsubscribe, account or order pages) that includes the person's
address, names and URL tokens. When a session touched personal pages, move those files out of
the belt into the operator's private directory once the task is done (2026-09-28: an
unsubscribe run left the address and tokens in `output/`).
