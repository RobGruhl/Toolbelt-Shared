"""Pydantic models for agent voice narration."""

from pydantic import BaseModel, Field

# Mirrors config.MAX_CHARS; defined here too so the server's request validation (a 422 on an
# oversized body) cannot drift from the CLI's refusal. A test asserts they agree.
MAX_CHARS = 1000


class SpeakRequest(BaseModel):
    """Request to speak text via agent voice."""

    text: str = Field(max_length=MAX_CHARS)
    agent_type: str = "default"
    tags: list[str] = []


class AgentVoiceProfile(BaseModel):
    """Voice configuration for an agent type."""

    voice_id: str
    model_id: str = "eleven_flash_v2_5"
    tags: list[str] = []


class ServerConfig(BaseModel):
    """Agent voice server configuration."""

    port: int = 7888
    enabled: bool = True
    default_voice_id: str = "nPczCjzI2devNBz1zQrb"  # Brian
    voices: dict[str, AgentVoiceProfile] = {}
    output_format: str = "pcm_24000"
