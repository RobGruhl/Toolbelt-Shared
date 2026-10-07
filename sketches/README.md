# Sketches — research dossiers for tools the belt does not reach yet

A sketch is the starting point for the next tool. It is a research dossier for one system you
use but the belt cannot reach: what the system is here, who needs it and for what, the
documented API surface and auth model, the SENSIBILITIES shape a tool would take, a likely CLI,
the access ask, and the questions a human must settle before anything is built. One directory
per system, one `README.md` inside it, written from documentation alone — nothing is contacted,
nothing is authenticated. A sketch is a decision record, not a probe and not a build.

Write the dossier before the code because the dossier settles the three things that decide
whether a tool is worth building: whether anyone actually needs it, whether a read-only surface
exists at all, and who can grant the credential. `bin/toolbelt ask <sketch>` renders the dossier
into an access request you can hand to the system's owners, so the access path and open
questions must be written down in the dossier rather than reasoned afresh in chat.

Start every sketch from [TEMPLATE/README.md](TEMPLATE/README.md). Keep its `##` headings
byte-for-byte: `toolbelt ask` parses them by name.

## Lifecycle

A sketch carries a verdict in the index below, and the verdict moves:

- **open** (`build-now`, `build-later`) — the dossier is the decision record. Revisit when an
  open question closes or a credential lands.
- **built → tools/<x>** — a tool or connector directory exists. The tool's `CLAUDE.md`
  supersedes the dossier: carry the durable facts (access path, documented surface, remaining
  open questions) into the contract, remove the dossier directory, and leave the index row with
  the name struck through pointing at the contract. The row keeps the history.
- **compose-existing** — the need is real but an existing tool already reaches the data (or a
  query pack, recipe, or skill row over an existing tool covers it). The dossier stays as the
  source the composition cites; the row reads `composed → <path>`.
- **dont-build** — the system is retiring, has no responsible read API, or belongs to an
  operator who should hold the pen. The dossier stays so the next person does not redo the
  research; one line in the row says why.

## Index

| # | Sketch | Demand | Verdict | One line |
|--:|---|---|---|---|
