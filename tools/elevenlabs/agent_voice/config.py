"""Configuration, credential resolution and the in-code ceilings.

The ceilings are constants here, not flags (SENSIBILITIES #3): raising one is a diff.
"""

import os
import stat
import subprocess
import sys
from pathlib import Path

import yaml

from .models import AgentVoiceProfile, ServerConfig

# --- Ceilings (SENSIBILITIES #3) -------------------------------------------------------
# Characters per TTS request the server will accept at all. ElevenLabs bills per character,
# so this is the per-call spend ceiling. A request above it is refused (HTTP 422 from the
# server, exit 2 from the CLI), never truncated.
MAX_CHARS = 1000
# `agent-voice speak` at a terminal asks for --yes above this many characters: the guard
# against an accidental bulk narration, never a cap — --yes is always honored.
CONFIRM_CHARS = 400
# The Stop hook sends at most this many characters (enforced in scripts/agent-voice-hook.sh).
HOOK_CHARS = 200
# Seconds of music per `agent-voice music` call. ElevenLabs bills music by length, so this is
# that verb's per-call spend ceiling; a longer request is refused, never trimmed.
MAX_MUSIC_SECONDS = 120
MUSIC_MODEL = "music_v2_5"

KEY_ENV = "ELEVENLABS_API_KEY"
KEYCHAIN_SERVICE = "ELEVENLABS_API_KEY"
# Keychain service names tried in order: the canonical one, then the lowercase name earlier
# ElevenLabs projects on this Mac stored the same key under.
KEYCHAIN_SERVICES = (KEYCHAIN_SERVICE, "elevenlabs-api-key")
CONFIG_ENV_FILE = Path.home() / ".config" / "toolbelt" / "elevenlabs.env"


def _tool_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def _read_dotenv_value(path: Path, name: str) -> str | None:
    """Read one KEY=value line from a dotenv-style file. No interpolation."""
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == name:
            return v.strip().strip("'\"")
    return None


def _refuse_loose(path: Path) -> None:
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise ValueError(
            f"{path} is group/world readable (mode {mode:o}); chmod 600 it first"
        )


def key_source() -> str | None:
    """Name where the key would come from, without reading it out. None = absent."""
    if os.environ.get(KEY_ENV, "").strip():
        return f"${KEY_ENV}"
    if sys.platform == "darwin":
        for service in KEYCHAIN_SERVICES:
            r = subprocess.run(
                ["security", "find-generic-password", "-s", service],
                capture_output=True,
                timeout=10,
            )
            if r.returncode == 0:
                return f"keychain:{service}"
    if CONFIG_ENV_FILE.exists() and _read_dotenv_value(CONFIG_ENV_FILE, KEY_ENV):
        return str(CONFIG_ENV_FILE)
    legacy = _tool_dir() / ".env"
    if legacy.exists() and _read_dotenv_value(legacy, KEY_ENV):
        return f"{legacy} (deprecated in-tree fallback)"
    return None


def get_api_key() -> str:
    """Resolve the ElevenLabs API key (SENSIBILITIES #6, #11).

    Order: $ELEVENLABS_API_KEY, the macOS Keychain generic password whose service is
    ELEVENLABS_API_KEY (or the lowercase elevenlabs-api-key), ~/.config/toolbelt/elevenlabs.env (mode 600 enforced), then the
    in-tree .env as a deprecated fallback that warns on stderr. The key is never printed.
    """
    key = os.environ.get(KEY_ENV, "").strip()
    if key:
        return key

    if sys.platform == "darwin":
        for service in KEYCHAIN_SERVICES:
            r = subprocess.run(
                ["security", "find-generic-password", "-s", service, "-w"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()

    if CONFIG_ENV_FILE.exists():
        _refuse_loose(CONFIG_ENV_FILE)
        key = _read_dotenv_value(CONFIG_ENV_FILE, KEY_ENV)
        if key:
            return key

    legacy = _tool_dir() / ".env"
    if legacy.exists():
        _refuse_loose(legacy)
        key = _read_dotenv_value(legacy, KEY_ENV)
        if key:
            print(
                f"[agent-voice] warning: reading {KEY_ENV} from the in-tree {legacy} — "
                f"deprecated; move it to the Keychain or {CONFIG_ENV_FILE} (chmod 600)",
                file=sys.stderr,
            )
            return key

    raise ValueError(
        f"{KEY_ENV} not found. Set it with: "
        f"security add-generic-password -s {KEYCHAIN_SERVICE} -a $USER -w   "
        f"(or export {KEY_ENV}, or write it to {CONFIG_ENV_FILE} chmod 600)"
    )


def load_config() -> ServerConfig:
    """Load server config from YAML files.

    Checks in order:
    1. .agent-voice.yaml in cwd (per-project)
    2. ~/.config/agent-voice/config.yaml (global)
    3. Built-in defaults
    """
    config_paths = [
        Path.cwd() / ".agent-voice.yaml",
        Path.home() / ".config" / "agent-voice" / "config.yaml",
    ]

    for path in config_paths:
        if path.exists():
            return _load_from_yaml(path)

    return ServerConfig()


def _load_from_yaml(path: Path) -> ServerConfig:
    """Load ServerConfig from a YAML file."""
    with open(path) as f:
        data = yaml.safe_load(f) or {}

    voices_raw = data.pop("voices", {})
    voices = {}
    for name, profile_data in voices_raw.items():
        if isinstance(profile_data, dict):
            voices[name] = AgentVoiceProfile(**profile_data)

    return ServerConfig(voices=voices, **data)
