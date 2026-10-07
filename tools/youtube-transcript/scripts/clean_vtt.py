#!/usr/bin/env python3
"""Convert a YouTube VTT caption file into a clean, timestamped transcript.

Handles both formats YouTube serves:
- Rolling auto-captions: each cue repeats the previous line and carries the new
  words in a line with inline <c>/<00:00:00.000> timing tags.
- Plain (manual) captions: each cue is unique text, possibly multi-line.

Output: markdown paragraphs to stdout, one per speaker turn (">>" marker) or
~45 seconds of speech, each prefixed with a bold [MM:SS] timestamp.

Usage: python3 clean_vtt.py captions.en.vtt > transcript-body.md
"""
import html
import re
import sys

TS_RE = re.compile(r"^(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> ")
TAG_RE = re.compile(r"<[^>]+>")
INLINE_TIMING_RE = re.compile(r"<\d\d:\d\d:\d\d\.\d\d\d>")


def parse_cues(path):
    """Yield (start_seconds, [payload lines]) per cue."""
    cur_start = None
    payload = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            m = TS_RE.match(line)
            if m:
                if cur_start is not None:
                    yield cur_start, payload
                h, mnt, s, ms = map(int, m.groups())
                cur_start = h * 3600 + mnt * 60 + s + ms / 1000
                payload = []
            elif line.strip() and not line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")):
                payload.append(line)
    if cur_start is not None:
        yield cur_start, payload


def main(path):
    cues = list(parse_cues(path))
    rolling = any(
        "<c>" in line or INLINE_TIMING_RE.search(line)
        for _, payload in cues
        for line in payload
    )

    chunks = []  # (seconds, text)
    for start, payload in cues:
        if rolling:
            # The line carrying timing tags (or the last line) holds this cue's
            # new words; other lines are re-shows of the previous cue.
            new_line = None
            for line in payload:
                if "<c>" in line or INLINE_TIMING_RE.search(line):
                    new_line = line
            if new_line is None and payload:
                new_line = payload[-1]
            lines = [new_line] if new_line else []
        else:
            lines = [" ".join(payload)]
        for line in lines:
            text = html.unescape(TAG_RE.sub("", line)).strip()
            if text:
                chunks.append((start, text))

    # Rolling cues re-show identical text; drop consecutive repeats.
    deduped = []
    for ts, text in chunks:
        if deduped and deduped[-1][1] == text:
            continue
        deduped.append((ts, text))

    # Group into paragraphs: break on speaker change (">>") or every ~45s.
    paras = []
    cur = None
    for ts, text in deduped:
        speaker_change = text.startswith(">>")
        text = text.lstrip("> ").strip()
        if not text:
            continue
        if cur is None or speaker_change or ts - cur["start"] > 45:
            if cur:
                paras.append(cur)
            cur = {"start": ts, "parts": []}
        cur["parts"].append(text)
    if cur:
        paras.append(cur)

    for p in paras:
        ts = int(p["start"])
        stamp = f"[{ts // 60:02d}:{ts % 60:02d}]"
        body = re.sub(r"\s+", " ", " ".join(p["parts"])).strip()
        print(f"**{stamp}** {body}\n")


if __name__ == "__main__":
    main(sys.argv[1])
