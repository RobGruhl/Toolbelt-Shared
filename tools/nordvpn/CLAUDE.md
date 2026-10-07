# nordvpn — the agent contract

## Read first

- **What:** NordVPN on this Mac, driven through Tunnelblick (OpenVPN) by AppleScript. No
  sudo, no NordVPN app. macOS only.
- **Auth:** NordVPN *service* credentials (the manual-configuration page on the NordVPN
  dashboard, not the account password). Resolution order: `NORD_USER`/`NORD_PASS` in the
  environment → `~/.config/toolbelt/nordvpn.env` (mode 600, refused otherwise) → Keychain
  items `toolbelt-nordvpn` / `NORD_USER` + `NORD_PASS` → `tools/nordvpn/.env` (deprecated,
  warned). Only `connect` needs them; the server API is public.
- **First read:** `poetry run nordvpn status --local`
- **Writes:** `connect` and `disconnect`. Both preview and exit 0 until re-run with `--yes`.
  Both append an audit line to `data/audit.log`.
- **The rule:** run the bare verb, show the user the preview, and add `--yes` only when the
  user asked for that connection (or has a standing instruction that names it). The flag is
  always honored by the code; the contract, not the code, is what keeps it a human's decision.
- **Live here?** `bin/toolbelt doctor nordvpn`.

## Commands

```bash
poetry run nordvpn status [--local]            # tunnel state; --local skips the IP lookups
poetry run nordvpn servers -c US [-l 20]       # recommended servers, lowest load first (max 50)
poetry run nordvpn countries
poetry run nordvpn configs                     # what Tunnelblick has installed
poetry run nordvpn setup                       # pre-flight: Tunnelblick, credentials, API

poetry run nordvpn connect -c US               # preview: server, install needed?, undo
poetry run nordvpn connect -c GB --city London # prefer a city; falls back to the country
poetry run nordvpn connect -s us5090 --yes     # do it (hostname or FQDN)
poetry run nordvpn disconnect                  # preview
poetry run nordvpn disconnect --yes            # do it
```

Exit codes: `0` done or previewed · `1` Tunnelblick, credential, network, or connection
failure · `2` usage (missing target, bad country code or hostname, `--limit` over the ceiling).

| Verb | Tier | Gate | Without `--yes` |
|---|---|---|---|
| `status`, `servers`, `countries`, `configs`, `setup` | read | none | — |
| `connect` | write-gated | `--yes` | prints the preview, exit 0, nothing changed |
| `disconnect` | write-gated | `--yes` | prints the preview, exit 0, nothing changed |
| account, billing, server-side changes, deleting a configuration | never | no verb exists | — |

