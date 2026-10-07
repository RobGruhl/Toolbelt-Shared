"""Paragraph grouping post-processor using Claude for intelligent formatting."""

import subprocess
import json


def _chunk_lines(text: str, chunk_size: int = 50) -> list[str]:
    """Split text into chunks of approximately chunk_size lines.

    Args:
        text: The full transcription text.
        chunk_size: Target number of lines per chunk.

    Returns:
        List of text chunks.
    """
    lines = text.strip().split("\n")
    chunks = []

    for i in range(0, len(lines), chunk_size):
        chunk = "\n".join(lines[i : i + chunk_size])
        chunks.append(chunk)

    return chunks


def _call_claude_for_paragraphs(text_chunk: str) -> str:
    """Use Claude CLI to group lines into natural paragraphs.

    Args:
        text_chunk: A chunk of transcription text (line-by-line).

    Returns:
        The same text reorganized into paragraphs.
    """
    prompt = f"""You are a transcription formatter. Your task is to take line-by-line transcription output and group it into natural paragraphs.

Rules:
1. Preserve ALL original text exactly - do not add, remove, or modify any words
2. Group sentences into paragraphs based on:
   - Topic shifts (new subject = new paragraph)
   - Speaker changes (if detectable from context)
   - Natural conversation flow and pauses
3. Separate paragraphs with a blank line
4. Keep paragraphs reasonably sized (3-7 sentences typically)
5. Output ONLY the reformatted text, no explanations

Input transcription:
{text_chunk}

Output the reformatted paragraphs:"""

    # Call claude CLI in non-interactive mode. Text-only task: no permission bypass is
    # needed, and granting one to a prompt that carries transcript content would be egress
    # of untrusted input into a tool-capable session.
    result = subprocess.run(
        ["claude", "--print", "-p", prompt],
        capture_output=True,
        text=True,
        timeout=120,
    )

    if result.returncode != 0:
        # Fall back to original text if Claude fails
        return text_chunk

    return result.stdout.strip()


def group_paragraphs(text: str, chunk_size: int = 50) -> str:
    """Group transcription text into natural paragraphs using Claude.

    Takes raw line-by-line transcription output and uses Claude to
    intelligently group sentences into paragraphs based on topic shifts,
    speaker changes, and natural conversation flow.

    Args:
        text: Raw transcription text (typically line-by-line from whisper).
        chunk_size: Number of lines to process at once (default 50).

    Returns:
        Text reformatted with natural paragraph breaks.
    """
    # Handle empty or very short text
    if not text or len(text.strip().split("\n")) <= 3:
        return text

    # Split into manageable chunks
    chunks = _chunk_lines(text, chunk_size)

    # Process each chunk
    processed_chunks = []
    for chunk in chunks:
        processed = _call_claude_for_paragraphs(chunk)
        processed_chunks.append(processed)

    # Reassemble with paragraph breaks between chunks
    return "\n\n".join(processed_chunks)
