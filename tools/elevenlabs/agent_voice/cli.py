"""CLI for agent voice narration.

Tiers (mirrored in toolbelt.json verbs[]):
  status, voices, serve, stop        read
  speak                              write-gated / flag — paid: --yes above CONFIRM_CHARS, refused above MAX_CHARS
  voice-add                          write-gated / flag — creates a voice in the account: --yes required
  setup                              write-gated / flag — writes ~/.claude: previews, --yes required
  music                              write-gated / flag — paid: previews, --yes required, refused above MAX_MUSIC_SECONDS
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path

import click
import httpx

from . import hook_install
from .audit import audit
from .config import CONFIRM_CHARS, MAX_CHARS, MAX_MUSIC_SECONDS, MUSIC_MODEL, key_source, load_config

EXIT_OK, EXIT_FAIL, EXIT_USAGE = 0, 1, 2


def _server_url() -> str:
    port = int(os.environ.get("AGENT_VOICE_PORT", "7888"))
    return f"http://127.0.0.1:{port}"


def _client():
    from elevenlabs import ElevenLabs

    from .config import get_api_key

    return ElevenLabs(api_key=get_api_key())


@click.group()
def cli():
    """Agent voice narration for Claude Code (ElevenLabs TTS)."""


@cli.command()
def serve():
    """Start the local voice server (127.0.0.1, foreground). Each /speak is a paid call."""
    from .server import main

    main()


@cli.command()
@click.argument("text")
@click.option("--agent", "-a", default="default", help="Agent type for voice selection")
@click.option("--tag", "-t", multiple=True, help="Audio tags to prepend (eleven_v3 only)")
@click.option("--dry-run", is_flag=True, help="Print the plan and cost driver; call nothing")
@click.option("--yes", is_flag=True, help=f"Proceed above {CONFIRM_CHARS} chars (always honored)")
def speak(text: str, agent: str, tag: tuple, dry_run: bool, yes: bool):
    """Speak TEXT via the running server. Paid: billed per character to your account."""
    n = len(text)
    config = load_config()
    voice = config.voices.get(agent)
    voice_id = voice.voice_id if voice else config.default_voice_id
    model_id = voice.model_id if voice else "eleven_flash_v2_5"
    plan = {
        "verb": "speak",
        "server": _server_url(),
        "agent": agent,
        "voice_id": voice_id,
        "model_id": model_id,
        "chars": n,
        "confirm_above": CONFIRM_CHARS,
        "max_chars": MAX_CHARS,
    }
    if n > MAX_CHARS:
        click.echo(
            f"refused: {n} chars exceeds MAX_CHARS={MAX_CHARS} (a code constant in "
            f"agent_voice/config.py — raise it with a diff, not a flag)",
            err=True,
        )
        sys.exit(EXIT_USAGE)
    if dry_run:
        click.echo(json.dumps(plan, indent=2))
        click.echo("dry run: nothing sent, nothing billed", err=True)
        return
    if n > CONFIRM_CHARS and not yes:
        click.echo(
            f"{n} chars is above CONFIRM_CHARS={CONFIRM_CHARS}: that is a deliberate bulk "
            f"narration billed to your ElevenLabs account. Re-run with --yes to proceed.",
            err=True,
        )
        sys.exit(EXIT_USAGE)
    try:
        resp = httpx.post(
            f"{_server_url()}/speak",
            json={"text": text, "agent_type": agent, "tags": list(tag)},
            timeout=2.0,
        )
    except httpx.ConnectError:
        click.echo("Server not running. Start with: agent-voice serve", err=True)
        sys.exit(EXIT_FAIL)
    if resp.status_code != 200:
        click.echo(f"server refused ({resp.status_code}): {resp.text[:200]}", err=True)
        sys.exit(EXIT_FAIL)
    click.echo(f"Speaking ({n} chars): {text[:60]}{'...' if n > 60 else ''}")


@cli.command()
def stop():
    """Stop currently playing audio."""
    try:
        httpx.post(f"{_server_url()}/stop", timeout=2.0)
        click.echo("Stopped.")
    except httpx.ConnectError:
        click.echo("Server not running.", err=True)


@cli.command()
@click.option("--json", "as_json", is_flag=True, help="Machine output")
def status(as_json: bool):
    """Server health, key source (never the key), ffplay, hook install state. Exit 1 if the server is down."""
    settings_path, hook_dest = hook_install.default_paths()
    report = {
        "server": _server_url(),
        "server_up": False,
        "key_source": key_source(),
        "ffplay": shutil.which("ffplay"),
        "hook_installed": hook_install.is_installed(hook_install.load_settings(settings_path), hook_dest)
        and hook_dest.exists(),
        "max_chars": MAX_CHARS,
    }
    try:
        httpx.get(f"{_server_url()}/health", timeout=1.0)
        report["server_up"] = True
    except httpx.ConnectError:
        pass
    if as_json:
        click.echo(json.dumps(report, indent=2))
    else:
        for k, v in report.items():
            click.echo(f"{k:15} {v}")
    if not report["server_up"]:
        sys.exit(EXIT_FAIL)


@cli.command()
@click.option("--json", "as_json", is_flag=True, help="Machine output")
@click.option("--limit", default=50, show_default=True, help="Max voices to list (ceiling 100)")
def voices(as_json: bool, limit: int):
    """List the voices this account can use (read)."""
    if limit > 100:
        click.echo("--limit above 100 refused", err=True)
        sys.exit(EXIT_USAGE)
    client = _client()
    page = client.voices.search(page_size=limit)
    rows = [
        {"voice_id": v.voice_id, "name": v.name, "category": getattr(v, "category", None)}
        for v in page.voices
    ]
    if as_json:
        click.echo(json.dumps(rows, indent=2))
    else:
        for r in rows:
            click.echo(f"{r['voice_id']}  {r['name']}  ({r['category']})")


@cli.command("voice-add")
@click.argument("name")
@click.argument("samples", nargs=-1, type=click.Path(exists=True, dir_okay=False), required=True)
@click.option("--description", default=None)
@click.option("--dry-run", is_flag=True, help="Print the plan; create nothing")
@click.option("--yes", is_flag=True, help="Create the voice (required; always honored)")
def voice_add(name: str, samples: tuple, description: str | None, dry_run: bool, yes: bool):
    """Create an instant-voice-clone named NAME from audio SAMPLES (write: --yes required).

    This adds a voice to your ElevenLabs account (uses a voice slot; the account's
    plan decides how many). Removing it is done in the ElevenLabs UI; there is no delete
    verb here.
    """
    if len(samples) > 25:
        click.echo("more than 25 samples refused (ElevenLabs IVC ceiling)", err=True)
        sys.exit(EXIT_USAGE)
    total = sum(Path(s).stat().st_size for s in samples)
    plan = {
        "verb": "voice-add",
        "name": name,
        "samples": list(samples),
        "bytes": total,
        "description": description,
        "effect": "creates a voice in your ElevenLabs account (occupies a voice slot; undo in the UI)",
    }
    if dry_run or not yes:
        click.echo(json.dumps(plan, indent=2))
        if dry_run:
            click.echo("dry run: nothing created", err=True)
            return
        click.echo("nothing created. Re-run with --yes to create this voice.", err=True)
        sys.exit(EXIT_USAGE)
    client = _client()
    files = [open(s, "rb") for s in samples]
    try:
        kwargs = {"name": name, "files": files}
        if description:
            kwargs["description"] = description
        resp = client.voices.ivc.create(**kwargs)
    finally:
        for f in files:
            f.close()
    audit("voice-add", name=name, samples=len(samples), bytes=total, voice_id=resp.voice_id)
    # Read back (SENSIBILITIES #2): a 200 is a claim; the voice listing is the evidence.
    got = client.voices.get(resp.voice_id)
    click.echo(json.dumps({"voice_id": resp.voice_id, "name": got.name, "verified": got.name == name}))


@cli.command()
@click.option("--project", is_flag=True, help="Target ./.claude/settings.json instead of ~/.claude/settings.json")
@click.option("--uninstall", is_flag=True, help="Remove the hook and the installed script")
@click.option("--yes", is_flag=True, help="Write. Without it: preview only")
def setup(project: bool, uninstall: bool, yes: bool):
    """Install (or remove) the Claude Code Stop hook. Previews; writes only with --yes.

    Writes two things outside this tool dir: a copy of scripts/agent-voice-hook.sh to
    ~/.claude/hooks/ and a Stop entry in the settings file. The hook fires on every
    Stop; the server being up or down decides whether anything is spoken.
    """
    settings_path, hook_dest = hook_install.default_paths(project)
    p = hook_install.plan(settings_path, hook_dest, uninstall)
    click.echo(f"settings file: {p['settings_path']} -> {'change' if p['settings_changes'] else 'no change'}")
    click.echo(f"hook script:   {p['hook_dest']} -> {p['script_action']}")
    if p["settings_changes"]:
        click.echo("settings after:")
        click.echo(json.dumps(p["settings_after"].get("hooks", {}).get("Stop", []), indent=2))
    if not yes:
        click.echo(
            "preview only — nothing written. Re-run with --yes to apply "
            "(no: nothing changes; yes: the two paths above are written, undo with --uninstall --yes)",
            err=True,
        )
        return
    done = hook_install.apply(settings_path, hook_dest, uninstall)
    for d in done:
        click.echo(d)
    audit("setup", action="uninstall" if uninstall else "install", settings=str(settings_path), changes=len(done))
    if not done:
        click.echo("already in the requested state.")


def _credits_used(client) -> int | None:
    """Characters (credits) used this billing period, or None if the read fails."""
    try:
        return client.user.subscription.get().character_count
    except Exception:  # a failed read only loses the audit's charged figure
        return None


@cli.command()
@click.argument("prompt")
@click.option("--out", "out_dir", required=True, type=click.Path(file_okay=False), help="Directory the track is written into")
@click.option("--seconds", type=int, default=30, show_default=True, help=f"Track length, 3–{MAX_MUSIC_SECONDS}")
@click.option("--name", default=None, help="File stem [A-Za-z0-9._-]; default: a slug of the prompt")
@click.option("--vocals", is_flag=True, help="Allow vocals (default: instrumental only)")
@click.option("--yes", is_flag=True, help="Compose it (required; always honored)")
def music(prompt: str, out_dir: str, seconds: int, name: str | None, vocals: bool, yes: bool):
    """Compose a music track from PROMPT with Eleven Music (paid: previews, --yes required).

    Billed to your ElevenLabs plan by track length. Writes one .mp3 inside --out and never
    overwrites. The audit line records the credits the account's usage counter moved by.
    """
    if not 3 <= seconds <= MAX_MUSIC_SECONDS:
        click.echo(
            f"refused: --seconds must be 3–{MAX_MUSIC_SECONDS} (MAX_MUSIC_SECONDS is a code constant in "
            f"agent_voice/config.py — raise it with a diff, not a flag)",
            err=True,
        )
        sys.exit(EXIT_USAGE)
    if name is not None and not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        click.echo("--name may contain only [A-Za-z0-9._-]", err=True)
        sys.exit(EXIT_USAGE)
    out = Path(out_dir).expanduser().resolve()
    if out in (Path(out.anchor), Path.home()):
        click.echo(f"--out must be a project directory, not {out}", err=True)
        sys.exit(EXIT_USAGE)
    stem = name or (re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")[:40] or "music")
    dest = out / f"{stem}.mp3"
    plan = {
        "verb": "music",
        "model_id": MUSIC_MODEL,
        "seconds": seconds,
        "instrumental": not vocals,
        "prompt": prompt,
        "output": str(dest),
        "key_source": key_source(),
        "effect": "composes one track billed to your ElevenLabs plan by length (Music API needs a paid plan)",
    }
    if dest.exists():
        click.echo(f"refusing to overwrite {dest} — pass a different --name", err=True)
        sys.exit(EXIT_USAGE)
    if not yes:
        click.echo(json.dumps(plan, indent=2))
        click.echo("preview only — nothing composed, nothing billed. Re-run with --yes to compose this track.", err=True)
        sys.exit(EXIT_USAGE)
    client = _client()
    before = _credits_used(client)
    kwargs = {"prompt": prompt, "music_length_ms": seconds * 1000, "model_id": MUSIC_MODEL, "force_instrumental": not vocals}
    try:
        audio = b"".join(client.music.compose(**kwargs))
    except Exception as e:
        # SDK errors carry status_code and body; their str() dumps every response header.
        status_code = getattr(e, "status_code", None)
        body = getattr(e, "body", None)
        detail = body.get("detail", body) if isinstance(body, dict) else body
        reason = (detail.get("message") or detail.get("status")) if isinstance(detail, dict) else (detail or str(e))
        msg = f"HTTP {status_code}: {reason}" if status_code else str(reason)
        audit("music", model=MUSIC_MODEL, seconds=seconds, status="error", error=str(msg)[:200])
        hint = " — the key was rejected; replace it (docs/CREDENTIALS.md)" if status_code == 401 else ""
        click.echo(f"music failed: {msg}{hint}", err=True)
        sys.exit(EXIT_FAIL)
    out.mkdir(parents=True, exist_ok=True)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as f:
        f.write(audio)
    after = _credits_used(client)
    charged = after - before if before is not None and after is not None else "unknown"
    if charged == 0:  # the usage counter can lag the compose call; 0 would read as "free"
        charged = "not-yet-reported"
    audit("music", model=MUSIC_MODEL, seconds=seconds, status="ok", credits=charged, file=str(dest), bytes=dest.stat().st_size)
    click.echo(f"wrote {dest} ({dest.stat().st_size} bytes) · {charged} credits")
