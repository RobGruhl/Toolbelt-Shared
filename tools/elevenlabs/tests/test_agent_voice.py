"""Unit tests: no network, no credential, no server. Run: poetry run python -m unittest discover -s tests"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from click.testing import CliRunner

from agent_voice import audit, config, hook_install, models
from agent_voice.cli import cli

ROOT = Path(__file__).resolve().parent.parent


class Ceilings(unittest.TestCase):
    def test_constants(self):
        self.assertEqual(config.MAX_CHARS, 1000)
        self.assertEqual(config.CONFIRM_CHARS, 400)
        self.assertEqual(config.HOOK_CHARS, 200)
        self.assertEqual(models.MAX_CHARS, config.MAX_CHARS)
        self.assertLess(config.CONFIRM_CHARS, config.MAX_CHARS)

    def test_request_model_refuses_oversize(self):
        models.SpeakRequest(text="x" * config.MAX_CHARS)
        with self.assertRaises(Exception):
            models.SpeakRequest(text="x" * (config.MAX_CHARS + 1))

    def test_hook_caps_chars(self):
        src = (ROOT / "scripts" / "agent-voice-hook.sh").read_text()
        self.assertIn(f"[:{config.HOOK_CHARS}]", src)


class MusicCli(unittest.TestCase):
    def test_previews_without_yes_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            r = CliRunner().invoke(cli, ["music", "a waltz", "--out", d, "--seconds", "30"])
            self.assertEqual(r.exit_code, 2)
            self.assertEqual(json.loads(r.stdout)["seconds"], 30)
            self.assertEqual(os.listdir(d), [])

    def test_over_ceiling_refused(self):
        r = CliRunner().invoke(cli, ["music", "x", "--out", "/tmp", "--seconds", str(config.MAX_MUSIC_SECONDS + 1), "--yes"])
        self.assertEqual(r.exit_code, 2)
        self.assertIn("MAX_MUSIC_SECONDS", r.output)

    def test_refuses_overwrite_and_bad_name(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "taken.mp3").write_bytes(b"")
            self.assertEqual(CliRunner().invoke(cli, ["music", "x", "--out", d, "--name", "taken", "--yes"]).exit_code, 2)
            self.assertEqual(CliRunner().invoke(cli, ["music", "x", "--out", d, "--name", "../up", "--yes"]).exit_code, 2)


class SpeakCli(unittest.TestCase):
    def test_dry_run_calls_nothing(self):
        r = CliRunner().invoke(cli, ["speak", "hello there", "--dry-run"])
        self.assertEqual(r.exit_code, 0, r.output)
        plan = json.loads(r.stdout)
        self.assertEqual(plan["chars"], 11)
        self.assertEqual(plan["max_chars"], config.MAX_CHARS)

    def test_over_ceiling_refused(self):
        r = CliRunner().invoke(cli, ["speak", "x" * (config.MAX_CHARS + 1), "--yes"])
        self.assertEqual(r.exit_code, 2)

    def test_confirm_threshold_needs_yes(self):
        r = CliRunner().invoke(cli, ["speak", "x" * (config.CONFIRM_CHARS + 1)])
        self.assertEqual(r.exit_code, 2)
        self.assertIn("--yes", r.output)


class VoiceAddCli(unittest.TestCase):
    def test_no_yes_creates_nothing(self):
        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            r = CliRunner().invoke(cli, ["voice-add", "Test", f.name])
            self.assertEqual(r.exit_code, 2)
            self.assertIn("--yes", r.output)
            r = CliRunner().invoke(cli, ["voice-add", "Test", f.name, "--dry-run"])
            self.assertEqual(r.exit_code, 0, r.output)


class HookInstall(unittest.TestCase):
    def test_plan_and_apply_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            settings = Path(d) / "settings.json"
            hook = Path(d) / "hooks" / hook_install.HOOK_NAME
            settings.write_text(json.dumps({"permissions": {"allow": ["Bash(ls)"]}}))
            p = hook_install.plan(settings, hook, uninstall=False)
            self.assertTrue(p["settings_changes"])
            self.assertTrue(p["script_action"].startswith("create"))
            # plan() wrote nothing
            self.assertFalse(hook.exists())
            self.assertNotIn("hooks", json.loads(settings.read_text()))

            done = hook_install.apply(settings, hook, uninstall=False)
            self.assertEqual(len(done), 2)
            after = json.loads(settings.read_text())
            self.assertEqual(after["permissions"]["allow"], ["Bash(ls)"])
            self.assertTrue(hook_install.is_installed(after, hook))
            self.assertEqual(hook.read_bytes(), hook_install.hook_source().read_bytes())
            self.assertEqual(oct(hook.stat().st_mode & 0o777), "0o755")

            # idempotent
            self.assertEqual(hook_install.apply(settings, hook, uninstall=False), [])

            done = hook_install.apply(settings, hook, uninstall=True)
            self.assertEqual(len(done), 2)
            self.assertFalse(hook.exists())
            self.assertNotIn("hooks", json.loads(settings.read_text()))

    def test_setup_cli_previews_without_yes(self):
        with tempfile.TemporaryDirectory() as d:
            home = os.environ.get("HOME")
            os.environ["HOME"] = d
            try:
                r = CliRunner().invoke(cli, ["setup"])
                self.assertEqual(r.exit_code, 0, r.output)
                self.assertIn("preview only", r.output)
                self.assertFalse((Path(d) / ".claude").exists())
            finally:
                os.environ["HOME"] = home


class Audit(unittest.TestCase):
    def test_line_and_file(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "audit.log"
            os.environ["AGENT_VOICE_AUDIT_LOG"] = str(log)
            try:
                line = audit.audit("speak", chars=42, voice="v1")
            finally:
                del os.environ["AGENT_VOICE_AUDIT_LOG"]
            self.assertIn("verb=speak", line)
            self.assertIn("chars=42", line)
            self.assertEqual(log.read_text().strip(), line)
            self.assertEqual(oct(log.stat().st_mode & 0o777), "0o600")


class KeyResolution(unittest.TestCase):
    def test_loose_file_refused(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "elevenlabs.env"
            f.write_text("ELEVENLABS_API_KEY=not-a-real-key\n")
            f.chmod(0o644)
            with self.assertRaises(ValueError):
                config._refuse_loose(f)
            f.chmod(0o600)
            config._refuse_loose(f)
            self.assertEqual(config._read_dotenv_value(f, "ELEVENLABS_API_KEY"), "not-a-real-key")


if __name__ == "__main__":
    unittest.main()
