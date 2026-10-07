# typesafe-jev (`jev`) — the agent contract

## Read first

- **What:** typed judgments from TypeSafe's Jev model. You send *state* (text or JSON) plus
  *questions*; each comes back as a probability, not prose: a **Noul** (probability of yes), a
  **Choice** (one option from your set, with the full distribution) or a **Score** (a
  probability-weighted position on your ordered levels). `jev.mjs` is the whole tool: zero
  dependencies, plain `fetch`.
- **Auth:** `$TYPESAFE_API_KEY`, else `~/.config/toolbelt/typesafe-jev.key`, else the gitignored
  `tools/typesafe-jev/.env` — both files mode 600, enforced. `.env.example` is the template. No key
  is needed for `--explain` or `usage`.
- **First read:** `node jev.mjs models` — free, runs no inference, proves the key.
- **Every verb is a read.** Nothing on the service mutates. An `ask` does two things a plain read
  does not: it bills the operator's account per input token, and it **sends the state off the
  machine**. So: send only content the user named for this purpose, run `--explain` before any
  large or looped call, and never point `--state` at mail, chat or documents the user did not
  hand you for this.
- **Live here?** `bin/toolbelt doctor typesafe-jev` — Node >= 20, key present, key accepted
  (`GET /v1/models`), host reachable.

```bash
node jev.mjs models
node jev.mjs ask --text 'Help! My payouts have been failing for 3 days.' --noul 'Does this convey urgency?'
node jev.mjs ask --text '…' --choice 'Which team should handle this?' --options billing,technical,sales,none
node jev.mjs ask --text '…' --score 'How frustrated is the customer?' --levels 'Calm|Frustrated|Very angry'
node jev.mjs ask --state ticket.json --questions questions.json            # many questions, one call
node jev.mjs ask --state ticket.json --questions questions.json --explain  # bytes, est. cost, no call
cat notes.txt | node jev.mjs ask --state - --noul 'Is a decision recorded here?'
node jev.mjs usage --days 7
```

`--json` prints the raw response for code to consume. Exit codes: `0` ok · `1` API, credential or
network failure · `2` usage, or a ceiling.

**Behind an egress proxy** (a cloud sandbox, a corporate network), Node's built-in `fetch` ignores
`HTTPS_PROXY` and fails to connect even where `curl` succeeds. Run with `NODE_USE_ENV_PROXY=1`
(Node >= 22.21).

## Designing questions

The answer is only as good as the question. These rules come from TypeSafe's own guidance and
hold for any caller:

- **Pick the primitive by meaning.** One of a defined set → Choice. Whether a condition holds →
  Noul; use one Noul per label when several may apply at once. Degree along a described
  dimension → Score, with levels that each describe a concrete situation and stand on their own.
- **Ids are for code and are never sent to the model.** Put the complete meaning in
  `instructions`; an id like `is_urgent` tells Jev nothing.
- **Judgment in `instructions`, the answers in `criteria`.** Both accept a string, an object or
  an array. Structure helps when a question carries data: put the question in one field and the
  data in others, and refer to them, or to nested state, by backticked path
  (`` `ticket.messages[0].text` ``, `` `potential_duplicate` ``).
- **Offer a way out.** The model cannot pick an option you did not give it; add a `none` option
  whenever nothing may fit. `jev` refuses a Choice with fewer than two options for the same
  reason.
- **One narrow judgment per question**, and ask independent questions over the same state in one
  call: they run in parallel, cannot see each other's answers, and share the state's tokens. A
  second call is warranted only when an earlier answer decides what to fetch or ask next.
- **Read the numbers as they are meant.** Choice and Score `confidence` measures how concentrated
  the distribution is — not correctness, and not permission to act. A Noul near 0.5 means yes
  and no are about equally likely, not "medium". Typed output guarantees the interface, not the
  truth: set thresholds on the operator's own labelled cases before code acts on them.
- **Keep policy in code.** Score dimensions once and let code weight, threshold and combine them;
  an "any serious violation" rule needs separate Nouls, not a weighted average.

Patterns worth reading before a new workflow — `https://docs.typesafe.ai/llms.txt` indexes them,
and any page is served as Markdown with `.md` appended: routing with typed arguments
(`/cookbooks/function_calling.md`), speculative fan-out (`/patterns/fan-out.md`), reranking
(`/cookbooks/rerank_typesafe.md`), selecting a value from code-found candidates instead of
generating it (`/cookbooks/pre_parsed_value_extraction_cookbook.md`), citation checks
(`/cookbooks/citation_check.md`), escalation cascades (`/cookbooks/sde_cascade.md`), composite
scoring (`/patterns/composite-scoring.md`).

## The API

One endpoint serves every model: `POST https://api.typesafe.ai/v1/systemone`,
`Authorization: Bearer <key>`, body `{state, model, questions}`.

| Question | `criteria` | Answer fields |
|---|---|---|
| `noul` | optional `{true, false}` descriptions | `noul` (0–1) |
| `choice` | required map option → description or `null`; ≤255 options | `choice`, `probabilities`, `confidence` |
| `score` | required ordered array of levels; 2–10 | `score` (can land between levels), `legend`, `probabilities`, `confidence` |

The response carries `model` (the versioned id that answered) and
`usage: {input_tokens, output_tokens}`. `GET /v1/models` returns `{models: [{name, description,
release_date}]}` and lists only the aliases; a versioned id is accepted whether or not it is
listed.

**Errors** come back as `{"detail": {"error_type", "message"}}`:

