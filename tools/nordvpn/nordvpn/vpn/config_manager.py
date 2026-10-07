"""OpenVPN configuration manager for NordVPN."""

import os
import re
import shutil
import zipfile
from pathlib import Path

import httpx

# Where downloaded .ovpn files and the .tblk bundles (which embed the service credentials)
# are staged before Tunnelblick imports them. Outside the repo on purpose: the bundle holds a
# secret, and the tree must hold none (SENSIBILITIES #11). NORDVPN_CONFIG_DIR overrides.
DEFAULT_CONFIG_DIR = Path.home() / ".config" / "toolbelt" / "nordvpn" / "configs"

# A NordVPN hostname is <cc><n>.nordvpn.com. The config name is interpolated into an
# AppleScript string, so anything else is refused before it reaches osascript.
HOSTNAME_RE = re.compile(r"^[a-z]{2,3}\d+(?:\.nordvpn\.com)?$", re.IGNORECASE)


def normalize_hostname(hostname: str) -> str:
    """`us5090` or `us5090.nordvpn.com` -> `us5090.nordvpn.com`; anything else raises."""
    hostname = hostname.strip().lower()
    if not HOSTNAME_RE.match(hostname):
        raise ValueError(
            f"not a NordVPN server hostname: {hostname!r} (expected e.g. us5090 or us5090.nordvpn.com)"
        )
    if not hostname.endswith(".nordvpn.com"):
        hostname = f"{hostname}.nordvpn.com"
    return hostname


def config_name_for(hostname: str) -> str:
    """The Tunnelblick configuration name for a server: `<hostname>.udp`."""
    return f"{normalize_hostname(hostname)}.udp"

# NordVPN OpenVPN config download URL
OVPN_ARCHIVE_URL = "https://downloads.nordcdn.com/configs/archives/servers/ovpn.zip"

# Individual config URL pattern
OVPN_CONFIG_URL = "https://downloads.nordcdn.com/configs/files/ovpn_udp/servers/{hostname}.udp.ovpn"


