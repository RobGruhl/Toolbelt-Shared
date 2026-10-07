# Billing and hard limits

What every paid tool in the belt costs, who bills you, and how to make sure a mistake (yours or
Claude's) can't run up a bill. Provider settings were checked on 2026-10-07. Providers move these
menus around, so if a click-path below no longer matches, search their help for "spend limit"
or "auto reload". Anything marked *(unconfirmed)* could not be checked against the provider's
own page.

## The rule that makes it safe

Three layers, from strongest to weakest:

1. **Prepaid credit with auto-reload off.** Buy a small amount and switch off automatic top-up.
   When the balance reaches $0 the service stops, and your card is never charged again unless you
   buy more. **The most you can lose is what you loaded.** Do this for every API account.
2. **The provider's spend limit**, where one exists. It's a second stop below the balance.
3. **The belt's own ceilings.** Each paid tool previews the cost before it spends, caps every
   call in code, and logs what it actually spent (table at the end). These stop a runaway loop,
   but they aren't a replacement for 1.

**Subscriptions are separate from API billing.** ChatGPT Plus doesn't pay for the OpenAI API,
and a Claude plan doesn't pay for the Anthropic API. Each API is its own account with its own
balance, even when you sign in with the same login.

## Subscriptions you may already pay for

| Subscription | What can cost extra | Keep it capped |
|---|---|---|
| **Claude Pro/Max** (Claude Code) | "Usage credits" (extra usage beyond your plan). **Off by default.** | Leave it off. If you turn it on: claude.ai › Settings › Usage › *Adjust limit* sets a monthly cap. Leave auto-reload off. |
| **ChatGPT Plus** (Codex, used by `codex-fleet`) | Codex credits after your plan's limits run out. Auto top-up is opt-in. | Never enable auto top-up (chatgpt.com/codex/settings/usage), and keep the credit balance at $0. Check it stays off: one community report says it re-enabled itself. `codex-fleet --api` bills the OpenAI API instead, and is never the default. |

## API accounts, one by one

### OpenAI API (`openai-image`, `oracle`, `transcription --backend openai`, `codex-fleet --api`)

- **Bills:** prepaid credits at platform.openai.com. The minimum purchase is $5.
- **Hard cap:**
  - Settings › Billing: turn **auto-recharge off**. It can come pre-ticked when you first add
    credit, so check it.
  - Then Settings › Organization › Limits › Spend: set a **spend limit**, for example $10 a
    month. Projects can have their own limit too.
  - The older "budget" emails are alerts, not limits.
- **At the cap:** calls fail with `organization_spend_limit_exceeded`, or with
  `credit_balance_exhausted` at $0. Enforcement isn't instant, so one last call can go slightly
  over.
- **Image models need organization verification** (PERSONAL-SETUP §8).
- **Start with:** $5–10, auto-recharge off, a $10 monthly spend limit.

### Anthropic API (`video-rename`)

- **Bills:** prepaid credits at platform.claude.com (the Claude Console). Credits expire after a
  year.
- **Hard cap:** auto-reload is **off unless you turn it on** (Settings › Billing). You can also set
  Settings › Billing › *Spend limits* › *Set limit*.
- **At the cap:** calls fail with "You have reached your specified API usage limits". At $0 the
  API stops.
- **Start with:** the smallest credit purchase. Only `video-rename` uses it; skip it if you don't
  need that tool.

### ElevenLabs (`elevenlabs`)

- **Bills:** a plan with monthly credits. Free is 10,000 credits, Starter $6 for 30,000, Creator
  $22 for 121,000. Extra usage is a prepaid "Top Up" (minimum $5). There are no overage
  charges.
- **Hard cap:** Developers › Top Up: leave **Auto Top Up off**. A monthly spend cap is on the
  same page. Each API key can also carry a credit quota (the key's ⋯ › Edit) *(unconfirmed where
  exactly)*.
- **At the cap:** usage pauses immediately. You're never billed beyond your plan or top-up.
- **Start with:** Free, then Starter if you use it a lot. The free plan is for non-commercial
  use with attribution. Music needs a paid plan.

### Perplexity API (`perplexity`)

- **Bills:** prepaid credits at console.perplexity.ai (Billing). A Perplexity Pro subscription
  no longer includes API credit.
- **Hard cap:** Billing › preferences: leave **Auto reload off**. Perplexity has no monthly cap
  setting, so the prepaid balance is the cap.
- **At the cap:** the key is blocked (401) until you add credit.
- **Start with:** the smallest purchase. `search` is $0.005 a call; an `agent` answer is usually
  about $0.02.

### Firecrawl (`firecrawl`)

- **Bills:** a plan with monthly credits. Free is 1,000 credits a month with no card; Hobby is
  $19 for 5,000.
- **Hard cap:** Billing › *Monthly pay-as-you-go limit*: set it to **0** (off) or a dollar cap.
  **Blank means no cap.** Each API key can also get a credit limit (API keys › Set limit).
- **At the cap:** requests fail with 402, and the card isn't charged.
- **Start with:** Free.

### Runway API (`runway-ai`)

- **Bills:** prepaid credits per project at dev.runwayml.com: $0.01 per credit, $10 minimum.
- **Hard cap:** autobilling is opt-in, on the project's Billing tab. Don't set it up. New
  accounts also have a built-in cap of $100 of purchases per 30 days.
- **At the cap:** generations stop *(the exact error is unconfirmed)*.
- **Start with:** $10, no autobilling.

### TypeSafe Jev (`typesafe-jev`, the Gmail digest)

- **Bills:** credits used per input token, at $0.042 per million (output is free). A day's
  inbox costs a fraction of a cent. Sign in at typesafe.ai; keys are at console.typesafe.ai/keys.
  Purchased credits expire after 12 months.
- **Hard cap:** automatic refill is opt-in, so don't opt in. No spend-limit setting is
  documented, so the prepaid balance is the cap. *(Where the refill setting lives, and whether
  sign-up includes free credit, are unconfirmed.)*
- **At the cap:** TypeSafe may stop answering *(the exact error is unconfirmed)*.
- **Start with:** the smallest purchase.

### NordVPN (`nordvpn`)

A normal subscription, and the tool never touches billing. Turn off auto-renew in your Nord
account if you don't want it to renew.

## Free

`imessage`, the claude.ai Gmail and Calendar connectors, `slack`, `playwright`,
`youtube-transcript`, `transcription` (local whisper), `gmail-harvest`, `gmail-filters`,
`outlook-harvest`, `print`, `caffeinate`, `hot-bag`, `claude-ding`, `spiral-book`, `blender`, and
the examples. Some use your Claude usage when Claude reads their output, but none bill anything
else.

## The belt's own ceilings

| Tool | Before it spends | Hard ceiling in code | See what you spent |
|---|---|---|---|
| `openai-image` | bare command previews; `--yes` runs | 4 images and $2 a call; stops past $50 in 24h until you say to continue | `node oimg.mjs spend` |
| `oracle` | cost estimate, then your yes | $10 a request | the estimate and its audit log |
| `transcription` | `--explain`; refuses over `--max-usd` | $1 a run unless you raise it | `~/.local/state/toolbelt/transcribe.log` |
| `elevenlabs` | `--dry-run`; `--yes` over 400 characters | 1,000 characters a call; music 120 seconds | `~/.local/state/agent-voice/audit.log` |
| `perplexity` | `--explain` shows the worst case | 20 results; 4,096 output tokens | the cost on every call |
| `firecrawl` | `crawl` previews and needs `--yes` | 20 results or URLs; 50 pages a crawl | an audit line per request |
| `runway-ai` | bare command previews; `--yes` runs | 120 credits ($1.20) a call | `node rwy.mjs balance` / `usage` |
| `typesafe-jev` | `--explain` | 96 KB state, 32 questions a call | `node jev.mjs usage --days 30` |
| `video-rename` | `--explain` estimates | up to 200 vision calls a batch | its audit log |
| `codex-fleet` | `--explain`; widening flags need `--yes` | 50 jobs, 16 at once | `data/audit.log` |

Claude never adds `--yes` on its own. It shows you the preview, and the yes is yours.

## Once a month

Look at each provider's usage page next to the tool's own log. If something you don't use
still has a balance, leave it, since prepaid credit can't overcharge you. If you stop using a
service, delete its API key on the provider's site and `rm` its key file in
`~/.config/toolbelt/`.
