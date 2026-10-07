"""Unit tests: no network, no credential, no Tunnelblick, no side effect outside a temp dir.

Run: poetry run python -m unittest discover -s tests
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from typer.testing import CliRunner

from nordvpn import audit as audit_mod
from nordvpn import cli
from nordvpn.utils import credentials as creds_mod
from nordvpn.vpn.config_manager import config_name_for, normalize_hostname
from nordvpn.vpn.tunnelblick import TunnelblickController, TunnelblickError

TOOL_DIR = Path(__file__).resolve().parent.parent
runner = CliRunner()


class TiersMatchManifest(unittest.TestCase):
    """The manifest's verbs[] and the code's VERBS table must agree (CONTRIBUTING: S1/S2)."""

    def test_manifest_verbs_match_code(self):
        manifest = json.loads((TOOL_DIR / "toolbelt.json").read_text())
        declared = {v["name"]: v for v in manifest["verbs"] if v["tier"] != "never"}
        self.assertEqual(set(declared), set(cli.VERBS))
        for name, spec in cli.VERBS.items():
            self.assertEqual(declared[name]["tier"], spec["tier"], name)
            self.assertEqual(declared[name].get("gate"), spec.get("gate"), name)

    def test_typer_commands_are_all_tiered(self):
        names = {c.name or c.callback.__name__ for c in cli.app.registered_commands}
        self.assertEqual(names, set(cli.VERBS))


class Hostnames(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_hostname("us5090"), "us5090.nordvpn.com")
        self.assertEqual(normalize_hostname("US5090.nordvpn.com"), "us5090.nordvpn.com")
        self.assertEqual(config_name_for("uk12"), "uk12.nordvpn.com.udp")

    def test_rejects_applescript_injection(self):
        for bad in ['us1" & quit & "', "us1; rm", "evil.example.com", "", "us"]:
            with self.assertRaises(ValueError):
                normalize_hostname(bad)

    def test_controller_refuses_quoted_config_name(self):
        with self.assertRaises(TunnelblickError):
            TunnelblickController.connect('a" & quit & "', wait=False)
        with self.assertRaises(TunnelblickError):
            TunnelblickController.disconnect_config('a" & quit & "')


class Ceilings(unittest.TestCase):
    def test_constants(self):
        self.assertEqual(cli.MAX_LIMIT, 50)
        self.assertEqual(cli.DEFAULT_LIMIT, 10)
        self.assertEqual(cli.CONNECT_TIMEOUT_S, 30)

    def test_limit_above_ceiling_is_refused_before_any_network(self):
        with mock.patch("nordvpn.cli.NordVPNClient") as client:
            r = runner.invoke(cli.app, ["servers", "-c", "US", "--limit", str(cli.MAX_LIMIT + 1)])
            client.assert_not_called()
        self.assertEqual(r.exit_code, cli.EXIT_USAGE)

    def test_bad_country_code_is_usage(self):
        with mock.patch("nordvpn.cli.NordVPNClient") as client:
            r = runner.invoke(cli.app, ["servers", "-c", "USA"])
            client.assert_not_called()
        self.assertEqual(r.exit_code, cli.EXIT_USAGE)


class Credentials(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.missing = self.dir / "absent.env"

    def tearDown(self):
        self.tmp.cleanup()

    def _resolve(self, env=None, cred=None, legacy=None, keychain=lambda: None, warn=None):
        warnings = []
        c = creds_mod.get_credentials(
            env=env or {},
            credential_file=cred or self.missing,
            legacy_file=legacy or self.missing,
            keychain=keychain,
            warn=warnings.append,
        )
        return c, warnings

    def test_env_wins(self):
        c, _ = self._resolve(env={"NORD_USER": "u", "NORD_PASS": "p"})
        self.assertEqual((c.username, c.password, c.source), ("u", "p", "env"))

    def test_600_file_is_read(self):
        f = self.dir / "nordvpn.env"
        f.write_text("NORD_USER=fu\nNORD_PASS=fp\n")
        os.chmod(f, 0o600)
        c, w = self._resolve(cred=f)
        self.assertEqual((c.username, c.password), ("fu", "fp"))
        self.assertEqual(w, [])

    def test_loose_file_is_refused(self):
        f = self.dir / "nordvpn.env"
        f.write_text("NORD_USER=fu\nNORD_PASS=fp\n")
        os.chmod(f, 0o644)
        with self.assertRaisesRegex(creds_mod.CredentialsError, "chmod 600"):
            self._resolve(cred=f)

    def test_keychain_after_file(self):
        c, _ = self._resolve(keychain=lambda: ("ku", "kp"))
        self.assertEqual(c.source, f"keychain:{creds_mod.KEYCHAIN_SERVICE}")

    def test_legacy_in_tree_env_warns(self):
        f = self.dir / ".env"
        f.write_text("NORD_USER=lu\nNORD_PASS=lp\n")
        os.chmod(f, 0o600)
        c, w = self._resolve(legacy=f)
        self.assertEqual(c.username, "lu")
        self.assertEqual(len(w), 1)
        self.assertIn("deprecated", w[0])

    def test_nothing_configured_names_every_store_and_no_value(self):
        with self.assertRaises(creds_mod.CredentialsError) as cm:
            self._resolve()
        msg = str(cm.exception)
        self.assertIn(creds_mod.KEYCHAIN_SERVICE, msg)
        self.assertIn("chmod 600", msg)

    def test_repr_never_shows_values(self):
        self.assertNotIn("hunter2", repr(creds_mod.Credentials("me", "hunter2")))


class Audit(unittest.TestCase):
    def test_line_format(self):
        when = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)
        line = audit_mod.format_line("connect", "us5090.nordvpn.com.udp", "connected", when)
        self.assertEqual(
            line, "[nordvpn audit] 2026-08-22T12:00:00Z verb=connect target=us5090.nordvpn.com.udp result=connected"
        )

    def test_append_creates_600_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "data" / "audit.log"
            audit_mod.audit("disconnect", "all", "disconnected", path=p)
            audit_mod.audit("connect", "x", "connected", path=p)
            self.assertEqual(oct(p.stat().st_mode & 0o777), "0o600")
            lines = p.read_text().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertTrue(all(re.match(r"^\[nordvpn audit\] \d{4}-", l) for l in lines))


class FlagGate(unittest.TestCase):
    """connect/disconnect preview without --yes and touch nothing."""

    def test_connect_without_target_is_usage(self):
        r = runner.invoke(cli.app, ["connect"])
        self.assertEqual(r.exit_code, cli.EXIT_USAGE)

    def test_connect_bad_server_is_usage_before_tunnelblick(self):
        with mock.patch.object(TunnelblickController, "is_installed") as inst:
            r = runner.invoke(cli.app, ["connect", "--server", 'x" & quit & "'])
            inst.assert_not_called()
        self.assertEqual(r.exit_code, cli.EXIT_USAGE)

    def test_connect_previews_and_does_not_connect(self):
        with mock.patch.object(TunnelblickController, "is_installed", return_value=True), \
             mock.patch.object(TunnelblickController, "is_running", return_value=True), \
             mock.patch.object(TunnelblickController, "list_configs", return_value=["us5090.nordvpn.com.udp"]), \
             mock.patch.object(TunnelblickController, "get_status") as st, \
             mock.patch.object(TunnelblickController, "connect") as connect, \
             mock.patch("nordvpn.cli.get_credentials", return_value=creds_mod.Credentials("u", "p", "env")), \
             mock.patch("nordvpn.cli.ConfigManager") as cm, \
             mock.patch("nordvpn.cli.audit") as aud:
            st.return_value.state = cli.ConnectionState.DISCONNECTED
            cm.return_value.config_dir = "/tmp/x"
            r = runner.invoke(cli.app, ["connect", "--server", "us5090"])
            connect.assert_not_called()
            aud.assert_not_called()
        self.assertEqual(r.exit_code, 0, r.output)
        self.assertIn("nothing changed", r.output)
        self.assertIn("nordvpn connect --server us5090.nordvpn.com --yes", r.output)
        self.assertNotIn("hunter", r.output)

    def test_connect_yes_connects_and_audits(self):
        with mock.patch.object(TunnelblickController, "is_installed", return_value=True), \
             mock.patch.object(TunnelblickController, "is_running", return_value=True), \
             mock.patch.object(TunnelblickController, "list_configs", return_value=["us5090.nordvpn.com.udp"]), \
             mock.patch.object(TunnelblickController, "get_status") as st, \
             mock.patch.object(TunnelblickController, "connect", return_value=True) as connect, \
             mock.patch("nordvpn.cli.get_credentials", return_value=creds_mod.Credentials("u", "p", "env")), \
             mock.patch("nordvpn.cli.ConfigManager"), \
             mock.patch("nordvpn.cli.get_connection_status") as gcs, \
             mock.patch("nordvpn.cli.audit") as aud:
            st.return_value.state = cli.ConnectionState.DISCONNECTED
            async def fake_status():
                return mock.Mock(public_ip=None)
            gcs.side_effect = fake_status
            r = runner.invoke(cli.app, ["connect", "--server", "us5090", "--yes"])
            connect.assert_called_once_with("us5090.nordvpn.com.udp", wait=True, timeout=cli.CONNECT_TIMEOUT_S)
            aud.assert_called_once_with("connect", "us5090.nordvpn.com.udp", "connected")
        self.assertEqual(r.exit_code, 0, r.output)

    def test_disconnect_previews(self):
        with mock.patch.object(TunnelblickController, "is_installed", return_value=True), \
             mock.patch.object(TunnelblickController, "is_running", return_value=True), \
             mock.patch.object(TunnelblickController, "get_status") as st, \
             mock.patch.object(TunnelblickController, "disconnect") as dc, \
             mock.patch("nordvpn.cli.audit") as aud:
            st.return_value.state = cli.ConnectionState.CONNECTED
            st.return_value.config_name = "us5090.nordvpn.com.udp"
            r = runner.invoke(cli.app, ["disconnect"])
            dc.assert_not_called()
            aud.assert_not_called()
        self.assertEqual(r.exit_code, 0, r.output)
        self.assertIn("nordvpn disconnect --yes", r.output)

    def test_disconnect_yes_audits(self):
        with mock.patch.object(TunnelblickController, "is_installed", return_value=True), \
             mock.patch.object(TunnelblickController, "is_running", return_value=True), \
             mock.patch.object(TunnelblickController, "get_status") as st, \
             mock.patch.object(TunnelblickController, "disconnect", return_value=True), \
             mock.patch("nordvpn.cli.audit") as aud:
            st.return_value.state = cli.ConnectionState.CONNECTED
            st.return_value.config_name = "us5090.nordvpn.com.udp"
            r = runner.invoke(cli.app, ["disconnect", "--yes"])
            aud.assert_called_once_with("disconnect", "us5090.nordvpn.com.udp", "disconnected")
        self.assertEqual(r.exit_code, 0, r.output)


class StatusDegrades(unittest.TestCase):
    def test_status_does_not_launch_tunnelblick(self):
        with mock.patch.object(TunnelblickController, "is_installed", return_value=True), \
             mock.patch.object(TunnelblickController, "is_running", return_value=False), \
             mock.patch.object(TunnelblickController, "launch") as launch:
            r = runner.invoke(cli.app, ["status"])
            launch.assert_not_called()
        self.assertEqual(r.exit_code, 0)
        self.assertIn("not running", r.output)


if __name__ == "__main__":
    unittest.main()