class ConfigManager:
    """Manage OpenVPN configuration files for NordVPN."""

    def __init__(self, config_dir: Path | None = None):
        """Initialize config manager.

        Args:
            config_dir: Directory to stage configs. Defaults to $NORDVPN_CONFIG_DIR or
                ~/.config/toolbelt/nordvpn/configs (created mode 700).
        """
        if config_dir is None:
            override = os.environ.get("NORDVPN_CONFIG_DIR")
            config_dir = Path(override).expanduser() if override else DEFAULT_CONFIG_DIR
        self.config_dir = config_dir
        self.config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    def get_tunnelblick_config_dir(self) -> Path:
        """Get Tunnelblick's configuration directory."""
        return Path.home() / "Library" / "Application Support" / "Tunnelblick" / "Configurations"

    def get_shared_config_dir(self) -> Path:
        """Get Tunnelblick's shared configuration directory."""
        return Path("/Library/Application Support/Tunnelblick/Shared")

    def list_installed_configs(self) -> list[str]:
        """List configs installed in Tunnelblick."""
        configs = []

        # Check user configs
        user_dir = self.get_tunnelblick_config_dir()
        if user_dir.exists():
            for item in user_dir.iterdir():
                if item.suffix == ".tblk":
                    configs.append(item.stem)

        # Check shared configs
        shared_dir = self.get_shared_config_dir()
        if shared_dir.exists():
            for item in shared_dir.iterdir():
                if item.suffix == ".tblk":
                    configs.append(item.stem)

        return configs

    def config_exists(self, hostname: str) -> bool:
        """Check if a config is already installed in Tunnelblick."""
        # Config names in Tunnelblick are like "us5090.nordvpn.com.udp"
        config_name = self._hostname_to_config_name(hostname)
        installed = self.list_installed_configs()
        return config_name in installed

    def _hostname_to_config_name(self, hostname: str) -> str:
        """Convert hostname to Tunnelblick config name."""
        return config_name_for(hostname)

    async def download_config(self, hostname: str) -> Path:
        """Download OpenVPN config for a specific server.

        Args:
            hostname: Server hostname (e.g., "us5090.nordvpn.com" or "us5090")

        Returns:
            Path to downloaded .ovpn file
        """
        hostname = normalize_hostname(hostname)

        url = OVPN_CONFIG_URL.format(hostname=hostname)
        output_path = self.config_dir / f"{hostname}.udp.ovpn"

        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            output_path.write_bytes(response.content)

        return output_path

    def create_tblk_package(
        self,
        ovpn_path: Path,
        username: str,
        password: str,
    ) -> Path:
        """Create a .tblk package from an .ovpn file.

        Tunnelblick uses .tblk packages which are directories containing
        the .ovpn file and optional credentials.

        Args:
            ovpn_path: Path to .ovpn file
            username: NordVPN service username
            password: NordVPN service password

        Returns:
            Path to created .tblk package
        """
        # Create .tblk directory
        tblk_name = ovpn_path.stem  # e.g., "us5090.nordvpn.com.udp"
        tblk_path = self.config_dir / f"{tblk_name}.tblk"

        if tblk_path.exists():
            shutil.rmtree(tblk_path)

        tblk_path.mkdir()

        # Copy .ovpn file into package
        config_dest = tblk_path / ovpn_path.name
        shutil.copy2(ovpn_path, config_dest)

        # Create credentials file (username on first line, password on second)
        # This file is named after the config with .pass extension
        pass_file = tblk_path / f"{ovpn_path.stem}.pass"
        pass_file.write_text(f"{username}\n{password}\n")

        # Set restrictive permissions on credentials
        os.chmod(pass_file, 0o600)

        # Create autoLogin file to enable auto-login with saved credentials
        (tblk_path / "autoLogin").touch()

        return tblk_path

    def install_config(self, tblk_path: Path) -> bool:
        """Install a .tblk package into Tunnelblick.

        This uses 'open' to let Tunnelblick handle the import.
        User may see a confirmation dialog on first install.

        Args:
            tblk_path: Path to .tblk package

        Returns:
            True if installation initiated successfully
        """
        import subprocess

        result = subprocess.run(
            ["open", str(tblk_path)],
            capture_output=True,
        )
        return result.returncode == 0

    async def setup_server(
        self,
        hostname: str,
        username: str,
        password: str,
    ) -> str:
        """Download, package, and install a server config.

        Args:
            hostname: Server hostname
            username: NordVPN service username
            password: NordVPN service password

        Returns:
            Tunnelblick config name for connecting
        """
        # Download the .ovpn file
        ovpn_path = await self.download_config(hostname)

        # Create .tblk package with credentials
        tblk_path = self.create_tblk_package(ovpn_path, username, password)

        # Install into Tunnelblick
        self.install_config(tblk_path)

        # Return the config name for Tunnelblick
        return self._hostname_to_config_name(hostname)

    async def download_full_archive(self, extract_country: str | None = None) -> Path:
        """Download the full OpenVPN config archive.

        This is ~40MB so only use if you need many configs.

        Args:
            extract_country: If provided, only extract configs for this country code

        Returns:
            Path to extracted configs directory
        """
        archive_path = self.config_dir / "ovpn.zip"

        # Download archive
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            response = await client.get(OVPN_ARCHIVE_URL)
            response.raise_for_status()
            archive_path.write_bytes(response.content)

        # Extract
        extract_dir = self.config_dir / "ovpn_udp"
        if extract_dir.exists():
            shutil.rmtree(extract_dir)

        with zipfile.ZipFile(archive_path, "r") as zf:
            if extract_country:
                # Only extract files matching country code
                country_prefix = f"ovpn_udp/{extract_country.lower()}"
                for name in zf.namelist():
                    if name.startswith(country_prefix) or name == "ovpn_udp/":
                        zf.extract(name, self.config_dir)
            else:
                # Extract UDP configs only
                for name in zf.namelist():
                    if name.startswith("ovpn_udp/"):
                        zf.extract(name, self.config_dir)

        # Clean up archive
        archive_path.unlink()

        return extract_dir
