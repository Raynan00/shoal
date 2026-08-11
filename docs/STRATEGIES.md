# 🎯 Strategies — the second axis

A **persona** is *who* the user is. A **strategy** is *what they are trying to do to your
app*. They are orthogonal, so they multiply:

```
9 personas × 7 strategies = 63 distinct agents
```

from two small libraries you can extend in ~10 lines each. Without strategies, a swarm of
60 is 9 personas cloned; with them, the same swarm covers 63 genuinely different
behaviours.

```bash
shoal strategies                                    # list them
shoal run <url> --strategy rage-quit                # one
shoal run <url> --strategy rage-quit,dark-patterns  # cycled across the swarm
```

| id | What the agent does | What it finds |
|---|---|---|
| `complete-task` | Pursues the task normally (default) | Baseline friction on the happy path |
| `explore` | No goal — wanders and clicks everything | Dead links, orphan pages, controls with no obvious purpose |
| `adversarial-input` | Fills fields with hostile-but-plausible values (emoji, 500 chars, `a@b`, negative quantities) | Validation gaps, unexplained rejections, ugly error states |
| `rage-quit` | Abandons at the first friction and logs *exactly where* | **Your funnel drop-off points** |
| `dark-patterns` | Audits for drip pricing, pre-checked opt-ins, roach motels, confirmshaming | Manipulative UX, undisclosed costs |
| `state-breaker` | Back-button mid-flow, double-submit, refresh, revisit | Lost data, duplicate orders, stale state, dead ends |
| `race` | Contends for one limited resource simultaneously | **Concurrency bugs** — see below |

If a strategy sets its own `goal` (the explorer does), it replaces the run's `--task`.

## Rage-quit is the one to run first

`--strategy rage-quit` turns the swarm into a funnel analyser: every agent pushes until it
hits friction, then quits *and reports the exact step*. The output reads as "here is where
your users leave, and why" — which is the sentence a non-technical founder immediately
understands.

## Race mode — real concurrency testing

Parallel agents alone never collide; they drift apart by seconds. `--race` adds a
**barrier**: every agent converges on the contended action, parks until all of them have
arrived, and is then released on the same tick so the requests land inside a few hundred
milliseconds of each other.

```bash
shoal demo --race --swarm 5      # zero-cost demo against the bundled race target
shoal run <url> --race --swarm 5 --race-path /checkout/last-item
```

The bundled demo target (`/shop/race.html`) contains a textbook TOCTOU bug — stock is
checked, an `await` gap opens, then it is decremented — so simultaneous claims all pass
the check. A real run looks like this:

```
🏁 race mode — agents sync at a barrier, then strike together
  🌱 Newbie Nora: Ready to claim — waiting for my moment…
  ⚡ Speedrun Sam: Ready to claim — waiting for my moment…
  …
  ⚡ Speedrun Sam: Did I get it? The page says my order is confirmed.
  🧐 Careful Carl: Did I get it? The page says my order is confirmed.
🏁 [high] Race condition: 5 buyers claimed 1 unit (server-verified)
```

**That last finding is ground truth, not an opinion.** The demo server knows how many
claims actually succeeded, so an oversell is *observed*, not inferred from what an agent
thought it saw — and it therefore skips the verify pass entirely. Against your own app,
the agents report what they experienced ("my order confirmed") and the verify pass weighs
it as usual; wire your own oracle in if you want the same certainty.

## Adding a strategy

Append to [`strategies.yaml`](../packages/core/strategies/strategies.yaml):

```yaml
  - id: impatient-mobile
    name: Thumb-only mobile user
    directive: >
      You are on a phone, one-handed, in a hurry. You only use the bottom half of the
      screen comfortably and you never zoom. Report anything that is too small to hit,
      hidden behind a hover, or requires precision you do not have.
```

Good strategies describe *behaviour and what to report*, not a script of clicks — the
model improvises within the brief, which is what produces variety across personas.
