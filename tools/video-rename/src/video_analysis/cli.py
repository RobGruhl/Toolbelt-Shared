"""CLI entry point: video-rename (alias: analyze-video).

Verbs and their tiers (the manifest's verbs[] mirrors VERBS below):

  analyze   read, paid   — sample frames, ask Claude, print the plan, write it to a plan file.
                           Never renames. An audit line per paid call.
  rename    write-gated, flag — preview (== analyze) by default; --yes renames. --plan FILE
                           replays a saved plan with no paid call. An audit line per rename.
  undo      write-gated, flag — reverse the last N renames from renames.jsonl; --yes executes.
  log       read        — the rename log.

Exit codes: 0 done or previewed · 1 a per-file error occurred · 2 usage, missing key, or a
ceiling exceeded.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.table import Table

from . import __version__
from .auth import KEY_FILE, LooseKeyFile, describe_source, resolve_api_key
from .config import (
    DEFAULT_MAX_FILES,
    DEFAULT_MODEL,
    DEFAULT_NUM_FRAMES,
    DEFAULT_RES,
    MAX_FILES,
    MAX_FRAMES,
    estimate_tokens,
    estimate_usd,
    resolve_max_edge,
    resolve_model,
)
from .discover import iter_videos
from .paths import TOOL, audit, display, live_renames, read_plan, read_renames, record_rename, renames_path, tool_dir, write_plan
from .rename import apply_rename, build_new_name, check_same_directory
from .transcribe import TranscribeNotFound, find_transcribe, transcribe_video

VERBS = {
    "analyze": {"tier": "read", "note": "paid: one Claude vision call per file; audit line per call"},
    "rename": {"tier": "write-gated", "gate": "flag", "note": "preview without --yes; --yes renames; reversible with undo"},
    "undo": {"tier": "write-gated", "gate": "flag", "note": "preview without --yes; --yes renames back"},
    "log": {"tier": "read"},
}

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Analyze videos with Claude vision and rename them descriptively. Reads are paid; renames need --yes and are reversible with `undo`.",
)
console = Console()
err = Console(stderr=True)


def _version(value: bool) -> None:
    if value:
        console.print(f"{TOOL} {__version__}")
        raise typer.Exit()


@app.callback()
def _root(
    version: Annotated[bool, typer.Option("--version", callback=_version, is_eager=True, help="Print the version.")] = False,
) -> None:
    pass


# ------------------------------------------------------------------ shared options

PathsArg = Annotated[list[Path], typer.Argument(help="Video files or directories.", exists=True)]
Recursive = Annotated[bool, typer.Option("--recursive", "-r", help="Walk directories.")]
Transcribe = Annotated[bool, typer.Option("--transcribe", help="Include an audio transcript via the belt's `transcribe` CLI.")]
ModelOpt = Annotated[str, typer.Option(help="haiku | sonnet | opus | <full Claude model id>")]
Haiku = Annotated[bool, typer.Option("--haiku", help="Shortcut for --model haiku.")]
Sonnet = Annotated[bool, typer.Option("--sonnet", help="Shortcut for --model sonnet.")]
Opus = Annotated[bool, typer.Option("--opus", help="Shortcut for --model opus.")]
Res = Annotated[str, typer.Option(help="low | medium | high | <integer px> (longest edge)")]
Frames = Annotated[int, typer.Option("--frames", help=f"Frames to sample uniformly (ceiling {MAX_FRAMES}).")]
IncludeRenamed = Annotated[bool, typer.Option("--include-renamed", help="Also process files that already look renamed (YYYY-MM-DD__…).")]
MaxFiles = Annotated[int, typer.Option("--max-files", help=f"Files per run (default {DEFAULT_MAX_FILES}, ceiling {MAX_FILES}).")]
Explain = Annotated[bool, typer.Option("--explain", help="Pre-flight: list the files, model, frame count and cost estimate; make no API call.")]


def _pick_model(model: str, haiku: bool, sonnet: bool, opus: bool) -> str:
    shortcuts = [("haiku", haiku), ("sonnet", sonnet), ("opus", opus)]
    chosen = [name for name, flag in shortcuts if flag]
    if len(chosen) > 1:
        raise typer.BadParameter(f"Pick at most one of --haiku / --sonnet / --opus (got: {', '.join(chosen)})")
    if chosen and model != DEFAULT_MODEL:
        raise typer.BadParameter("Use either --model or a shortcut flag (--haiku/--sonnet/--opus), not both.")
    return resolve_model(chosen[0] if chosen else model)


def _usage_error(msg: str) -> typer.Exit:
    err.print(f"[red]{TOOL}:[/red] {msg}")
    return typer.Exit(code=2)


def _settings(model, haiku, sonnet, opus, res, frames, max_files):
    try:
        max_edge = resolve_max_edge(res)
    except ValueError as e:
        raise typer.BadParameter(str(e)) from e
    if frames < 1 or frames > MAX_FRAMES:
        raise _usage_error(f"--frames must be 1..{MAX_FRAMES} (MAX_FRAMES in config.py); got {frames}")
    if max_files < 1 or max_files > MAX_FILES:
        raise _usage_error(f"--max-files must be 1..{MAX_FILES} (MAX_FILES in config.py); got {max_files}")
    return _pick_model(model, haiku, sonnet, opus), max_edge


def _discover(paths: list[Path], recursive: bool, include_renamed: bool, max_files: int) -> tuple[list[Path], int]:
    videos = list(iter_videos(paths, recursive=recursive, force=include_renamed))
    total = len(videos)
    if total > max_files:
        raise _usage_error(
            f"{total} videos found, more than --max-files {max_files}. Narrow the paths, or pass "
            f"--max-files N (up to {MAX_FILES}) if you mean to spend on all of them."
        )
    return videos, total


# ------------------------------------------------------------------ the paid read

def _explain(verb: str, videos: list[Path], model: str, max_edge: int, frames: int, transcribe: bool) -> None:
    est = estimate_usd(model, len(videos), frames, max_edge)
    cost = f"~${est:.3f}" if est is not None else "unknown (model not in INPUT_USD_PER_MTOK)"
    t = find_transcribe()
    console.print(f"[bold]{TOOL} {verb} --explain[/bold] — no API call made, no file touched")
    console.print(f"  files:      {len(videos)}")
    for v in videos:
        console.print(f"    {display(v)}")
    console.print(f"  model:      {model}")
    console.print(f"  frames:     {frames} @ {max_edge}px  (~{estimate_tokens(frames, max_edge)} input tokens/file)")
    console.print(f"  est. cost:  {cost} input, uncached — prompt caching cuts repeats within 5 min")
    console.print(f"  transcribe: {'on → ' + display(t) if transcribe and t else ('on but NOT FOUND → visual-only' if transcribe else 'off')}")
    _, source = resolve_api_key(legacy_file=tool_dir() / ".env")
    console.print(f"  key:        {describe_source(source)}")
    console.print(f"  tier:       {VERBS[verb]['tier']}" + (f", gate: {VERBS[verb]['gate']}" if 'gate' in VERBS[verb] else ""))


def _analyze(verb: str, videos: list[Path], model: str, max_edge: int, frames: int, transcribe: bool) -> tuple[list[dict], list[tuple[Path, str]]]:
    """Run the paid calls. Returns (plan entries, errors)."""
    import anthropic

    from .analyze import describe_video
    from .frames import extract_frames

    try:
        key, source = resolve_api_key(legacy_file=tool_dir() / ".env")
    except LooseKeyFile as e:
        raise _usage_error(str(e))
    if not key:
        raise _usage_error(describe_source("none"))
    client = anthropic.Anthropic(api_key=key)

    if transcribe and find_transcribe() is None:
        err.print("[yellow]transcribe not found — degraded mode: visual-only (run `toolbelt setup transcription`)[/yellow]")
        transcribe = False

    entries: list[dict] = []
    errors: list[tuple[Path, str]] = []
    for video in videos:
        try:
            pil_frames = extract_frames(video, num_frames=frames, max_edge=max_edge)
            if not pil_frames:
                raise RuntimeError("no frames extracted (empty or unreadable video)")
            transcript: str | None = None
            if transcribe:
                try:
                    transcript = transcribe_video(video)
                except TranscribeNotFound as e:
                    err.print(f"[yellow]{e}[/yellow]")
                    transcribe = False
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                    err.print(f"[yellow]transcription failed for {video.name}: {e} — visual-only for this file[/yellow]")
            desc = describe_video(client, pil_frames, model=model, transcript=transcript)
            u = desc.usage
            audit(
                verb, video, model=model, frames=len(pil_frames), calls=u.calls,
                input_tokens=u.input_tokens, cache_read=u.cache_read_input_tokens, output_tokens=u.output_tokens,
                transcript=bool(transcript),
            )
            new_path = build_new_name(video, desc.title or "untitled")
            entries.append({
                "from": str(video), "to": str(new_path),
                "summary": desc.summary or ", ".join(desc.tags), "tags": desc.tags,
            })
        except Exception as e:  # per-file isolation: one bad video must not sink the batch
            errors.append((video, str(e)))
    return entries, errors


def _print_plan(title: str, entries: list[dict]) -> None:
    table = Table(title=title, show_lines=False)
    table.add_column("original", style="cyan", overflow="fold")
    table.add_column("→", style="dim", justify="center")
    table.add_column("new", style="green", overflow="fold")
    table.add_column("summary", style="white", overflow="fold")
    for e in entries:
        table.add_row(Path(e["from"]).name, "→", Path(e["to"]).name, e.get("summary", ""))
    console.print(table)


def _report_errors(errors: list[tuple[Path, str]]) -> None:
    if errors:
        err.print(f"[red]Errors on {len(errors)} file(s):[/red]")
        for v, msg in errors:
            err.print(f"  [red]{v}[/red]: {msg}")


def _save_plan(entries: list[dict], model: str) -> Path:
    return write_plan({"tool": TOOL, "version": __version__, "model": model, "entries": entries})


@app.command()
def analyze(
    paths: PathsArg,
    recursive: Recursive = False,
    transcribe: Transcribe = False,
    model: ModelOpt = DEFAULT_MODEL,
    haiku: Haiku = False,
    sonnet: Sonnet = False,
    opus: Opus = False,
    res: Res = DEFAULT_RES,
    frames: Frames = DEFAULT_NUM_FRAMES,
    include_renamed: IncludeRenamed = False,
    max_files: MaxFiles = DEFAULT_MAX_FILES,
    explain: Explain = False,
) -> None:
    """Propose descriptive names (paid Claude vision call per file). Never renames."""
    resolved_model, max_edge = _settings(model, haiku, sonnet, opus, res, frames, max_files)
    videos, _ = _discover(paths, recursive, include_renamed, max_files)
    if not videos:
        console.print("[yellow]No videos found.[/yellow]")
        return
    if explain:
        _explain("analyze", videos, resolved_model, max_edge, frames, transcribe)
        return
    entries, errors = _analyze("analyze", videos, resolved_model, max_edge, frames, transcribe)
    _print_plan("Rename plan (nothing renamed)", entries)
    plan = _save_plan(entries, resolved_model)
    console.print(f"plan saved: {display(plan)}\napply it with:  {TOOL} rename --plan {display(plan)} --yes")
    _report_errors(errors)
    if errors:
        raise typer.Exit(code=1)


# ------------------------------------------------------------------ the gated write

def _apply_entries(entries: list[dict], plan_ref: str) -> tuple[list[dict], list[tuple[Path, str]]]:
    done: list[dict] = []
    errors: list[tuple[Path, str]] = []
    for e in entries:
        src, dst = Path(e["from"]), Path(e["to"])
        try:
            check_same_directory(src, dst)
            if src.resolve() == dst.resolve():
                continue
            if not src.exists():
                raise FileNotFoundError(f"{src} no longer exists")
            apply_rename(src, dst)
            if not dst.exists() or src.exists():
                raise RuntimeError("RE-READ MISMATCH: rename returned but the filesystem disagrees")
            record_rename("rename", src, dst, plan=plan_ref)
            audit("rename", src, to=display(dst), plan=plan_ref)
            done.append(e)
        except Exception as ex:
            errors.append((src, str(ex)))
    return done, errors


@app.command()
def rename(
    paths: Annotated[Optional[list[Path]], typer.Argument(help="Video files or directories (omit with --plan).", exists=True)] = None,
    plan: Annotated[Optional[Path], typer.Option("--plan", help="Apply a saved plan file instead of analyzing (no API call).", exists=True, dir_okay=False)] = None,
    yes: Annotated[bool, typer.Option("--yes", help="Rename. Without it: preview only, nothing touched.")] = False,
    recursive: Recursive = False,
    transcribe: Transcribe = False,
    model: ModelOpt = DEFAULT_MODEL,
    haiku: Haiku = False,
    sonnet: Sonnet = False,
    opus: Opus = False,
    res: Res = DEFAULT_RES,
    frames: Frames = DEFAULT_NUM_FRAMES,
    include_renamed: IncludeRenamed = False,
    max_files: MaxFiles = DEFAULT_MAX_FILES,
    explain: Explain = False,
) -> None:
    """Rename videos to YYYY-MM-DD__slug.ext. Preview by default; --yes renames; `undo` reverses."""
    if plan is not None:
        if paths:
            raise _usage_error("give either --plan FILE or paths, not both")
        try:
            data = read_plan(plan)
        except (ValueError, OSError) as e:
            raise _usage_error(str(e))
        entries = data["entries"]
        plan_ref = display(plan)
        if explain or not yes:
            _print_plan(f"Rename plan from {plan_ref} (preview — nothing renamed)", entries)
            console.print(f"[rename] Preview only. To rename exactly these, re-run:\n  {TOOL} rename --plan {plan_ref} --yes")
            return
    else:
        if not paths:
            raise _usage_error("rename needs paths, or --plan FILE")
        resolved_model, max_edge = _settings(model, haiku, sonnet, opus, res, frames, max_files)
        videos, _ = _discover(paths, recursive, include_renamed, max_files)
        if not videos:
            console.print("[yellow]No videos found.[/yellow]")
            return
        if explain:
            _explain("rename", videos, resolved_model, max_edge, frames, transcribe)
            console.print(f"  then:       {'rename (--yes given)' if yes else 'preview only — re-run with --yes, or rename --plan <saved plan> --yes'}")
            return
        entries, errors = _analyze("rename", videos, resolved_model, max_edge, frames, transcribe)
        saved = _save_plan(entries, resolved_model)
        plan_ref = display(saved)
        if not yes:
            _print_plan("Rename plan (preview — nothing renamed)", entries)
            console.print(
                f"plan saved: {plan_ref}\n[rename] Preview only. To rename exactly these without paying again, re-run:\n"
                f"  {TOOL} rename --plan {plan_ref} --yes"
            )
            _report_errors(errors)
            if errors:
                raise typer.Exit(code=1)
            return
        _report_errors(errors)
        if errors:
            err.print("[yellow]continuing with the files that analyzed cleanly[/yellow]")

    done, apply_errors = _apply_entries(entries, plan_ref)
    _print_plan(f"Renamed {len(done)} file(s)", done)
    console.print(f"undo with:  {TOOL} undo --last {len(done)} --yes    (log: {display(renames_path())})")
    _report_errors(apply_errors)
    if apply_errors:
        raise typer.Exit(code=1)


@app.command()
def undo(
    last: Annotated[int, typer.Option("--last", "-n", help="How many of the most recent renames to reverse.")] = 1,
    yes: Annotated[bool, typer.Option("--yes", help="Reverse them. Without it: preview only.")] = False,
) -> None:
    """Reverse the most recent renames recorded in renames.jsonl (newest first)."""
    if last < 1:
        raise _usage_error("--last must be >= 1")
    live = live_renames(read_renames())
    targets = list(reversed(live))[:last]
    if not targets:
        console.print(f"nothing to undo — no live renames in {display(renames_path())}")
        return
    entries = [{"from": r["to"], "to": r["from"], "summary": f"renamed {r['ts']}"} for r in targets]
    if not yes:
        _print_plan("Undo plan (preview — nothing renamed)", entries)
        console.print(f"[undo] Preview only. To reverse exactly these, re-run:\n  {TOOL} undo --last {len(entries)} --yes")
        return
    done = 0
    errors: list[tuple[Path, str]] = []
    for e in entries:
        src, dst = Path(e["from"]), Path(e["to"])
        try:
            check_same_directory(src, dst)
            if not src.exists():
                raise FileNotFoundError(f"{src} no longer exists (moved or renamed since)")
            apply_rename(src, dst)
            if not dst.exists() or src.exists():
                raise RuntimeError("RE-READ MISMATCH: rename returned but the filesystem disagrees")
            record_rename("undo", src, dst)
            audit("undo", src, to=display(dst))
            done += 1
        except Exception as ex:
            errors.append((src, str(ex)))
    console.print(f"reversed {done} rename(s)")
    _report_errors(errors)
    if errors:
        raise typer.Exit(code=1)


@app.command()
def log(
    limit: Annotated[int, typer.Option("--limit", "-n", help="Most recent records to show.")] = 20,
    all_records: Annotated[bool, typer.Option("--all", help="Include renames already undone.")] = False,
) -> None:
    """Show the rename log (newest last)."""
    records = read_renames()
    if not all_records:
        records = live_renames(records)
    if not records:
        console.print(f"no {'records' if all_records else 'live renames'} in {display(renames_path())}")
        return
    for r in records[-limit:]:
        console.print(f"{r['ts']}  {r['verb']:6}  {display(r['from'])}  →  {display(r['to'])}")


if __name__ == "__main__":
    app()
