"""Connection status detection."""

import re
import subprocess
from dataclasses import dataclass

import httpx


@dataclass
class ConnectionStatus:
    """VPN connection status information."""

    connected: bool
    config_name: str | None = None
    server_hostname: str | None = None
    public_ip: str | None = None
    country: str | None = None
    city: str | None = None
    load: int | None = None

    def __str__(self) -> str:
        if not self.connected:
            return "Disconnected"

        parts = [f"Connected to {self.server_hostname or 'unknown'}"]
        if self.city:
            parts.append(f"({self.city})")
        elif self.country:
            parts.append(f"({self.country})")
        if self.load is not None:
            parts.append(f"| Load: {self.load}%")
        if self.public_ip:
            parts.append(f"| IP: {self.public_ip}")

        return " ".join(parts)


def _extract_hostname_from_config(config_name: str) -> str | None:
    """Extract server hostname from Tunnelblick config name.

    Config names are like "us5090.nordvpn.com.udp" or "us5090.nordvpn.com.tcp"
    """
    match = re.match(r"^([a-z]{2}\d+\.nordvpn\.com)", config_name, re.IGNORECASE)
    if match:
        return match.group(1)
    return None


async def get_public_ip() -> str | None:
    """Get current public IP address."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Use a simple IP echo service
            response = await client.get("https://api.ipify.org")
            if response.status_code == 200:
                return response.text.strip()
    except Exception:
        pass
    return None


async def get_ip_info(ip: str) -> dict | None:
    """Get geolocation info for an IP address."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"https://ipinfo.io/{ip}/json")
            if response.status_code == 200:
                return response.json()
    except Exception:
        pass
    return None


def get_vpn_interface() -> str | None:
    """Detect active VPN network interface.

    OpenVPN typically creates utun interfaces on macOS.
    """
    result = subprocess.run(
        ["ifconfig"],
        capture_output=True,
        text=True,
    )

    # Look for utun interfaces with an inet address
    current_interface = None
    for line in result.stdout.split("\n"):
        if line.startswith("utun"):
            current_interface = line.split(":")[0]
        elif current_interface and "inet " in line and "127." not in line:
            return current_interface
        elif line and not line.startswith("\t"):
            current_interface = None

    return None


async def get_connection_status() -> ConnectionStatus:
    """Get comprehensive VPN connection status."""
    from .tunnelblick import TunnelblickController, ConnectionState

    # Check Tunnelblick status
    tb_status = TunnelblickController.get_status()

    if tb_status.state != ConnectionState.CONNECTED:
        return ConnectionStatus(connected=False)

    # We have a connection
    config_name = tb_status.config_name
    hostname = _extract_hostname_from_config(config_name) if config_name else None

    # Get public IP and location
    public_ip = await get_public_ip()
    city = None
    country = None

    if public_ip:
        ip_info = await get_ip_info(public_ip)
        if ip_info:
            city = ip_info.get("city")
            country = ip_info.get("country")

    # Get server load if we have the hostname
    load = None
    if hostname:
        try:
            from ..api import NordVPNClient

            client = NordVPNClient()
            server = await client.get_server_by_hostname(hostname)
            if server:
                load = server.load
                # Use server's location info if we don't have it from IP
                if not city and server.city:
                    city = server.city.name
                if not country and server.country:
                    country = server.country.name
        except Exception:
            pass

    return ConnectionStatus(
        connected=True,
        config_name=config_name,
        server_hostname=hostname,
        public_ip=public_ip,
        country=country,
        city=city,
        load=load,
    )
