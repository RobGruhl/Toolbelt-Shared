# nordvpn

Control NordVPN on macOS through Tunnelblick (OpenVPN) — no sudo, no NordVPN app. The agent
contract, every verb's gate, the credential stores and the quirks are in [CLAUDE.md](CLAUDE.md);
this file is the human quick start.

## Setup

```bash
brew install --cask tunnelblick
../../bin/toolbelt setup nordvpn            # in-project .venv + the staging dir
# service credentials (NOT the account password):
#   https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/
security add-generic-password -s toolbelt-nordvpn -a NORD_USER -w '<username>'
security add-generic-password -s toolbelt-nordvpn -a NORD_PASS -w '<password>'
#   or: cp .env.example ~/.config/toolbelt/nordvpn.env && chmod 600 ~/.config/toolbelt/nordvpn.env
poetry run nordvpn setup                    # pre-flight
```

## Use

```bash
poetry run nordvpn status                   # state, server, load, public IP (--local: no IP lookup)
poetry run nordvpn servers -c US            # recommended servers, lowest load first
poetry run nordvpn connect -c US            # preview
poetry run nordvpn connect -c US --yes      # connect; installs the config on first use
poetry run nordvpn disconnect --yes
```

`connect`/`disconnect` change nothing without `--yes`. Every change is logged to
`data/audit.log`. On the first connection Tunnelblick asks to import the configuration and
macOS asks to allow automation — both are one-time clicks.

## Layout

```
nordvpn/cli.py            Typer commands, tiers, ceilings, the --yes gate
nordvpn/audit.py          audit line to stderr + data/audit.log
nordvpn/api/              NordVPN public API client (httpx) + pydantic models
nordvpn/vpn/              Tunnelblick AppleScript control, config download/bundle, status
nordvpn/utils/credentials.py   env → 600-mode file → Keychain → deprecated .env
checks/credentials.mjs    doctor check: credentials resolvable (presence only)
tests/                    unit tests; no network, no credential, no Tunnelblick
```
