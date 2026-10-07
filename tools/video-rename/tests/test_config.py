import pytest

from video_analysis.config import resolve_max_edge, resolve_model


def test_resolve_model_alias():
    assert resolve_model("haiku") == "claude-haiku-4-5"
    assert resolve_model("sonnet") == "claude-sonnet-4-6"
    assert resolve_model("opus") == "claude-opus-4-7"


def test_resolve_model_passthrough():
    assert resolve_model("claude-opus-4-7") == "claude-opus-4-7"
    assert resolve_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5-20251001"


def test_resolve_max_edge_presets():
    assert resolve_max_edge("low") == 256
    assert resolve_max_edge("medium") == 512
    assert resolve_max_edge("high") == 768


def test_resolve_max_edge_int_string():
    assert resolve_max_edge("384") == 384


def test_resolve_max_edge_int():
    assert resolve_max_edge(1024) == 1024


def test_resolve_max_edge_bad():
    with pytest.raises(ValueError):
        resolve_max_edge("huge")
