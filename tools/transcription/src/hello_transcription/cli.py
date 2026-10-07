"""CLI for transcription using Typer.

Local whisper.cpp is the default (free, private, no upload cap). `--backend openai` is the
loud opt-in to a paid, off-host call (SENSIBILITIES #2 flag tier): it estimates the charge
from the file's duration before any upload, refuses above the ceiling without --yes, and
appends one audit line per request. `--explain` prints the plan and makes no call.
"""

import sys
from enum import Enum
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.panel import Panel

from hello_transcription import spend
from hello_transcription.backends.base import TranscriptionBackend
from hello_transcription.backends.openai_api import MODELS, OpenAIBackend
from hello_transcription.backends.whisper_cpp import WhisperCppBackend
from hello_transcription.config import TranscriptionConfig
from hello_transcription.output.formats import OutputFormat, format_output
from hello_transcription.processors.ffmpeg import shrink_for_upload
from hello_transcription.processors.paragraph import group_paragraphs

app = typer.Typer(
    name="transcribe",
    help="Transcribe audio: local whisper.cpp by default; --backend openai is a paid, audited opt-in.",
    no_args_is_help=True,
)
console = Console()
err = Console(stderr=True)


class Backend(str, Enum):
    LOCAL = "local"
    OPENAI = "openai"


def get_configs_dir() -> Path:
    """Get the configs directory."""
    return Path(__file__).parent.parent.parent / "configs"


def _fail(msg: str, code: int = 1) -> None:
    err.print(f"[red]Error:[/red] {msg}")
    raise typer.Exit(code)


@app.command("run")
def run(
    audio_file: Annotated[Path, typer.Argument(help="Path to audio file (mp3, m4a, wav, mp4, ...)")],
    backend: Annotated[Backend, typer.Option("--backend", "-b",
        help="local = whisper.cpp on :2022 (free, private). openai = hosted, PAID, audited.")] = Backend.LOCAL,
    model: Annotated[Optional[str], typer.Option("--model", "-m",
        help=f"openai only: {', '.join(MODELS)} (default {spend.DEFAULT_OPENAI_MODEL})")] = None,
    max_usd: Annotated[float, typer.Option("--max-usd",
        help=f"openai only: refuse when the pre-call estimate exceeds this (default {spend.DEFAULT_MAX_USD:.2f})")] = spend.DEFAULT_MAX_USD,
    yes: Annotated[bool, typer.Option("--yes",
        help="openai only: proceed past the cost ceiling, or with an unknown duration. Always honored.")] = False,
    explain: Annotated[bool, typer.Option("--explain",
        help="Pre-flight: print the request plan, file facts and cost estimate; make no call.")] = False,
    preset: Annotated[Optional[str], typer.Option("--preset", "-p",
        help="Configuration preset (default, gaming, high_quality)")] = None,
    language: Annotated[Optional[str], typer.Option("--language", "-l",
        help="Language code (e.g. 'en'). Auto-detected if not specified.")] = None,
    prompt: Annotated[Optional[str], typer.Option("--prompt",
        help="Custom vocabulary for better recognition (e.g. 'Anthropic, Claude, MCP')")] = None,
    timestamps: Annotated[bool, typer.Option("--timestamps/--no-timestamps", "-t",
        help="Include segment timestamps (local, or openai whisper-1).")] = False,
    output_format: Annotated[Optional[OutputFormat], typer.Option("--format", "-f",
        help="Output format (txt, json, srt, vtt). Uses preset default if not specified.")] = None,
    output: Annotated[Optional[Path], typer.Option("--output", "-o",
        help="Output file path. Prints to stdout if not specified.")] = None,
    paragraphs: Annotated[bool, typer.Option("--paragraphs/--no-paragraphs",
        help="Post-process with the local `claude` CLI to group text into paragraphs (uses your Claude plan).")] = False,
) -> None:
    """Transcribe an audio file."""
    if not audio_file.exists():
        _fail(f"File not found: {audio_file}")

    try:
        config = TranscriptionConfig.load_preset(preset, get_configs_dir()) if preset else TranscriptionConfig()
    except FileNotFoundError:
        _fail(f"Preset '{preset}' not found.")

    overrides: dict[str, object] = {"language": language, "prompt": prompt}
    if timestamps:
        overrides["timestamps"] = True
    if output_format is not None:
        overrides["output_format"] = output_format.value
    config = config.merge(**overrides)
    want_timestamps = config.timestamps or timestamps
    fmt = output_format if output_format else OutputFormat(config.output_format)

    size = audio_file.stat().st_size
    duration = spend.ffprobe_duration(audio_file)

    if backend is Backend.OPENAI:
        engine, upload, record = _prepare_openai(
            audio_file, size, duration, model, max_usd, yes, explain,
            language=config.language, prompt=config.prompt, timestamps=want_timestamps,
        )
    else:
        if model:
            _fail("--model applies to --backend openai only; the local service runs ggml-large-v3-turbo", 2)
        engine = WhisperCppBackend(base_url=config.base_url, timeout=config.timeout)
        upload = audio_file
        record = spend.AuditRecord(backend="local", model="ggml-large-v3-turbo", file=audio_file,
                                   bytes=size, duration_s=duration, principal="local", est_usd=0.0)
        if explain:
            _print_plan(engine, upload, record, key_source="n/a", ceiling=None, form={
                "model": "whisper-1 (ignored by whisper.cpp)",
                "response_format": "verbose_json" if want_timestamps else "json",
                **({"language": config.language} if config.language else {}),
                **({"prompt": config.prompt} if config.prompt else {}),
            })
            raise typer.Exit(0)
        if not engine.is_available():
            console.print(Panel(
                "[red]whisper.cpp service not running on :2022[/red]\n\n"
                "Start it:  [cyan]mcp__voice-mode__service whisper start[/cyan]\n"
                "Status:    [cyan]curl http://127.0.0.1:2022/health[/cyan]\n\n"
                "Degraded mode: [cyan]--backend openai[/cyan] (paid, off-host, audited).",
                title="Backend Unavailable"))
            raise typer.Exit(1)

    record.sha256 = spend.sha256_of(upload)
    err.print(f"[dim]Transcribing:[/dim] {audio_file.name} [dim]via {record.backend}/{record.model}[/dim]")
    try:
        result = engine.transcribe(upload, language=config.language, prompt=config.prompt,
                                   timestamps=want_timestamps)
    except Exception as e:
        record.status = f"error:{type(e).__name__}"
        if isinstance(engine, OpenAIBackend):
            record.request_id = engine.last_request_id
        log = spend.append_audit(record)
        err.print(f"[dim]audit → {log}[/dim]", markup=True, highlight=False)
        _fail(str(e))

    if isinstance(engine, OpenAIBackend):
        record.request_id = engine.last_request_id
        record.usage = engine.last_usage
    log = spend.append_audit(record)
    err.print(f"[dim]audit → {log}[/dim]", markup=True, highlight=False)

    if paragraphs:
        err.print("[dim]Grouping into paragraphs via `claude --print`...[/dim]")
        try:
            result.text = group_paragraphs(result.text)
        except Exception as e:
            err.print(f"[yellow]Warning:[/yellow] Paragraph grouping failed: {e}")

    formatted = format_output(result, fmt)
    if output:
        output.write_text(formatted)
        err.print(f"[green]Saved to:[/green] {output}")
    else:
        sys.stdout.write(formatted)
        if not formatted.endswith("\n"):
            sys.stdout.write("\n")

    meta = []
    if result.language:
        meta.append(f"Language: {result.language}")
    if result.duration:
        meta.append(f"Duration: {int(result.duration // 60)}:{int(result.duration % 60):02d}")
    if record.est_usd:
        meta.append(f"Est. cost: ${record.est_usd:.4f}")
    if meta:
        err.print(f"[dim]{' | '.join(meta)}[/dim]")


