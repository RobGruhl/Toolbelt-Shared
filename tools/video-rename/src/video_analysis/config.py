from __future__ import annotations

MODEL_ALIASES: dict[str, str] = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-7",
}
DEFAULT_MODEL: str = "sonnet"

RES_PRESETS: dict[str, int] = {"low": 256, "medium": 512, "high": 768}
DEFAULT_RES: str = "medium"

VIDEO_EXTS: frozenset[str] = frozenset({
    ".mp4", ".mov", ".m4v", ".mkv", ".avi",
    ".webm", ".mpg", ".mpeg", ".wmv", ".flv", ".ts",
})

DEFAULT_NUM_FRAMES: int = 8
RENAMED_PATTERN: str = r"^\d{4}-\d{2}-\d{2}__"

# Ceilings (SENSIBILITIES #3). Code constants, not flags: --frames above MAX_FRAMES and
# --max-files above MAX_FILES are refused, not lowered. DEFAULT_MAX_FILES guards a
# recursive sweep of a big folder from becoming a surprise bill; --max-files raises it up
# to the ceiling, which is the loud, always-honored override for private spend.
MAX_FRAMES: int = 16
DEFAULT_MAX_FILES: int = 25
MAX_FILES: int = 200

# Approximate input price, USD per million tokens, for the --explain cost estimate only.
# The estimate is an order-of-magnitude guard, not a bill; the audit line carries the real
# token counts the API reported.
INPUT_USD_PER_MTOK: dict[str, float] = {
    "claude-haiku-4-5": 1.00,
    "claude-sonnet-4-6": 3.00,
    "claude-opus-4-7": 5.00,
}
SYSTEM_PROMPT_TOKENS_APPROX: int = 400


def estimate_tokens(num_frames: int, max_edge: int) -> int:
    """Image tokens ≈ (w × h) / 750 for a 16:9 frame at the longest edge, plus the prompt."""
    per_frame = int(max_edge * (max_edge * 9 / 16) / 750)
    return num_frames * per_frame + SYSTEM_PROMPT_TOKENS_APPROX


def estimate_usd(model: str, num_files: int, num_frames: int, max_edge: int) -> float | None:
    price = INPUT_USD_PER_MTOK.get(model)
    if price is None:
        return None
    return num_files * estimate_tokens(num_frames, max_edge) * price / 1_000_000


def resolve_model(spec: str) -> str:
    """Map an alias (haiku/sonnet/opus) to a full model id. Passes through full ids."""
    return MODEL_ALIASES.get(spec, spec)


def resolve_max_edge(spec: str | int) -> int:
    """Map a preset (low/medium/high) or raw int to a pixel value."""
    if isinstance(spec, int):
        return spec
    if spec in RES_PRESETS:
        return RES_PRESETS[spec]
    try:
        return int(spec)
    except (TypeError, ValueError) as e:
        raise ValueError(
            f"--res must be one of {sorted(RES_PRESETS)} or an integer; got {spec!r}"
        ) from e
