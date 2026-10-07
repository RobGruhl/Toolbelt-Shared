"""Tunnelblick AppleScript controller."""

import subprocess
import time
from dataclasses import dataclass
from enum import Enum


class ConnectionState(Enum):
    """Tunnelblick connection states."""

    CONNECTED = "CONNECTED"
    EXITING = "EXITING"
    DISCONNECTED = "DISCONNECTED"
    CONNECTING = "CONNECTING"
    SLEEPING = "SLEEPING"
    UNKNOWN = "UNKNOWN"


@dataclass
class TunnelblickStatus:
    """Current Tunnelblick connection status."""

    state: ConnectionState
    config_name: str | None = None
    server_ip: str | None = None


class TunnelblickError(Exception):
    """Error interacting with Tunnelblick."""

    pass


def _run_applescript(script: str) -> str:
    """Execute AppleScript and return result."""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            error = result.stderr.strip()
            if "not running" in error.lower():
                raise TunnelblickError("Tunnelblick is not running. Please start Tunnelblick first.")
            raise TunnelblickError(f"AppleScript error: {error}")
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        raise TunnelblickError("Tunnelblick command timed out")
    except FileNotFoundError:
        raise TunnelblickError("osascript not found - are you on macOS?")


class TunnelblickController:
    """Control Tunnelblick VPN via AppleScript."""

    @staticmethod
    def is_installed() -> bool:
        """Check if Tunnelblick is installed."""
        from pathlib import Path

        # Check common install locations directly (more reliable than mdfind)
        app_paths = [
            Path("/Applications/Tunnelblick.app"),
            Path.home() / "Applications" / "Tunnelblick.app",
        ]
        return any(p.exists() for p in app_paths)

    @staticmethod
    def is_running() -> bool:
        """Check if Tunnelblick is running."""
        result = subprocess.run(
            ["pgrep", "-x", "Tunnelblick"],
            capture_output=True,
        )
        return result.returncode == 0

    @staticmethod
    def launch() -> None:
        """Launch Tunnelblick application."""
        subprocess.run(
            ["open", "-a", "Tunnelblick"],
            check=True,
        )
        # Wait for app to be ready
        time.sleep(2)

    @staticmethod
    def list_configs() -> list[str]:
        """List all installed VPN configurations."""
        script = 'tell application "Tunnelblick" to get name of configurations'
        result = _run_applescript(script)
        if not result:
            return []
        # AppleScript returns comma-separated list
        return [c.strip() for c in result.split(",")]

    @staticmethod
    def connect(config_name: str, wait: bool = True, timeout: int = 30) -> bool:
        """Connect to a VPN configuration.

        Args:
            config_name: Name of the configuration (e.g., "us5090.nordvpn.com.udp")
            wait: Whether to wait for connection to establish
            timeout: Maximum seconds to wait for connection

        Returns:
            True if connection successful, False otherwise
        """
        if '"' in config_name or "\\" in config_name:
            raise TunnelblickError(f"refusing config name with quote characters: {config_name!r}")
        script = f'tell application "Tunnelblick" to connect "{config_name}"'
        _run_applescript(script)

        if not wait:
            return True

        # Poll for connection status
        start = time.time()
        while time.time() - start < timeout:
            status = TunnelblickController.get_status()
            if status.state == ConnectionState.CONNECTED:
                return True
            if status.state == ConnectionState.DISCONNECTED:
                # Connection failed
                return False
            time.sleep(1)

        return False

    @staticmethod
    def disconnect() -> bool:
        """Disconnect all VPN connections."""
        script = 'tell application "Tunnelblick" to disconnect all'
        _run_applescript(script)

        # Wait briefly for disconnect
        time.sleep(1)
        status = TunnelblickController.get_status()
        return status.state == ConnectionState.DISCONNECTED

    @staticmethod
    def disconnect_config(config_name: str) -> bool:
        """Disconnect a specific configuration."""
        if '"' in config_name or "\\" in config_name:
            raise TunnelblickError(f"refusing config name with quote characters: {config_name!r}")
        script = f'tell application "Tunnelblick" to disconnect "{config_name}"'
        _run_applescript(script)
        time.sleep(1)
        return True

    @staticmethod
    def get_status() -> TunnelblickStatus:
        """Get current connection status."""
        # Get state of all configurations
        script = 'tell application "Tunnelblick" to get state of configurations'
        try:
            result = _run_applescript(script)
        except TunnelblickError:
            return TunnelblickStatus(state=ConnectionState.UNKNOWN)

        if not result:
            return TunnelblickStatus(state=ConnectionState.DISCONNECTED)

        states = [s.strip() for s in result.split(",")]

        # Get config names to match with states
        configs = TunnelblickController.list_configs()

        # Find any connected configuration
        for i, state in enumerate(states):
            if state == "CONNECTED" and i < len(configs):
                return TunnelblickStatus(
                    state=ConnectionState.CONNECTED,
                    config_name=configs[i],
                )
            if state == "CONNECTING" and i < len(configs):
                return TunnelblickStatus(
                    state=ConnectionState.CONNECTING,
                    config_name=configs[i],
                )

        return TunnelblickStatus(state=ConnectionState.DISCONNECTED)

    @staticmethod
    def get_connected_config() -> str | None:
        """Get the name of the currently connected configuration."""
        status = TunnelblickController.get_status()
        if status.state == ConnectionState.CONNECTED:
            return status.config_name
        return None