def _prepare_openai(audio_file: Path, size: int, duration: float | None, model: str | None,
                    max_usd: float, yes: bool, explain: bool, *, language: str | None,
                    prompt: str | None, timestamps: bool):
    """Key, estimate, ceiling, upload cap — everything that happens before a byte leaves."""
    model = model or spend.DEFAULT_OPENAI_MODEL
    if model not in MODELS:
        _fail(f"unknown model '{model}'; one of: {', '.join(MODELS)}", 2)
    try:
        key, key_source = spend.resolve_openai_key()
    except PermissionError as e:
        _fail(str(e))
    est = spend.estimate_usd(model, duration)
    record = spend.AuditRecord(backend="openai", model=model, file=audio_file, bytes=size,
                               duration_s=duration, principal=spend.key_fingerprint(key),
                               billed_min=spend.billed_minutes(duration) if duration is not None else None,
                               est_usd=est)
    engine = OpenAIBackend(key or "", model=model)
    form = engine.request_plan(audio_file, language=language, prompt=prompt, timestamps=timestamps)

    if explain:
        _print_plan(engine, audio_file, record, key_source=key_source, ceiling=max_usd, form=form)
        raise typer.Exit(0)

    if not key:
        _fail("no OpenAI key: set $OPENAI_API_KEY, or `security add-generic-password -s OPENAI_API_KEY "
              "-a $USER -w`, or write it to ~/.config/toolbelt/transcription.key (chmod 600). "
              "Or use the default --backend local.")

    # Ceiling (SENSIBILITIES #3/#5): refuse the surprise, honor the deliberate --yes.
    if est is None and not yes:
        _fail("cannot estimate cost: ffprobe is missing or could not read the duration "
              "(brew install ffmpeg). Re-run with --yes to upload anyway; the audit line will "
              "record the charge OpenAI reports.", 2)
    if est is not None and est > max_usd and not yes:
        err.print(Panel(
            f"Estimated [bold]${est:.4f}[/bold] ({record.billed_min} min × ${spend.rate_for(model):.4f}/min, "
            f"{model}) exceeds the per-run ceiling of ${max_usd:.2f}.\n\n"
            "Why: a single flag should never surprise you with a bill. "
            "Proceed: re-run with [cyan]--yes[/cyan] (or raise [cyan]--max-usd[/cyan]). "
            "Nothing was uploaded.", title="Cost ceiling"))
        raise typer.Exit(2)

    try:
        upload = shrink_for_upload(audio_file, spend.OPENAI_MAX_UPLOAD_BYTES)
    except RuntimeError as e:
        _fail(str(e))
    if upload != audio_file:
        record.bytes = upload.stat().st_size
        err.print(f"[dim]Re-encoded for upload:[/dim] {upload} ({record.bytes} bytes)")
    return engine, upload, record


