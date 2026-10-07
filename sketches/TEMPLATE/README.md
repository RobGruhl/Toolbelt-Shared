# <System name> — sketch (not yet a belt tool)

drafted: <YYYY-MM-DD> · status: sketch — research only; no connection or authentication was attempted

## What it is

One paragraph on what the system is *here*: what it holds, who operates it, how it is reached (public SaaS, behind your corporate VPN/ZTNA client, private network only), and its internal identifiers. `toolbelt ask` quotes the first paragraph, so make it stand alone.

## Who needs it, and why

Who asked, how often, and for what — read needs and write needs listed separately, because the write-shaped demand decides the gate tier and the read demand decides whether v1 is worth building at all. First paragraph stands alone; `toolbelt ask` quotes it.

## The surface (API and auth, as documented)

Bullets, one per documented door: REST API, vendor CLI, SDK, console, export. For each: the auth model (personal token, OAuth, SSO session, service account), pagination and rate limits, whether reads and writes share an endpoint, and the documentation URL. Mark anything you inferred rather than read as unverified.

## SENSIBILITIES fit — the shape a belt tool would take

Blast radius first (private, reversible, shared, production), then which [SENSIBILITIES](../../SENSIBILITIES.md) patterns bind: the read-only v1 surface, the ceilings you would bake into code (rows, bytes, pages), the token lifecycle, the doctor checks, and — if a write is ever wanted — which gate tier it takes and the pre-flight that must hold before it runs.

## Likely CLI sketch

The verbs as a user would type them, one per line, read verbs first; any future gated write marked `(future, gated)` with the gate named. Say whether this grows inside an existing tool or becomes a new one.

## Access path — who to ask

Who grants the credential and through which channel (a chat channel, a ticket queue, a group to join, a form), how long it takes, and what the credential is bound to. `toolbelt ask` lifts `#channel` mentions and group ids from this section to address the request, so name them literally.

## Open questions

One bullet per fact a human must settle before anything is built — the ones whose answer changes the design, not curiosities. `toolbelt ask` sends this list verbatim.
