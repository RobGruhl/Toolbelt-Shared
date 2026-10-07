"""Send sampled frames to Claude vision and get a structured description back.

Uses prompt caching on the system prompt (marked `cache_control: ephemeral`).
The first call in a batch pays the cache-write cost; subsequent calls within
5 minutes and same model hit the cache, cutting input cost ~10x for that prefix.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import anthropic
from PIL import Image

from .frames import jpeg_b64

SYSTEM_PROMPT = """You are a video cataloging assistant.

Given a sequence of frames sampled uniformly from a video (plus an optional \
audio transcript excerpt), produce a concise, descriptive title and summary \
suitable for renaming the file.

Respond ONLY with a single JSON object, no prose, no markdown fences:

{
  "title": "3-8 word description, lowercase words separated by spaces, no punctuation, suitable as a filename slug (nouns and verbs, avoid filler)",
  "summary": "one sentence, up to 200 characters, describing what the video shows",
  "tags": ["up to 5 short topical tags"]
}

The title should emphasize the most visually distinctive subject and action \
(e.g. "dog catching frisbee beach", "screencast claude code demo", \
"aerial drone shot mountain lake"). Do not include dates, camera model names, \
or sensitive personal information."""


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    calls: int = 0


@dataclass(frozen=True)
class VideoDescription:
    title: str
    summary: str
    tags: list[str]
    usage: Usage = Usage()


def _build_user_content(
    frames: list[Image.Image],
    transcript: str | None,
) -> list[dict]:
    blocks: list[dict] = []
    for img in frames:
        blocks.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": jpeg_b64(img),
            },
        })
    user_text = "Describe this video."
    if transcript:
        user_text += f"\n\nAudio transcript excerpt:\n{transcript}"
    blocks.append({"type": "text", "text": user_text})
    return blocks


def _parse_json_title(text: str) -> VideoDescription:
    text = text.strip()
    # Strip accidental markdown code fences, just in case.
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    data = json.loads(text)
    return VideoDescription(
        title=str(data.get("title", "")).strip(),
        summary=str(data.get("summary", "")).strip(),
        tags=[str(t) for t in data.get("tags", []) if str(t).strip()],
    )


def describe_video(
    client: anthropic.Anthropic,
    frames: list[Image.Image],
    model: str,
    transcript: str | None = None,
    max_tokens: int = 1024,
) -> VideoDescription:
    """One Claude vision call → parsed VideoDescription. Retries once on bad JSON."""
    system_blocks = [{
        "type": "text",
        "text": SYSTEM_PROMPT,
        "cache_control": {"type": "ephemeral"},
    }]
    user_content = _build_user_content(frames, transcript)

    totals = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "calls": 0}

    def _call() -> str:
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_blocks,
            messages=[{"role": "user", "content": user_content}],
        )
        u = getattr(resp, "usage", None)
        totals["calls"] += 1
        for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            totals[k] += int(getattr(u, k, 0) or 0)
        for block in resp.content:
            if block.type == "text":
                return block.text
        return ""

    raw = _call()
    try:
        desc = _parse_json_title(raw)
    except (json.JSONDecodeError, ValueError):
        raw = _call()
        desc = _parse_json_title(raw)
    return VideoDescription(desc.title, desc.summary, desc.tags, usage=Usage(**totals))


def describe_path(
    client: anthropic.Anthropic,
    path: Path,
    frames: list[Image.Image],
    model: str,
    transcript: str | None = None,
) -> VideoDescription:
    """Convenience wrapper that keeps the path out of the prompt (privacy)."""
    del path  # Reserved for future use (logging, custom prompts).
    return describe_video(client, frames, model=model, transcript=transcript)