| Status | Meaning |
|---|---|
| 401 | the key is wrong or revoked (`authentication_error`) |
| 403 | no key was sent at all |
| 400 | usage error, e.g. `Unknown model: <id>` (`api_usage_error`) |
| 422 | the body failed validation; the detail names the field |
| 429 / 529 | rate limited / overloaded — retry with backoff |

Responses carry no rate-limit headers. The API accepts a one-level Score and bills it for a
meaningless answer; `jev` refuses it locally.

**Model.** `jev` pins `jev-1.13.0`. The aliases `jev-latest` (the SDK default) and `jev-preview`
move when a release ships, which silently changes answers behind tuned thresholds. Move the pin
deliberately: change `MODEL` in `jev.mjs`, re-check the thresholds that depend on it. `--model`
overrides it for one call.

**Price and limits** (jev-1.13.0): $0.042 per million input tokens, output free — a short
message with three questions is about 420 tokens, $0.00002. 250,000 tokens/s and 1,200
requests/min, which the vendor says move without notice. Context is 64k tokens for state plus
all questions, and 32k for state plus the longest question. Text only; English is where Jev is
most accurate.

**Data.** Jev is not trained on customer requests or responses, and the same weights serve every
account — domain knowledge goes in the state and the criteria, never in fine-tuning. Zero data
retention is an enterprise-plan feature; retention on other plans is in the DPA at
`https://docs.typesafe.ai/legal`.

**SDKs.** `@typesafe-ai/sdk` (npm) and `typesafe_sdk` (Python) read `TYPESAFE_API_KEY`,
`TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`, and retry 408/429/5xx twice honoring
`retry-after-ms` / `Retry-After`. `jev` reimplements that retry in a few lines rather than take
the dependency.

## Ceilings and audit

Constants in `jev.mjs`; no flag raises them — change the constant and the diff is the review:

| Constant | Value | Why |
|---|---|---|
| `MAX_STATE_BYTES` | 96,000 | ≈24k tokens, inside the 32k state + longest-question budget |
| `MAX_REQUEST_BYTES` | 200,000 | ≈50k tokens, inside the 64k per-request budget |
| `MAX_QUESTIONS` | 32 | per call |
| `MAX_OPTIONS`, levels | 255; 2–10 | the API's own bounds, plus the one-level Score it should refuse |
| `TIMEOUT_MS`, `MAX_ATTEMPTS` | 30 s; 3 | retries only 408/429/5xx, waits capped at 30 s |

At the ceiling a call costs about $0.002, so the ceilings bound egress and rate-limit load more
than the bill. There is no batch verb: a caller that loops over `ask` owns its loop, and every
iteration is audited.

**Egress guard.** A `--state` file is resolved through symlinks, then refused if it is named like
a credential (`.env*`, `*.key`, `*.pem`, `id_*`, `.netrc`, `.npmrc`, `credentials`) or lives under
`~/.ssh`, `~/.gnupg`, `~/.aws` or `~/.config/toolbelt`. Stdin (`--state -`) is the caller's own
choice and is not inspected.

**Audit.** One line per call on stderr; every `ask` is also appended to
`~/.local/share/typesafe-jev/audit.log` (dir 700, file 600, `$TYPESAFE_JEV_HOME` moves it): time,
status, answering model, question ids, state bytes, input tokens, cost. Never the key, the state,
the questions or the answers. `node jev.mjs usage` totals it.

## Not here

- **No batch verb, and no SDK.** A loop over `ask` is the caller's, audited per call.
- **TypeSafe's agent skill** (`claude plugin install typesafe@typesafe-ai`, or
  `npx skills add typesafe-ai/skills`) is not installed: the belt routes through its one skill,
  and this file is the contract. Its source, `skills/typesafe-ai/SKILL.md` in
  `github.com/typesafe-ai/skills`, is the design guidance summarized above.

## Data terms (read 2026-09-28)

Sources: the DPA (updated 2026-04-24), the Master Customer Agreement (MCA, 2026-09-23) and the
Privacy Policy (2025-11-19), all linked from docs.typesafe.ai/legal. Re-read them if those dates
change.

- **Training is ruled out.** Input and Output ("Customer Data") are never put into a dataset that
  modifies model weights without the customer's prior consent (MCA §4.1, Privacy Policy).
- **Retention has no fixed period.** The DPA says "as long as necessary". The MCA says TypeSafe
  need not store Customer Data and may delete it at any time, but copies may persist in standard
  backups (§10.3).
- **One grant is perpetual.** MCA §4.1(c) lets TypeSafe use Customer Data in perpetuity to derive
  Telemetry, to monitor for fraud and abuse, and to comply with law. Telemetry covers "technical
  logs, hashes, summary statistics and classifications, metrics, and learnings". §4.3 lets TypeSafe
  use it "without restriction", including to improve its products. The training ban covers
  weights, not derived telemetry.
- **The DPA protections.** Processing on documented instructions only; no sale or sharing; a
  72-hour breach notice; subprocessors listed at trust.typesafe.ai/subprocessors (the page renders
  with JavaScript and has not been read).
- **Zero data retention** is for enterprise customers only, through sales@typesafe.ai.
- **Third-party data is the customer's responsibility.** MCA §5 warrants that the customer has the
  rights and consents for all Input. Mail is full of other people's personal data.
- **Policy.** The hosted API gets public, synthetic or reduced content: counts, domains and derived
  features. Mail, chat and document content is not sent unless the owner decides otherwise and
  records the decision below, or ZDR is in place.
- **Your decision goes here.** Before any caller sends your own mail or chat content to the hosted
  API, read the terms above, decide, and record it in this list: what content, for which job,
  and the date. Callers that send private content check `ALLOW_HOSTED_PRIVATE_MAIL=1`, which
  you set only after recording the decision.
