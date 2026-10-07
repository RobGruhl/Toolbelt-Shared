# whisper.cpp Backend Setup

hello-transcription uses the whisper.cpp HTTP server as its transcription backend.
This document covers how it's set up on this system.

## Service Details

| Property | Value |
|----------|-------|
| Endpoint | `http://127.0.0.1:2022/v1/audio/transcriptions` |
| Health check | `http://127.0.0.1:2022/health` |
| Model | `ggml-large-v3-turbo.bin` |
| Acceleration | Metal (Apple Silicon GPU) |
| API compatibility | OpenAI Whisper API format |

## Lifecycle

The whisper.cpp service is managed through Voice Mode's service manager:

```bash
# Check status
mcp__voice-mode__service whisper status

# Start the service
mcp__voice-mode__service whisper start

# Stop the service
mcp__voice-mode__service whisper stop

# View logs
mcp__voice-mode__service whisper logs
```

From outside Claude Code, use `curl` to verify:

```bash
curl http://127.0.0.1:2022/health
```

## API Usage

The endpoint accepts multipart/form-data with an audio file:

```bash
curl http://127.0.0.1:2022/v1/audio/transcriptions \
  -F file=@recording.mp3 \
  -F model=ggml-large-v3-turbo.bin \
  -F language=en \
  -F response_format=json
```

### Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `file` | Audio file (mp3, m4a, wav, etc.) | Required |
| `model` | Model name (informational) | `ggml-large-v3-turbo.bin` |
| `language` | ISO language code | Auto-detect |
| `prompt` | Vocabulary hints for recognition | None |
| `response_format` | `json`, `text`, `srt`, `vtt`, `verbose_json` | `json` |
| `temperature` | Sampling temperature (0.0-1.0) | 0.0 |

### Response Formats

- **text** — Plain transcription text
- **json** — `{"text": "...", "language": "en", "duration": 123.4}`
- **verbose_json** — Includes word-level timestamps and segments
- **srt** — SubRip subtitle format
- **vtt** — WebVTT subtitle format

## Performance Notes

- Metal acceleration provides 8-12x speedup over CPU on Apple Silicon
- The `large-v3-turbo` model balances speed and quality well
- 10-minute timeout default (`config.timeout: 600`) handles files up to ~2 hours
- ffmpeg can preprocess non-standard audio formats before sending to whisper.cpp
