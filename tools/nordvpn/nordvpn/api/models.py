"""Pydantic models for NordVPN API responses."""

from pydantic import BaseModel, Field


class Technology(BaseModel):
    """VPN technology (OpenVPN, IKEv2, etc.)."""

    id: int
    name: str
    identifier: str


class City(BaseModel):
    """City within a country."""

    id: int
    name: str
    latitude: float
    longitude: float
    dns_name: str | None = None
    hub_score: int | None = None


class Country(BaseModel):
    """Country with VPN servers."""

    id: int
    name: str
    code: str
    city: City | None = None  # City is nested inside country in API response


class ServerLocation(BaseModel):
    """Full location info for a server."""

    id: int
    country: Country
    latitude: float
    longitude: float


class ServerIP(BaseModel):
    """Server IP address entry."""

    id: int
    ip: str
    version: int


class Server(BaseModel):
    """NordVPN server."""

    id: int
    name: str
    station: str  # e.g., "us5090.nordvpn.com"
    hostname: str
    load: int
    status: str
    locations: list[ServerLocation] = Field(default_factory=list)
    technologies: list[Technology] = Field(default_factory=list)
    ips: list[ServerIP] = Field(default_factory=list)

    @property
    def country(self) -> Country | None:
        """Get the server's country."""
        if self.locations:
            return self.locations[0].country
        return None

    @property
    def city(self) -> City | None:
        """Get the server's city."""
        if self.locations and self.locations[0].country.city:
            return self.locations[0].country.city
        return None

    @property
    def country_code(self) -> str:
        """Get two-letter country code."""
        if self.country:
            return self.country.code.upper()
        return ""

    @property
    def city_name(self) -> str:
        """Get city name if available."""
        if self.city:
            return self.city.name
        return ""

    def supports_openvpn_udp(self) -> bool:
        """Check if server supports OpenVPN UDP."""
        return any(t.identifier == "openvpn_udp" for t in self.technologies)

    def supports_openvpn_tcp(self) -> bool:
        """Check if server supports OpenVPN TCP."""
        return any(t.identifier == "openvpn_tcp" for t in self.technologies)


class RecommendedServer(BaseModel):
    """Server from recommendations endpoint (simplified structure)."""

    id: int
    name: str
    station: str
    hostname: str
    load: int
    status: str
    locations: list[ServerLocation] = Field(default_factory=list)
    technologies: list[Technology] = Field(default_factory=list)

    @property
    def country(self) -> Country | None:
        if self.locations:
            return self.locations[0].country
        return None

    @property
    def city(self) -> City | None:
        if self.locations and self.locations[0].country.city:
            return self.locations[0].country.city
        return None
