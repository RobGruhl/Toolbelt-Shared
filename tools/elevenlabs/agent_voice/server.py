"""FastAPI server for agent voice narration. Binds 127.0.0.1 only."""

import logging
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI

from .config import MAX_CHARS, load_config
from .models import SpeakRequest
from .speaker import AgentSpeaker

logger = logging.getLogger("agent_voice")

speaker: AgentSpeaker | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global speaker
    config = load_config()
    speaker = AgentSpeaker(config)
    logger.info(f"Agent voice server started on port {config.port}")
    yield
    speaker.stop()


app = FastAPI(title="Agent Voice", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.post("/speak")
async def speak(request: SpeakRequest, background_tasks: BackgroundTasks):
    """Speak text using agent voice. Returns immediately, plays in background.

    Bodies above MAX_CHARS never reach here: SpeakRequest refuses them with a 422.
    """
    background_tasks.add_task(speaker.speak, request)
    return {"status": "speaking", "chars": len(request.text), "max_chars": MAX_CHARS}


@app.post("/stop")
async def stop():
    """Stop currently playing audio."""
    speaker.stop()
    return {"status": "stopped"}


@app.get("/health")
async def health():
    """Check server status."""
    return {"status": "ok", "max_chars": MAX_CHARS}


def main():
    """Run the server."""
    import uvicorn

    config = load_config()
    uvicorn.run(
        "agent_voice.server:app",
        host="127.0.0.1",
        port=config.port,
        log_level="warning",
    )