The tier is `flag`, not `/dev/tty`: the tunnel is this machine's own and `disconnect --yes`
undoes `connect --yes`, so refusing a deliberate call would only push the operator to click
Tunnelblick by hand with no audit line (SENSIBILITIES #2). There is no staged/approve path
because there is nothing a human needs to see that the preview does not already show.

## What `connect --yes` does

1. Resolves the credentials (before the preview too, so a missing or loose store fails the
   same way in both). Values are never printed; the preview names the *source*.
2. Picks the server: `--server` as given, or the NordVPN recommendations endpoint for the
   country (first server at or under 30% load, else the lowest), narrowed to `--city` when one
   matches.
3. If Tunnelblick has no `<host>.nordvpn.com.udp` configuration: downloads the `.ovpn` from
   `downloads.nordcdn.com`, writes a `.tblk` bundle with a 600-mode `.pass` file holding the
   credentials under `~/.config/toolbelt/nordvpn/configs/` (700), and `open`s it. **Tunnelblick
   shows its own import dialog**, and the first time ever a helper-tool install prompt; macOS
   also asks once to allow automation of Tunnelblick. None of these can be answered from a
   pipeline. Audit line: `verb=install-config`.
4. Tells Tunnelblick to connect and polls up to `CONNECT_TIMEOUT_S` (30 s). A timeout exits 1
   but the tunnel may still come up; `status --local` settles it. Audit line: `verb=connect`.
5. Reads the state back and prints the public IP (the write returning is a claim; the read is
   the evidence).

`disconnect --yes` sends `disconnect all` to Tunnelblick, waits a second, and reports whether
the state reached DISCONNECTED. Audit line: `verb=disconnect`.

## Ceilings and pre-flight

Constants at the top of `nordvpn/cli.py` (SENSIBILITIES #3 — raising one is a diff):

| Constant | Value | Effect |
|---|---|---|
| `MAX_LIMIT` | 50 | `servers --limit` above it exits 2 naming the constant; never silently lowered |
| `DEFAULT_LIMIT` | 10 | `servers` without `--limit` |
| `CONNECT_TIMEOUT_S` | 30 | how long `connect --yes` waits for CONNECTED |

The bare `connect` / `disconnect` is the dry-run. `setup` is the capability probe: Tunnelblick
present and running, credentials resolvable (source named, values not), one API read.

## Audit trail

```
[nordvpn audit] 2026-08-22T17:04:11Z verb=connect target=us5090.nordvpn.com.udp result=connected
```

To stderr and appended to `tools/nordvpn/data/audit.log` (file 600, dir 700, gitignored;
`NORDVPN_AUDIT_FILE` relocates it). Verbs: `install-config`, `connect`, `disconnect`. Never a
credential. `grep verb=connect data/audit.log` answers "when did the agent move my traffic".

## Storage

| Path | Mode | Holds |
|---|---|---|
| `~/.config/toolbelt/nordvpn.env` | 600 (enforced) | `NORD_USER` / `NORD_PASS`, optional |
| Keychain `toolbelt-nordvpn` | — | the same two values as generic-password items, optional |
| `~/.config/toolbelt/nordvpn/configs/` | 700 | staged `.ovpn` and `.tblk` bundles; each bundle's `.pass` (600) carries the credentials |
| `~/Library/Application Support/Tunnelblick/Configurations/` | Tunnelblick's | its copy of every imported bundle |
| `tools/nordvpn/data/audit.log` | 600 | the audit trail |

Revoke: regenerate the service credentials on the NordVPN dashboard, then delete the file or
Keychain items, `rm -rf ~/.config/toolbelt/nordvpn/configs`, and remove the configurations in
Tunnelblick's VPN Details window — the tool has no delete verb for them.

## Quirks

- **`status` without `--local` is egress.** It fetches the public IP from `api.ipify.org`
  and looks it up at `ipinfo.io`; both are third parties that learn your IP. `--local` answers
  from Tunnelblick alone. Either way `status` never launches Tunnelblick: not running reads
  as "no VPN is up (degraded)".
- **Reads talk to Tunnelblick by AppleScript.** The first call triggers macOS's automation
  permission dialog; until it is allowed, `status --local` reports `Unknown`. `configs` and
  the connected-state read return nothing useful while Tunnelblick is not running.
- **Hostnames are `<cc><n>`** (`us5090`, `uk12`); `.nordvpn.com` is added. Anything else is
  refused at parse time — the config name is interpolated into an AppleScript string, so the
  validator is also the injection guard.
- **`--country` is ISO two-letter**: `GB`, not `UK`. `--city` is a substring match on the
  recommended servers; no match falls back to the country silently (the preview shows which
  server was chosen, so read it).
- **Config names end in `.udp`.** Only OpenVPN-UDP bundles are downloaded.
- Tunnelblick keeps every imported configuration; `configs` grows with each new server.
  Delete unwanted ones in Tunnelblick.

## What the install steps change outside the tree

`toolbelt setup nordvpn` creates `tools/nordvpn/.venv` (inside the tree, gitignored) and
`~/.config/toolbelt/nordvpn/configs/`. Nothing else. Tunnelblick itself is
`brew install --cask tunnelblick`, offered by the doctor, not run by it.
