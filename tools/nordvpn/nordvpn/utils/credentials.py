"""NordVPN service-credential resolution (SENSIBILITIES #6, #11).

The tool needs the OpenVPN *service* credentials NordVPN issues on its manual-configuration
page — not the account password. They are a long-lived static secret, so they live in one of
these stores, checked in order; the first that yields both values wins:

1. ``NORD_USER`` / ``NORD_PASS`` in the process environment.
2. ``~/.config/toolbelt/nordvpn.env`` — dotenv lines, mode 600 enforced (a group- or
   world-readable file is refused, not read).
3. The macOS Keychain: generic-password items with service ``toolbelt-nordvpn`` and accounts
   ``NORD_USER`` and ``NORD_PASS``.
4. ``.env`` in the tool directory — deprecated; announced on stderr, mode 600 enforced.

No store is ever written by this module, and no value is ever printed or logged.
"""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

CREDENTIAL_FILE = Path.home() / ".config" / "toolbelt" / "nordvpn.env"
KEYCHAIN_SERVICE = "toolbelt-nordvpn"
KEYCHAIN_ACCOUNTS = ("NORD_USER", "NORD_PASS")
TOOL_DIR = Path(__file__).resolve().parent.parent.parent
LEGACY_ENV_FILE = TOOL_DIR / ".env"
PORTAL_URL = "https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/"


@dataclass
class Credentials:
    """NordVPN service credentials."""

    username: str
    password: str
    source: str = "env"

    def __repr__(self) -> str:  # never leak values through a stray print
        return f"Credentials(username=***, password=***, source={self.source!r})"


class CredentialsError(Exception):
    """Error loading credentials."""


def _world_readable(path: Path) -> bool:
    return bool(path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO))


def _from_env(env: dict[str, str]) -> tuple[str, str] | None:
    user, pwd = env.get("NORD_USER"), env.get("NORD_PASS")
    if user and pwd:
        return user.strip(), pwd.strip()
    return None


def _from_dotenv_file(path: Path) -> tuple[str, str] | None:
    """Read a dotenv file; refuse one another user on the machine could read."""
    if not path.is_file():
        return None
    if _world_readable(path):
        raise CredentialsError(
            f"{path} is group/world readable; refusing to read it. Fix: chmod 600 {path}"
        )
    values = {k: v for k, v in dotenv_values(path).items() if v}
    return _from_env(values)


def _from_keychain(run=subprocess.run) -> tuple[str, str] | None:
    """Two generic-password items; `security` returns the value on stdout, never on argv."""
    if sys.platform != "darwin":
        return None
    found: dict[str, str] = {}
    for account in KEYCHAIN_ACCOUNTS:
        try:
            r = run(
                ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None
        if r.returncode != 0 or not r.stdout.strip():
            return None
        found[account] = r.stdout.strip()
    return found["NORD_USER"], found["NORD_PASS"]


def get_credentials(
    env: dict[str, str] | None = None,
    credential_file: Path = CREDENTIAL_FILE,
    legacy_file: Path = LEGACY_ENV_FILE,
    keychain=_from_keychain,
    warn=lambda msg: print(msg, file=sys.stderr),
) -> Credentials:
    """Resolve the service credentials from the stores above, in order.

    Raises CredentialsError when no store has them, or a file store is too permissive.
    """
    env = os.environ if env is None else env

    pair = _from_env(env)
    if pair:
        return Credentials(*pair, source="env")

    pair = _from_dotenv_file(credential_file)
    if pair:
        return Credentials(*pair, source=str(credential_file))

    pair = keychain()
    if pair:
        return Credentials(*pair, source=f"keychain:{KEYCHAIN_SERVICE}")

    pair = _from_dotenv_file(legacy_file)
    if pair:
        warn(
            f"[nordvpn] deprecated: credentials read from {legacy_file} inside the tool tree. "
            f"Move them to {credential_file} (chmod 600) or the Keychain; an in-tree .env is "
            f"destroyed by `git clean -fdx` and pulled into any agent's `grep -r`."
        )
        return Credentials(*pair, source=str(legacy_file))

    raise CredentialsError(
        "NordVPN service credentials not configured. Provide NORD_USER and NORD_PASS via one of:\n"
        f"  - the environment\n"
        f"  - {credential_file}  (two dotenv lines, chmod 600)\n"
        f"  - Keychain: security add-generic-password -s {KEYCHAIN_SERVICE} -a NORD_USER -w <username>\n"
        f"              security add-generic-password -s {KEYCHAIN_SERVICE} -a NORD_PASS -w <password>\n"
        f"These are the OpenVPN *service* credentials, not your account password: {PORTAL_URL}"
    )


def credentials_configured() -> bool:
    """Presence only; never returns a value."""
    try:
        get_credentials()
        return True
    except CredentialsError:
        return False
