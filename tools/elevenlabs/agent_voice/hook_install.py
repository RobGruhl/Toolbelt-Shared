"""The Claude Code Stop hook install — the only code path that writes outside the tool dir.

Pure functions over a settings dict, so the plan can be previewed and tested without
touching ~/.claude. `apply()` is the single function that writes, and the CLI reaches it
only behind an explicit --yes (SENSIBILITIES #2, flag tier: private, reversible).
"""

import json
import shutil
from pathlib import Path

HOOK_NAME = "agent-voice-hook.sh"


def hook_source() -> Path:
    return Path(__file__).resolve().parent.parent / "scripts" / HOOK_NAME


def default_paths(project: bool = False) -> tuple[Path, Path]:
    """(settings.json, installed hook script)."""
    hook_dest = Path.home() / ".claude" / "hooks" / HOOK_NAME
    if project:
        return Path.cwd() / ".claude" / "settings.json", hook_dest
    return Path.home() / ".claude" / "settings.json", hook_dest


def load_settings(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def hook_entry(hook_dest: Path) -> dict:
    return {
        "matcher": "",
        "hooks": [{"type": "command", "command": str(hook_dest), "timeout": 5}],
    }


def is_installed(settings: dict, hook_dest: Path) -> bool:
    for entry in settings.get("hooks", {}).get("Stop", []):
        for h in entry.get("hooks", []):
            if HOOK_NAME in h.get("command", ""):
                return True
    return False


def with_hook(settings: dict, hook_dest: Path) -> dict:
    """Return a copy of settings with the Stop hook present (idempotent)."""
    out = json.loads(json.dumps(settings))
    if is_installed(out, hook_dest):
        return out
    out.setdefault("hooks", {}).setdefault("Stop", []).append(hook_entry(hook_dest))
    return out


def without_hook(settings: dict) -> dict:
    """Return a copy of settings with every agent-voice Stop hook removed."""
    out = json.loads(json.dumps(settings))
    hooks = out.get("hooks", {})
    stop = hooks.get("Stop", [])
    for entry in stop:
        entry["hooks"] = [h for h in entry.get("hooks", []) if HOOK_NAME not in h.get("command", "")]
    stop = [e for e in stop if e.get("hooks")]
    if stop:
        hooks["Stop"] = stop
    else:
        hooks.pop("Stop", None)
    if not hooks:
        out.pop("hooks", None)
    return out


def plan(settings_path: Path, hook_dest: Path, uninstall: bool) -> dict:
    """Describe exactly what apply() would do. Reads only."""
    current = load_settings(settings_path)
    src = hook_source()
    if uninstall:
        new = without_hook(current)
        script_action = "delete" if hook_dest.exists() else "absent (nothing to delete)"
    else:
        new = with_hook(current, hook_dest)
        if hook_dest.exists() and hook_dest.read_bytes() == src.read_bytes():
            script_action = "unchanged (already identical to the source)"
        elif hook_dest.exists():
            script_action = "overwrite with the source copy"
        else:
            script_action = "create (copy of the source, mode 755)"
    return {
        "settings_path": str(settings_path),
        "settings_changes": current != new,
        "settings_after": new,
        "hook_source": str(src),
        "hook_dest": str(hook_dest),
        "script_action": script_action,
        "uninstall": uninstall,
    }


def apply(settings_path: Path, hook_dest: Path, uninstall: bool) -> list[str]:
    """Perform the plan. The only writer outside the tool dir in this package."""
    done: list[str] = []
    p = plan(settings_path, hook_dest, uninstall)
    if p["settings_changes"]:
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(p["settings_after"], indent=2) + "\n")
        done.append(f"wrote {settings_path}")
    if uninstall:
        if hook_dest.exists():
            hook_dest.unlink()
            done.append(f"deleted {hook_dest}")
    elif not p["script_action"].startswith("unchanged"):
        hook_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(hook_source(), hook_dest)
        hook_dest.chmod(0o755)
        done.append(f"copied hook to {hook_dest}")
    return done
