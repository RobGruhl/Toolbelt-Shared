"""CLI commands for NordVPN control.

Tiers (the manifest's verbs[] mirrors VERBS below; tests assert they agree):

  read          status, servers, countries, configs, setup — no gate
  write-gated   connect, disconnect — gate "flag": a bare call PREVIEWS and exits 0 with the
  (flag)        exact --yes re-run; --yes executes and writes an audit line. Both touch only
                this machine's tunnel and are reversible, so a loud flag is the right tier
                (SENSIBILITIES #2): the naive call is harmless, the deliberate one is honored.

Ceilings are code constants (SENSIBILITIES #3); raising one is a diff, not a flag.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn

from . import __version__
from .api import NordVPNClient
from .audit import audit
from .vpn import TunnelblickController, ConfigManager, get_connection_status
from .vpn.config_manager import config_name_for, normalize_hostname
from .vpn.tunnelblick import ConnectionState, TunnelblickError
from .utils import get_credentials
from .utils.credentials import CredentialsError

# ---------------------------------------------------------------- ceilings (code, not flags)
MAX_LIMIT = 50          # `servers --limit` above this is refused (exit 2), never lowered
DEFAULT_LIMIT = 10
CONNECT_TIMEOUT_S = 30  # how long `connect --yes` polls Tunnelblick before reporting failure

# ---------------------------------------------------------------- tiers (data, not prose)
VERBS = {
    "status": {"tier": "read"},
    "servers": {"tier": "read"},
    "countries": {"tier": "read"},
    "configs": {"tier": "read"},
    "setup": {"tier": "read"},
    "connect": {"tier": "write-gated", "gate": "flag"},
    "disconnect": {"tier": "write-gated", "gate": "flag"},
}

EXIT_OK, EXIT_FAIL, EXIT_USAGE = 0, 1, 2

app = typer.Typer(
    name="nordvpn",
    help="Control NordVPN via Tunnelblick on macOS. connect/disconnect preview until --yes.",
    no_args_is_help=True,
)
console = Console()
err = Console(stderr=True)

YesOpt = Annotated[
    bool,
    typer.Option("--yes", "-y", help="Execute. Without it the command previews and exits 0."),
]


def _version(value: bool):
    if value:
        console.print(f"nordvpn {__version__}")
        raise typer.Exit()


@app.callback()
def _root(
    version: Annotated[
        bool, typer.Option("--version", callback=_version, is_eager=True, help="Print the version")
    ] = False,
):
    """Control NordVPN via Tunnelblick on macOS."""


def _run_async(coro):
    return asyncio.run(coro)


def _tunnelblick_installed_or_exit() -> None:
    if not TunnelblickController.is_installed():
        err.print(
            "[red]Tunnelblick is not installed.[/red] Install with: brew install --cask tunnelblick"
        )
        raise typer.Exit(EXIT_FAIL)


def _ensure_tunnelblick_running() -> None:
    """Only the write verbs (and setup) launch Tunnelblick; a read never opens a GUI app."""
    _tunnelblick_installed_or_exit()
    if not TunnelblickController.is_running():
        err.print("[yellow]Starting Tunnelblick...[/yellow]")
        TunnelblickController.launch()


def _country_code(code: str) -> str:
    code = code.strip().upper()
    if len(code) != 2 or not code.isalpha():
        err.print(f"[red]--country takes a two-letter code, not {code!r}[/red]")
        raise typer.Exit(EXIT_USAGE)
    return code


def render_preview(verb: str, lines: list[str], rerun: str) -> str:
    """The preview a human reads before adding --yes (SENSIBILITIES #5)."""
    body = "\n".join(f"  {line}" for line in lines)
    return (
        f"── {verb} preview (nothing changed) ──\n"
        f"{body}\n"
        f"To do exactly this, re-run:\n"
        f"  {rerun}"
    )


# ---------------------------------------------------------------- reads

@app.command()
def status(
    local: Annotated[
        bool,
        typer.Option("--local", help="Skip the public-IP and geolocation lookups (no egress)"),
    ] = False,
):
    """Show the current VPN connection state.

    Without --local the public IP is fetched from api.ipify.org and looked up at ipinfo.io,
    which sends that IP off-host. --local answers from Tunnelblick alone.
    """
    if not TunnelblickController.is_installed():
        console.print("[yellow]Tunnelblick not installed[/yellow] — no VPN can be up through this tool")
        return
    if not TunnelblickController.is_running():
        console.print("[yellow]Tunnelblick not running[/yellow] — no VPN is up (degraded: state read from the process list only)")
        return

    if local:
        tb = TunnelblickController.get_status()
        if tb.state == ConnectionState.CONNECTED:
            console.print(f"[green]Connected[/green] to [bold]{tb.config_name}[/bold] (local view; no IP lookup)")
        elif tb.state == ConnectionState.CONNECTING:
            console.print(f"[yellow]Connecting[/yellow] to {tb.config_name}")
        elif tb.state == ConnectionState.UNKNOWN:
            console.print("[yellow]Unknown[/yellow] — Tunnelblick did not answer AppleScript (automation permission?)")
        else:
            console.print("[yellow]Disconnected[/yellow]")
        return

    with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}"),
                  console=console, transient=True) as progress:
        progress.add_task("Checking connection status...", total=None)
        conn_status = _run_async(get_connection_status())

    if conn_status.connected:
        console.print(f"[green]Connected[/green] to [bold]{conn_status.server_hostname}[/bold]")
        if conn_status.city or conn_status.country:
            console.print(f"  Location: {conn_status.city or conn_status.country}")
        if conn_status.load is not None:
            console.print(f"  Server Load: {conn_status.load}%")
        if conn_status.public_ip:
            console.print(f"  Public IP: {conn_status.public_ip}")
        else:
            console.print("  Public IP: unavailable (ipify/ipinfo unreachable; degraded to Tunnelblick state only)")
    else:
        console.print("[yellow]Disconnected[/yellow]")


