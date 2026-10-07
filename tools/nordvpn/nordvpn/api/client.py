"""NordVPN API client for server discovery."""

import httpx
from .models import Country, Server, RecommendedServer
from ..vpn.config_manager import normalize_hostname


class NordVPNClient:
    """Client for NordVPN's public API."""

    BASE_URL = "https://api.nordvpn.com"

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    async def get_countries(self) -> list[Country]:
        """Get list of all countries with VPN servers."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(f"{self.BASE_URL}/v1/servers/countries")
            response.raise_for_status()
            return [Country(**c) for c in response.json()]

    async def get_country_by_code(self, code: str) -> Country | None:
        """Find a country by its two-letter code."""
        countries = await self.get_countries()
        code = code.upper()
        for country in countries:
            if country.code.upper() == code:
                return country
        return None

    async def get_recommendations(
        self,
        country_id: int | None = None,
        limit: int = 10,
    ) -> list[RecommendedServer]:
        """Get recommended servers, optionally filtered by country.

        The recommendations endpoint returns servers sorted by optimal
        performance (considering load, distance, etc.).
        """
        params: dict[str, str | int] = {"limit": limit}
        if country_id is not None:
            params["filters[country_id]"] = country_id

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.BASE_URL}/v1/servers/recommendations",
                params=params,
            )
            response.raise_for_status()
            return [RecommendedServer(**s) for s in response.json()]

    async def get_servers(
        self,
        limit: int = 100,
        country_id: int | None = None,
    ) -> list[Server]:
        """Get server list with full details."""
        params: dict[str, str | int] = {"limit": limit}
        if country_id is not None:
            params["filters[country_id]"] = country_id

        # Filter for OpenVPN UDP servers (technology id 3)
        params["filters[servers_technologies][identifier]"] = "openvpn_udp"

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.BASE_URL}/v1/servers",
                params=params,
            )
            response.raise_for_status()
            return [Server(**s) for s in response.json()]

    async def find_optimal_server(
        self,
        country_code: str,
        city: str | None = None,
        max_load: int = 30,
    ) -> Server | None:
        """Find the optimal server for a country/city combination.

        Uses the recommendations endpoint which already factors in
        load and performance metrics.
        """
        country = await self.get_country_by_code(country_code)
        if not country:
            return None

        # Get recommendations for this country
        recommendations = await self.get_recommendations(
            country_id=country.id,
            limit=20,
        )

        # Filter by city if specified
        candidates = recommendations
        if city:
            city_lower = city.lower()
            candidates = [
                s for s in recommendations
                if s.city and city_lower in s.city.name.lower()
            ]
            if not candidates:
                # Fall back to all servers if city not found
                candidates = recommendations

        # Find first server under max_load threshold
        for server in candidates:
            if server.load <= max_load:
                # Convert RecommendedServer to Server-like response
                return Server(
                    id=server.id,
                    name=server.name,
                    station=server.station,
                    hostname=server.hostname,
                    load=server.load,
                    status=server.status,
                    locations=server.locations,
                    technologies=server.technologies,
                    ips=[],
                )

        # If no server under threshold, return lowest load
        if candidates:
            best = min(candidates, key=lambda s: s.load)
            return Server(
                id=best.id,
                name=best.name,
                station=best.station,
                hostname=best.hostname,
                load=best.load,
                status=best.status,
                locations=best.locations,
                technologies=best.technologies,
                ips=[],
            )

        return None

    async def get_server_by_hostname(self, hostname: str) -> Server | None:
        """Find a specific server by hostname."""
        hostname = normalize_hostname(hostname)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.BASE_URL}/v1/servers",
                params={
                    "filters[hostname]": hostname,
                    "limit": 1,
                },
            )
            response.raise_for_status()
            servers = response.json()
            if servers:
                return Server(**servers[0])
            return None
