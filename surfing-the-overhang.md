# Surfing the Overhang

*A working philosophy for building agentic systems on frontier models,
drawn from how Claude Code itself is built.*

## The overhang

At any given moment, the current model can already do things nobody has
built a product around. This is the product overhang: a standing gap
between what the model is capable of and what any harness, prompt, or
product actually lets it express. The gap is not small, and it is not
about future models — it exists today, for the model you have.

The complement of the overhang is hobbling: the model is doing
something, and your product is in the way. Every instruction you didn't
need, every workflow step you imposed, every rule you wrote to prevent
a mistake the model was never going to make — each one narrows what the
model is allowed to be good at. Claude Code itself began as an
un-hobbling: the models of the time could write whole files, and every
existing product confined them to autocomplete and read-only chat. The
product idea was subtraction — remove the scaffolding and let the model
do what it could already do.

Surfing the overhang means building as close to that edge as you can:
the thinnest system that elicits the model's full capability, and
nothing that gets in the way.

## Delete first

Every model generation, delete the prompt and start over. Claude Code's
own team deleted eighty percent of its system prompt when a new model
generation shipped, and most of what was deleted turned out to be
corrections for behaviors older models got wrong — corrections the new
model no longer needs and is actively slowed by. Their own ablations
found the model is a little *more* intelligent with the prompts
stripped out.

The method is an ablation, and it runs in one direction: delete
everything, then earn each line back. Don't guess which instructions
the model needs — you will predict wrong. Run the system, watch where
it actually stumbles, and only when it stumbles on the same thing
repeatedly does that thing become a line in the prompt. The bar is high
because the cost is permanent: the model reads every instruction every
single time, forever. An instruction that prevents a rare mistake but
taxes every interaction is usually a bad trade.

This applies to everything around the prompt too — tools, hooks,
skills, config. Unship things. If you use Claude Code rather than build
on it, the same advice holds: every six months, delete your CLAUDE.md,
your skills, your hooks, and see what the model does without them. It
may surprise you.

## Be empirical

The model is not a system you architect; it is closer to something
organic. Each generation behaves differently, has a slightly different
personality, and you have to take time to get to know it before you
adjust the harness around it. The big-design-up-front instincts that
served traditional engineering — think through everything, specify
completely, prevent every failure in advance — are the single most
common failure mode of experienced engineers working with models.

So the discipline is scientific rather than theoretical: try something,
observe the result, adjust. Forget your priors, including the ones you
formed on the last model — a thing that didn't work six months ago may
simply work now, and the people who are best at this are the ones most
willing to try again. Keep a few standing problems that the current
model can't solve, and throw every new model at them; that is how a
multi-year rewrite becomes an eleven-day one. And leave room for play
with no commercial purpose, because that is where surprise capabilities
get found.

There is no one weird trick. Anyone selling one is describing the
previous model.

## Aim slightly too high

Give the model tasks a little harder than you believe it can do. The
common mistake runs the other way: over-specified instructions — do
this, then this, in exactly this way — that force the model down to the
level of the specification. Modern models want the altitude one notch
up: describe the task, the guardrails, and the exit criteria, then let
it work. Treat it the way you would a strong coworker, because that is
the level of intelligence it is at — you would not hand a coworker a
numbered list of keystrokes.

## Draft before you ask

Some artifacts genuinely need a human's blessing — a charter, a
boundary, an owner's sign-off. Produce the best automated version
first anyway, and put that in front of them, labeled as the proposal
it is. A human reviewing a concrete draft spends their judgment where
it is actually needed — validating, correcting, overturning — instead
of on composition, which the model does better and faster. The
approval stays real: a draft says on its face that it is the
evidence's recommendation and not an agreement, and the human's edit
or veto is the point of the exercise. But people react to a working
solution and stall on a blank page, so the blank page is the one thing
never to hand them.

## Verification is the whole game

The single most important thing builders get wrong is verification.
A model with a way to check its own work — a test suite, a screenshot
comparison, a measurable exit criterion — can run essentially
unattended, for weeks if needed, because it can tell when it is not
done and it does not get stuck. A model without one drifts, no matter
how good the prompt is. Give it the same tools you would use to verify
the work yourself. Most of what looks like a capability gap is actually
a verification gap.

The same discipline covers judgment, not just code. When the output is
a claim — a fact in a chapter, a credential call, a name on a roster —
the check is an independent attempt to refute it: a second reader,
blind to the first one's reasoning, opens the evidence and tries to
knock the claim down. Whatever survives ships; whatever falls was
exactly the thing you didn't want published. Numbers get the same
treatment by re-deriving them with a separate implementation and
requiring exact agreement. And a fix always lands where the artifact
derives from, never in the artifact itself — a derived file edited by
hand is a fix the next regeneration silently undoes.

When the model does stumble, the fix is graduated: better elicitation
first, then a skill if the stumble is a recurring task shape, then an
MCP or tool if what's missing is context it can't reach. A permanent
rule in the prompt is the last resort, not the first.

## Write facts, not journeys

Context written for a model should read like a well-edited handbook:
here is what is true, here is how to do the thing. It should not read
like the story of how the document came to be. No war stories — no
"one time this happened, so always do X." War stories are how systems
die: an incident becomes a rule, the rule causes friction, the friction
becomes more rules, and eventually the whole thing collapses under
hundreds of rules that each made sense once. If a past mistake matters,
the correct residue is a test that catches it, not a paragraph that
retells it.

The same goes for history. Don't narrate where a fact came from, who
revised it, or what it used to say — git already holds all of that, and
an agent that needs the archaeology can go dig. The one exception is
when the past is load-bearing: something is mid-migration, half old and
half new, and a reader who didn't know that would get the answer wrong.
Then, and only then, pause and tell that piece of the story.

A few more rules of the pen:

- **Spend words only on what a smart reader couldn't guess.** The model
  already knows everything a frontier model knows. Explaining it back
  is pure cost.
- **Write plainly.** No punchy fragment headlines, no movie-poster
  aphorisms, no compressed parataxis. Those are artifacts of telling a
  model to conserve words; they read badly and they teach badly. Just
  say the thing in ordinary sentences.
- **Avoid examples unless strictly necessary.** An example anchors the
  model to one instance of a general idea. If the general statement is
  clear, stop there.
- **Stay human-readable.** Models are trained on human prose, and
  humans have to review, trust, and correct this material.
  Machine-only formats optimize for a reader that doesn't need the
  help and shut out the reader that does.

## Iterate into complexity

Never try to prevent all the problems at the start. Start with the
simplest version — use good judgment, trust the model — and let
complexity in only when a real problem, observed more than once,
demands it. Prescriptive lists, enumerated exceptions, taxonomies of
allowed reasons: each one is a place where reality will eventually fall
outside the list and the rule will do harm. Where you're tempted to
write an exhaustive rulebook for the edges, give the system an escape
hatch instead — a way to flag the situation and ask — and handle the
sharp cases as they actually arrive.

The corollary is that deletion has to stay cheap. Rules you can't
remove accumulate exactly like the prompts you can't ablate, and a
system that can only add is a system that is already dying.

## What survives the delete key

Almost nothing is permanent. Prompts, tools, and harness code turn over
every model generation. Even evals — the one thing you'd expect to be
the stable asset — outlive the harness by only a generation or three
before the model saturates them and they get thrown away and rebuilt
from wherever the model currently struggles.

What actually persists is the practice itself: delete first, watch
where it stumbles, earn every line back, give it verification, aim
slightly too high, write facts in plain language, and let complexity
in only when reality insists. The overhang moves with every release.
The point is not to build something that lasts; it is to stay balanced
on a wave that doesn't.
