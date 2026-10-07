"""Core TTS speaker using ElevenLabs streaming API."""

from elevenlabs import ElevenLabs

from .audit import audit
from .config import MAX_CHARS, get_api_key
from .models import AgentVoiceProfile, ServerConfig, SpeakRequest
from .playback import AudioPlayback


class AgentSpeaker:
    """Speaks text using ElevenLabs TTS with per-agent voice profiles."""

    def __init__(self, config: ServerConfig):
        self.config = config
        self.client = ElevenLabs(api_key=get_api_key())
        self.playback = AudioPlayback(sample_rate=24000)
        self._default_voice = AgentVoiceProfile(
            voice_id=config.default_voice_id,
        )

    def resolve_voice(self, agent_type: str) -> AgentVoiceProfile:
        return self.config.voices.get(agent_type, self._default_voice)

    def speak(self, request: SpeakRequest) -> None:
        """Generate speech and play it. Blocks until playback finishes. Paid call: audited."""
        voice = self.resolve_voice(request.agent_type)
        text = self._prepare_text(request.text, request.tags, voice.tags)

        if not text.strip():
            return
        if len(text) > MAX_CHARS:
            # The request model already refuses this; the check here is the ceiling's last
            # line in case a caller bypasses the model.
            raise ValueError(f"text is {len(text)} chars; MAX_CHARS is {MAX_CHARS}")

        audit(
            "speak",
            agent=request.agent_type,
            voice=voice.voice_id,
            model=voice.model_id,
            chars=len(text),
        )
        audio_stream = self.client.text_to_speech.stream(
            voice_id=voice.voice_id,
            text=text,
            model_id=voice.model_id,
            output_format=self.config.output_format,
            optimize_streaming_latency=4,
        )

        self.playback.play_stream(audio_stream)

    def stop(self) -> None:
        """Stop current playback."""
        self.playback.stop()

    @staticmethod
    def _prepare_text(text: str, request_tags: list[str], voice_tags: list[str]) -> str:
        """Prepend audio tags if text doesn't already start with tags."""
        if text.strip().startswith("["):
            return text
        tags = request_tags or voice_tags
        if tags:
            tag_str = " ".join(f"[{t}]" for t in tags)
            return f"{tag_str} {text}"
        return text