@app.command()
def servers(
    country: Annotated[str, typer.Option("--country", "-c", help="Two-letter country code")],
    limit: Annotated[int, typer.Option("--limit", "-l", help=f"Servers to show (max {MAX_LIMIT})")] = DEFAULT_LIMIT,
):
    """List recommended servers for a country, lowest load first."""
    country = _country_code(country)
    if limit < 1 or limit > MAX_LIMIT:
        err.print(f"[red]--limit {limit} is outside 1..{MAX_LIMIT} (MAX_LIMIT in cli.py); refusing rather than lowering it[/red]")
        raise typer.Exit(EXIT_USAGE)

    async def list_servers():
        client = NordVPNClient()
        country_obj = await client.get_country_by_code(country)
        if not country_obj:
            err.print(f"[red]Country '{country}' not found[/red]")
            raise typer.Exit(EXIT_FAIL)

        with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}"),
                      console=console, transient=True) as progress:
            progress.add_task(f"Fetching servers for {country_obj.name}...", total=None)
            found = await client.get_recommendations(country_id=country_obj.id, limit=limit)

        if not found:
            console.print(f"[yellow]No servers recommended for {country_obj.name} right now[/yellow]")
            return

        table = Table(title=f"NordVPN Servers - {country_obj.name}")
        table.add_column("Hostname", style="cyan")
        table.add_column("City", style="green")
        table.add_column("Load", justify="right")
        table.add_column("Status")
        for s in found:
            city = s.city.name if s.city else "-"
            load_style = "green" if s.load < 30 else "yellow" if s.load < 70 else "red"
            table.add_row(s.hostname, city, f"[{load_style}]{s.load}%[/{load_style}]", s.status)
        console.print(table)

    _run_async(list_servers())


@app.command()
def countries():
    """List every country with NordVPN servers."""

    async def list_countries():
        client = NordVPNClient()
        with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}"),
                      console=console, transient=True) as progress:
            progress.add_task("Fetching countries...", total=None)
            countries_list = await client.get_countries()
        countries_list.sort(key=lambda c: c.name)
        table = Table(title="Available Countries")
        table.add_column("Code", style="cyan", width=6)
        table.add_column("Name", style="green")
        for c in countries_list:
            table.add_row(c.code.upper(), c.name)
        console.print(table)
        console.print(f"\n[dim]Total: {len(countries_list)} countries[/dim]")

    _run_async(list_countries())