def _print_plan(engine: TranscriptionBackend, upload: Path, record: spend.AuditRecord, *,
                key_source: str, ceiling: float | None, form: dict[str, str]) -> None:
    dur = f"{record.duration_s:.1f}s" if record.duration_s is not None else "unknown (ffprobe missing or unreadable)"
    lines = [
        f"backend:     {record.backend}  ({engine.base_url}/v1/audio/transcriptions)",
        f"model:       {record.model}",
        f"file:        {upload}  ({record.bytes} bytes, duration {dur})",
        "form:        " + ", ".join(f"{k}={v!r}" for k, v in form.items()),
    ]
    if record.backend == "openai":
        rate = spend.rate_for(record.model)
        est = f"${record.est_usd:.4f}" if record.est_usd is not None else "unknown (needs --yes)"
        lines += [
            f"key:         {key_source}  (Authorization: Bearer ***)",
            f"rate:        ${rate:.4f}/min as of {spend.RATES_AS_OF}",
            f"estimate:    {est}  (billed minutes: {record.billed_min}); ceiling ${ceiling:.2f}"
            + ("  → would refuse without --yes" if record.est_usd is not None and ceiling is not None and record.est_usd > ceiling else ""),
            f"upload cap:  {spend.OPENAI_MAX_UPLOAD_BYTES} bytes"
            + ("  → would re-encode to 16 kHz mono mp3 first" if record.bytes > spend.OPENAI_MAX_UPLOAD_BYTES else ""),
        ]
    else:
        lines.append("cost:        $0 (local)")
    lines.append(f"audit line:  {spend.audit_log_path()}")
    console.print(Panel("\n".join(lines), title="Pre-flight — no call made"))


@app.command()
def check() -> None:
    """Report which backends are reachable; exit 1 if neither."""
    local = WhisperCppBackend()
    ok_local = local.is_available()
    console.print(("[green]✓[/green]" if ok_local else "[red]✗[/red]")
                  + " local whisper.cpp on :2022" + ("" if ok_local else "  (mcp__voice-mode__service whisper start)"))
    try:
        key, source = spend.resolve_openai_key()
    except PermissionError as e:
        key, source = None, f"refused: {e}"
    console.print(("[green]✓[/green]" if key else "[yellow]–[/yellow]")
                  + f" openai key: {source}" + ("" if key else "  (paid backend unavailable)"))
    total, n = spend.month_total_usd()
    console.print(f"[dim]openai spend this month (estimated): ${total:.4f} over {n} request(s) — {spend.audit_log_path()}[/dim]")
    if not ok_local and not key:
        raise typer.Exit(1)


@app.command("spend")
def spend_cmd(
    month: Annotated[Optional[str], typer.Option("--month", help="YYYY-MM (default: this month)")] = None,
) -> None:
    """Estimated OpenAI spend from the audit log (one grep over transcribe.log)."""
    total, n = spend.month_total_usd(month)
    console.print(f"${total:.4f} estimated over {n} openai request(s) in {month or 'this month'}  ({spend.audit_log_path()})")


@app.command()
def presets() -> None:
    """List available configuration presets."""
    configs_dir = get_configs_dir()
    if not configs_dir.exists():
        console.print("[yellow]No presets directory found.[/yellow]")
        return
    console.print("[bold]Available Presets:[/bold]\n")
    for preset_file in sorted(configs_dir.glob("*.yaml")):
        try:
            config = TranscriptionConfig.from_yaml(preset_file)
            desc = config.description or "[dim]No description[/dim]"
            console.print(f"  [cyan]{preset_file.stem}[/cyan]: {desc}")
        except Exception:
            console.print(f"  [yellow]{preset_file.stem}[/yellow]: [dim]Invalid config[/dim]")


if __name__ == "__main__":
    app()
