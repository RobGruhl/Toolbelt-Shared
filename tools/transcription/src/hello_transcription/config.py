"""Configuration management with YAML presets."""

from pathlib import Path
from typing import Self

import yaml
from pydantic import BaseModel, Field


class TranscriptionConfig(BaseModel):
    """Configuration for a transcription job."""

    # Backend settings
    backend: str = "whisper_cpp"
    base_url: str = "http://127.0.0.1:2022"
    timeout: float = 600.0

    # Transcription settings
    language: str | None = None
    prompt: str | None = None
    timestamps: bool = False

    # Output settings
    output_format: str = "txt"
    output_dir: Path | None = None

    # Preset metadata
    name: str = Field(default="default")
    description: str = Field(default="")

    @classmethod
    def from_yaml(cls, path: Path) -> Self:
        """Load configuration from a YAML file."""
        with open(path) as f:
            data = yaml.safe_load(f)
        return cls.model_validate(data)

    @classmethod
    def load_preset(cls, preset_name: str, configs_dir: Path | None = None) -> Self:
        """Load a named preset from the configs directory."""
        if configs_dir is None:
            # Default to configs/ relative to package
            configs_dir = Path(__file__).parent.parent.parent / "configs"

        preset_path = configs_dir / f"{preset_name}.yaml"
        if not preset_path.exists():
            raise FileNotFoundError(f"Preset not found: {preset_name}")

        return cls.from_yaml(preset_path)

    def merge(self, **overrides: object) -> Self:
        """Create a new config with overrides applied."""
        data = self.model_dump()
        # Only apply non-None overrides
        for key, value in overrides.items():
            if value is not None:
                data[key] = value
        return self.model_validate(data)