@app.command()
def configs():
    """List the NordVPN configurations Tunnelblick has installed."""
    _tunnelblick_installed_or_exit()
    if not TunnelblickController.is_running():
        console.print("[yellow]Tunnelblick not running[/yellow] — start it to list configurations (degraded: nothing read)")
        return
    all_configs = TunnelblickController.list_configs()
    nord_configs = [c for c in all_configs if "nordvpn" in c.lower()]
    if not nord_configs:
        console.print("[yellow]No NordVPN configurations installed[/yellow]")
        return
    console.print(f"[bold]Installed NordVPN Configurations ({len(nord_configs)}):[/bold]")
    for c in sorted(nord_configs):
        console.print(f"  • {c}")


@app.command()
def setup():
    """Pre-flight: Tunnelblick present and running, credentials resolvable, API reachable."""
    console.print("[bold]NordVPN pre-flight[/bold]\n")

    console.print("Checking Tunnelblick...")
    _ensure_tunnelblick_running()
    console.print("[green]✓[/green] Tunnelblick is installed and running")

    console.print("\nChecking credentials...")
    try:
        creds = get_credentials()
        console.print(f"[green]✓[/green] Credentials resolved from {creds.source}")
    except CredentialsError as e:
        console.print(f"[yellow]![/yellow] {e}")
        raise typer.Exit(EXIT_FAIL)

    console.print("\nTesting NordVPN API...")

    async def test_api():
        try:
            found = await NordVPNClient().get_countries()
            console.print(f"[green]✓[/green] API working ({len(found)} countries available)")
            return True
        except Exception as e:  # noqa: BLE001 — any failure here is the same verdict
            console.print(f"[red]✗[/red] API error: {e}")
            return False

    if not _run_async(test_api()):
        raise typer.Exit(EXIT_FAIL)

    console.print("\n[green]Ready.[/green] Try: nordvpn status · nordvpn servers -c US · nordvpn connect -c US (previews; add --yes to connect)")


# ---------------------------------------------------------------- write-gated (flag): connect / disconnect

