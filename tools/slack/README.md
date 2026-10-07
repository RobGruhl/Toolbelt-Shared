# slack-cli

Read, search, export, and carefully write to your company's Slack — as yourself, from the
terminal or from an agent. It runs on the browser session you already have (no app, no bot
token), so it can do what you can do in the Slack client and nothing more.

The design is read-first: the MCP server exposes only reads; every write is a CLI verb gated to
its blast radius — `send` / `react` / `edit` / `invite` preview first and confirm at the
terminal (or `--yes` after a human approved the preview), `upload-file.mjs` needs `--yes`, and
`create-channel` makes you type the channel name back with no bypass, because a channel name
can never be reclaimed. Nothing deletes, kicks, or archives. The agent contract is
[CLAUDE.md](CLAUDE.md).

## Install

```bash
npm install            # Node >= 22.12; Google Chrome must be installed
```

## Configure

```bash
export SLACK_WORKSPACE_URL=https://yourco.slack.com/      # or https://grid-yourco.enterprise.slack.com/
```

or, to make it stick:

```bash
mkdir -p ~/.config/slack-cli
printf '{"workspace_url": "https://yourco.slack.com/"}\n' > ~/.config/slack-cli/config.json
chmod 600 ~/.config/slack-cli/config.json
```

Optional: `SLACK_BUSINESS_HOURS` (`06-18`) and `SLACK_BUSINESS_TZ` (your machine's zone) set the
window during which bulk exports are held back; `--force` overrides. All settings are listed in
[CLAUDE.md](CLAUDE.md#configuration).

## First login

```bash
node cli.js whoami     # prints the workspace, then opens Chrome for your company's sign-in
```

Sign in however your company does. The window closes on its own once the session is cached to
`~/.slack-cli-auth.json` (mode 600). `node cli.js login` forces a fresh sign-in;
`./diagnose.sh` (or `diagnose.ps1`) reports the state of everything without printing a secret.

## Three things to try

```bash
node cli.js channel general --max-pages 1                       # one page of a channel, as Markdown
node cli.js send @someone --text "hello from the CLI" --dry-run  # resolve + preview; nothing is sent
node cli.js thread https://yourco.slack.com/archives/C.../p...   # one thread, parent + replies, as JSON
```

Add the read-only MCP server to your agent with `../../bin/toolbelt register slack --write`.

## Tests

```bash
node test.js           # unit tests: no network, no configuration needed
node test.js --live    # integration tests against your workspace (set SLACK_TEST_CHANNEL)
```

MIT licensed. The safety contract these gates implement is the kit's
[SENSIBILITIES.md](../../SENSIBILITIES.md).