@app.command()
def connect(
    country: Annotated[str | None, typer.Option("--country", "-c", help="Two-letter country code (e.g. US, GB, DE)")] = None,
    city: Annotated[str | None, typer.Option("--city", help="City name to prefer within the country")] = None,
    server: Annotated[str | None, typer.Option("--server", "-s", help="Specific server (e.g. us5090 or us5090.nordvpn.com)")] = None,
    yes: YesOpt = False,
):
    """Route this machine's traffic through a NordVPN server.

    Without --yes: picks the server, says whether a configuration (with the service
    credentials embedded) must be installed into Tunnelblick, prints the --yes re-run, and
    changes nothing. With --yes: installs if needed, connects, waits up to CONNECT_TIMEOUT_S,
    writes an audit line. Undo: nordvpn disconnect --yes.
    """
    if not server and not country:
        err.print("[red]Specify --country (optionally --city) or --server[/red]")
        raise typer.Exit(EXIT_USAGE)
    if country:
        country = _country_code(country)
    if server:
        try:
            server = normalize_hostname(server)
        except ValueError as e:
            err.print(f"[red]{e}[/red]")
            raise typer.Exit(EXIT_USAGE)

    _tunnelblick_installed_or_exit()
    tb_running = TunnelblickController.is_running()

    # Credentials are resolved before the preview so a missing or too-permissive store fails
    # in the preview exactly as it would in the real call (a pre-flight that lies is worse
    # than none). The values are never printed.
    try:
        creds = get_credentials()
    except CredentialsError as e:
        err.print(f"[red]{e}[/red]")
        raise typer.Exit(EXIT_FAIL)

    async def choose_server() -> tuple[str, str]:
        """Returns (hostname, human description). Reads only."""
        if server:
            return server, f"{server} (named explicitly)"
        client = NordVPNClient()
        with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}"),
                      console=console, transient=True) as progress:
            progress.add_task(f"Finding optimal server in {country}...", total=None)
            optimal = await client.find_optimal_server(country, city=city)
        if not optimal:
            err.print(f"[red]No servers found for {country}[/red]")
            raise typer.Exit(EXIT_FAIL)
        where = optimal.city.name if optimal.city else (optimal.country.name if optimal.country else "unknown")
        return optimal.hostname, f"{optimal.hostname} ({where}, load {optimal.load}%)"

    hostname, description = _run_async(choose_server())
    config_name = config_name_for(hostname)
    installed = TunnelblickController.list_configs() if tb_running else []
    needs_install = config_name not in installed
    current = TunnelblickController.get_status() if tb_running else None
    cm = ConfigManager()

    rerun = f"nordvpn connect --server {hostname} --yes"
    lines = [
        f"Server:   {description}",
        f"Config:   {config_name}" + ("" if tb_running else "  (Tunnelblick not running; it will be launched)"),
    ]
    if needs_install:
        lines.append(
            f"Install:  download {hostname}.udp.ovpn from downloads.nordcdn.com, bundle it with the service "
            f"credentials (from {creds.source}) as a .tblk under {cm.config_dir}, and hand it to Tunnelblick "
            f"— Tunnelblick shows its own import dialog the first time"
        )
    else:
        lines.append("Install:  not needed; configuration already present in Tunnelblick")
    if current and current.state == ConnectionState.CONNECTED:
        lines.append(f"Replaces: the current connection to {current.config_name}")
    lines.append(f"Timeout:  waits up to {CONNECT_TIMEOUT_S}s for CONNECTED; the tunnel may still come up later")
    lines.append("Undo:     nordvpn disconnect --yes")

    if not yes:
        err.print(render_preview("connect", lines, rerun), highlight=False)
        return

    _ensure_tunnelblick_running()

    async def do_connect() -> bool:
        name = config_name
        if needs_install:
            console.print(f"[yellow]Installing configuration for {hostname}...[/yellow]")
            name = await cm.setup_server(hostname, creds.username, creds.password)
            audit("install-config", name, f"staged under {cm.config_dir}; imported via Tunnelblick")
            console.print("[yellow]Waiting for Tunnelblick to register the config...[/yellow]")
            await asyncio.sleep(3)
        console.print(f"[yellow]Connecting to {name}...[/yellow]")
        try:
            ok = TunnelblickController.connect(name, wait=True, timeout=CONNECT_TIMEOUT_S)
        except TunnelblickError as e:
            audit("connect", name, f"error: {e}")
            err.print(f"[red]{e}[/red]")
            return False
        audit("connect", name, "connected" if ok else f"not connected within {CONNECT_TIMEOUT_S}s")
        if not ok:
            err.print(f"[red]Not connected within {CONNECT_TIMEOUT_S}s[/red] — check `nordvpn status`; Tunnelblick may still be negotiating")
            return False
        # Read back after the write: the AppleScript call returning is a claim, the status is evidence.
        conn = await get_connection_status()
        console.print(f"[green]Connected to {hostname}[/green]")
        if conn.public_ip:
            console.print(f"  Public IP: {conn.public_ip}")
        return True

    if not _run_async(do_connect()):
        raise typer.Exit(EXIT_FAIL)


@app.command()
def disconnect(yes: YesOpt = False):
    """Tear down the VPN tunnel. Previews without --yes; reversible with connect --yes."""
    _tunnelblick_installed_or_exit()
    if not TunnelblickController.is_running():
        console.print("[yellow]Tunnelblick not running[/yellow] — nothing to disconnect")
        return

    tb_status = TunnelblickController.get_status()
    if tb_status.state == ConnectionState.DISCONNECTED:
        console.print("[yellow]Already disconnected[/yellow]")
        return

    target = tb_status.config_name or "all"
    if not yes:
        err.print(render_preview("disconnect", [
            f"Current:  {tb_status.state.value} to {target}",
            "Action:   tell Tunnelblick to disconnect all configurations; traffic leaves the tunnel",
            f"Undo:     nordvpn connect --server {target.removesuffix('.udp').removesuffix('.tcp')} --yes",
        ], "nordvpn disconnect --yes"), highlight=False)
        return

    console.print(f"Disconnecting from {target}...")
    try:
        ok = TunnelblickController.disconnect()
    except TunnelblickError as e:
        audit("disconnect", target, f"error: {e}")
        err.print(f"[red]{e}[/red]")
        raise typer.Exit(EXIT_FAIL)
    audit("disconnect", target, "disconnected" if ok else "disconnect sent; state not yet DISCONNECTED")
    console.print("[green]Disconnected[/green]" if ok else "[yellow]Disconnect sent; re-check with `nordvpn status --local`[/yellow]")


def main() -> None:
    app()


if __name__ == "__main__":
    sys.exit(main())
