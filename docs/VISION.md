# 🐟 Shoal — Vision & Design

> A swarm of AI users that attack your website — grounded in your *real* users —
> and tell you where it hurts, in the loop where you write code.

This document is the north star for where Shoal is going. The current repo is the
engine (personas, swarm, computer-use drivers, dashboard, verify pass, cost meter).
This doc describes the two things that turn that engine into something defensible:
**data-grounded personas** and an **MCP server** that puts the swarm inside the
developer's agent loop.

---

## 1. Thesis

Traditional QA and test suites encode the *developer's* mental model. They can't catch
comprehension failures — the flows users abandon, the buttons nobody understands, the
errors that never appear. Shoal's job is to encode *everyone else's* mental model, at
scale, and report back only what survives scrutiny.

Two design commitments make it trustworthy rather than a novelty:

- **Vision, not DOM.** Agents see rendered pixels, so they catch what selector-based
  tests can't: buttons that *look* disabled, invisible focus, error messages that never
  render.
- **A filter, not an oracle.** Agent behavior correlates imperfectly with human behavior.
  Every finding is verified before it's reported (see §4). Shoal produces cheap, ranked
  *leads* for real user testing — never a claim of truth.

---

## 2. The two axes

Diversity is the whole product. A swarm of agents that all behave identically gives false
confidence, which is worse than no data. Shoal generates behavioral diversity from two
small, orthogonal libraries:

- **Persona** — *who* the user is. Knowledge level, patience, reading habits, quirks.
  (`personas/personas.yaml`.)
- **Strategy** — *what* they're trying to do to the app. Intent, not identity.

`personas × strategies` is a multiplier: 9 personas × 7 strategies = 63 distinct agents
from ~18 lines of config each. All of the below are **shipped**:

| Strategy | What it does |
|---|---|
| Complete-the-task | Finish the flow (buy, sign up) — the default |
| Explorer / tourist | No goal — wander, click everything, find dead ends |
| Adversarial input | Hostile-but-plausible values (emoji, 500-char, past dates) |
| Rage-quit / funnel | Do the task, abandon at first friction, log *where* |
| Dark-pattern audit | Hunt drip pricing, pre-checked boxes, roach motels |
| State-breaker | Back-button, double-submit, refresh mid-flow |
| Concurrency / race | Barrier-synced agents hit one contended resource together; the oversell is detected server-side as ground truth |
| Accessibility | A *modality*, not a strategy: Screen-reader Sadie perceives the a11y tree, never pixels |

**Design note on concurrency** (kept for the reasoning): races needed agents that
coordinate timing — a barrier where N agents fire "purchase" within ~200ms — and the
flaky-false-positive risk was solved by having the *server* detect the oversell as ground
truth rather than trusting any agent's opinion. The same server-oracle pattern now powers
the multi-user scenes (marketplace, flash-sale, collab-doc, chat).

---

## 3. The moat: data-grounded personas

Hand-written personas answer *"how might different people fail?"* Data-grounded personas
answer *"how are **your** users actually failing, right now?"* — the question people pay
for. This is the flip from *plausible* to *grounded*, and it's the only defensible layer,
because it's built on the customer's private data, not copyable YAML.

Three signals, in increasing order of value:

1. **Distribution** (PostHog / Clarity) — not just persona *traits* but their *weights*.
   If 40% of real sessions are impatient mobile users, 40% of the swarm should be. The
   swarm becomes a scale model of the real audience.
2. **Failure replay** (Sentry) — the exact routes and states where real users hit errors.
   Spawn agents that reproduce *those specific paths* and narrate the experience around
   the crash. Stop guessing where to look; the incident log says.
3. **Behavioral signatures** (Clarity / FullStory rage-clicks, dead-clicks, thrash) — the
   richest source. A recording of someone rage-clicking a dead button at step 3 becomes a
   persona that rage-clicks — which Shoal reproduces *and explains why*, turning an
   unlabeled behavioral blip into a diagnosed, verified finding.

**It closes a measurable loop** — the thing that separates a product from a toy:

```
Clarity shows rage-clicks at checkout
  → Shoal synthesizes the persona, reproduces it, explains the cause
  → you fix it
  → next data cycle shows the drop-off gone
```

That before/after number is the case study, the renewal justification, and the marketing,
all at once. (This is Artificial Societies' bet — persona DB from LinkedIn/X — except
grounded in the customer's *own* product data, which is both more defensible and more
obviously valuable to them.)

**Cold start:** a new product has no analytics, so hand-written personas are never
deprecated — they're the default and fallback; the data connectors are the *upgrade*.
The YAML library is the base layer the data layer enriches.

---

## 4. The verify pass (why it's load-bearing everywhere)

Cheap models — and grounding slips on any model — produce **artifact findings**: "the
button doesn't work" when the agent simply missed the button. Every finding carries
evidence (the agent's recent thoughts/actions + the screenshot at the moment of filing).
After the swarm, one strong model reviews each finding against its evidence and marks it
**✓ confirmed** or **⚠ suspect** (kept in the report, flagged for human review — never
silently dropped).

This is the *"many cheap explorers, one smart editor"* pattern. It matters most over MCP
(§5): a human skims a suspect finding and moves on, but a **coding agent will act on
whatever you hand it** — feeding it a false positive makes it "fix" a working button. The
`verdict` field is what makes Shoal safe to put in an autonomous loop.

---

## 5. MCP server — putting the swarm in the agent loop

The highest-value integration surface changes *who the user is*: from a human running a
CLI to **a coding agent that reaches for Shoal as a tool.** A developer in Claude Code /
Cursor / Codex says "test this checkout with a swarm"; the agent runs Shoal against the
dev preview, reads structured findings, and fixes them — in the same session. Test → find
→ fix → re-test, inside one loop.

Shoal is unusually well-suited to be that organ: the ideal MCP payload is compact, ranked,
deduped, machine-actionable — which is *exactly* what the clustered+verified report already
is.

### Async lifecycle (the hard constraint)

A run takes minutes and costs money. MCP tool calls are modeled as quick request/response.
So the tools are **async** (start returns immediately; the agent polls) and
**cost-capped** (the calling agent is spending the human's money).

```
shoal_list_personas()
  → [{ id, name, traits, source: "builtin" | "posthog" | "sentry" }]

shoal_start_run({ url, task, personas?, strategy?, swarm?, max_usd? })
  → { run_id, dashboard_url, estimated_cost_usd }        # returns in ~1s
                                                          # max_usd = hard ceiling

shoal_run_status({ run_id })
  → { status: "running"|"verifying"|"done",
      agents_done, agents_total, cost_so_far_usd }        # cheap poll; agent loops on this

shoal_findings({ run_id })
  → { findings: [{ title, severity,
                   verdict: "confirmed"|"suspect",
                   hit_by, personas, evidence_summary }],
      summary }                                           # the payload that matters

shoal_stop({ run_id })                                    # let the agent bail early
```

Lifecycle the calling agent runs:
`start` → loop `status` until done → `findings` → fix code → optionally `start` again to
confirm.

### Two deliberate design calls

- **Findings as an MCP *resource*, not only a tool return.** Expose
  `shoal://runs/{run_id}/report` as a readable resource so the agent (or a human in the
  same client) can re-read without re-invoking. Tools *do*; resources *are read* — findings
  are a read.
- **`verdict` is in the payload, always.** The calling agent must be instructed to weight
  `suspect` as a lead, not a fact (see §4).

---

## 6. Auth & cost model — and "can I use my Claude/Codex subscription?"

Shoal has two distinct inference costs, and they bill differently. Getting this split right
is what enables a near-zero-cost path.

| Workload | What it is | Cheapest legitimate source |
|---|---|---|
| **Swarm inference** | Each agent's per-step vision loop (screenshot → act) | **Local model via Ollama = $0**, or cheap API tier (Qwen/GLM/OpenRouter), or Anthropic API |
| **Orchestration + verification** | Deciding to test, reading findings, reasoning about them | **Your Claude Code / Codex subscription**, via the MCP server |

**Can you point your Pro/Max subscription at the swarm drivers?** Empirically, **yes — and
Shoal ships it as `--provider subscription`.** We probed it: the Claude Code Max token
authenticated a raw Messages API call *and* the computer-use beta tool (HTTP 200). It
reads the token live from `~/.claude/.credentials.json` (it rotates hourly; Claude Code
keeps it fresh), adds the `oauth-2025-04-20` beta header, and drives the swarm. Verified
end-to-end against the bait shop on `claude-haiku-4-5`.

The constraints are real and are baked into the mode's tuning, not waved away:

- **Shared rate pool — the binding constraint.** The swarm draws on the *same* quota as
  your own Claude Code usage, and it's tight: in testing, a single **2-agent, 137k-token
  run rate-limited the whole subscription afterward** (follow-up single calls 429'd). So
  subscription mode defaults to a **small swarm, low concurrency (3), and patient retries
  (6)**. Because the pool — not cost (flat fee) — is the constraint, the default model is
  **Haiku for being the lightest load on the pool**, not for being cheap; `--model
  claude-sonnet-4-6` grounds better but drains the pool faster. This is why sub-mode is a
  zero-setup *"try it / small personal runs"* path, and real/volume work belongs on a
  metered key or local models.
- **Token rotation.** Read live per agent-start; a cached token dies within hours. Expired
  → a clear "refresh Claude Code" error, not a cryptic 401.
- **Off-label credential.** The token's scope is `user:sessions:claude_code`; using it
  outside the Claude Code app works today but isn't the sanctioned API path. Great for
  personal/local use; **don't build production or unattended automation on it.** The mode
  prints a warning saying exactly this.

For big or unattended swarms the robust paths remain: local/cheap models
(`--provider openai`) or a metered API key (`--provider anthropic`).

**And the subscription *also* powers Shoal as the orchestrator, through MCP** — the
cleaner path for the smart, low-volume half of the work:

1. **Swarm drivers → local Qwen-VL via Ollama ($0 marginal).** Weaker at grounding, but
   backstopped by the verify pass.
2. **Orchestration → Claude Code / Codex on your existing subscription (flat fee, already
   paid).** It invokes Shoal via MCP and acts on results — exactly what the subscription is
   *for*.
3. **Verification → delegated to the orchestrating agent.** Instead of Shoal spending API
   tokens on a strong model to verify, it can return findings + evidence over MCP and let
   the Claude Code agent (on the subscription) do the verification reasoning. This
   legitimately moves the one expensive smart-model call onto the flat-fee subscription,
   because it's just the agent reasoning about tool output.

Net: a solo dev with a Max subscription and a decent GPU can run audience-accurate swarms
at **~$0 marginal cost** — subscription drives the loop and the verification, Ollama drives
the fish. That's a genuinely differentiating open-source story, and it's honest: the
boundary (can't extract the sub token for the drivers; *can* orchestrate + verify on it via
MCP) is a real architectural line, not a loophole.

---

## 7. Open-core line

| Free / OSS (adoption + portfolio) | Commercial (the moat) |
|---|---|
| The swarm engine, personas-as-YAML, strategies | Hosted persona **synthesis** from analytics |
| Computer-use drivers (Anthropic + OpenAI-compatible + local) | PostHog / Sentry / Clarity **connectors** |
| The dashboard (camera wall + school view) | Closed-loop dashboard (before/after funnel deltas) |
| The verify pass, the cost meter | Persona models trained on *your* private data |
| **The MCP server** | CI/PR gate as a managed service |

The engine stays free — it drives adoption and is the portfolio signal. The commercial
layer is the part a competitor *can't* lift from the repo, because it's the customer's own
data being modeled, which only runs as a service.

---

## 8. Roadmap

**Built:**

1. ✅ Engine, three drivers (Anthropic / OpenAI-compatible / subscription), dashboard,
   verify pass, cost meter.
2. ✅ Scale — wave scheduling, shared-browser contexts, school-of-fish view.
3. ✅ **Persona generation** (§3) from product outlook or log data, with weighted panels.
4. ✅ **MCP server** (§5) — async, verdict-carrying, delegatable verification.
5. ✅ **Strategy axis** (§2) — 7 strategies, cycled across the swarm.
6. ✅ **Accessibility modality** — Screen-reader Sadie perceives the a11y tree, never
   pixels. Finds unlabelled controls, invisible focus, keyboard traps.
7. ✅ **Concurrency/race swarms** — a barrier syncs agents onto one contended action, and
   the demo target's oversell is detected **server-side as ground truth**, sidestepping the
   flaky-false-positive risk that made this a milestone rather than a launch item.
8. ✅ **Analytics reducers** — PostHog / Sentry / Clarity → the brief JSON shape.
9. ✅ **Safety gate** — non-local targets require an allowlist or explicit confirmation.
10. ✅ **Multi-user scenes** — agents in interacting roles (marketplace, flash-sale,
    collab-doc, chat) coordinating via a rendezvous primitive, with cross-user bugs
    detected by server-side oracles. Crowd roles scale to ~1000 via in-process racers.
11. ✅ **Friction map** — findings clustered into distinct issues and ranked by reach
    (agent-sessions hit), streamed live to the dashboard and exposed over MCP.
12. ✅ **Freeze-tier scheduling** — resident (memory-bound) vs active (CPU-bound)
    capacities; agents freeze mid-wait via CDP; browser-process shard pool for launch
    parallelism. Measured 57MB per resident agent; see docs/SCALING.md.

**Next:**

10. **Hosted persona synthesis + live connector auth** (§3) — the commercial wedge. The
    reducers exist; what's missing is managed OAuth, scheduled refresh, and the
    closed-loop before/after measurement. Gated behind the privacy work in §9.
11. **Sandboxed execution** (E2B-style, per the Floom comparison) — isolates the browser
    fleet and hardens the abuse surface beyond the current allowlist.
12. **Generation on OpenAI-compatible endpoints** — synthesis currently requires Anthropic
    credentials even when the swarm itself runs on local models.

---

## 9. Hard parts (design around, not into)

- **PII in session recordings.** Clarity/FullStory recordings contain real user input.
  Ingest *derived signals* (rage-click coordinates, drop-off events, error routes) — the
  behavioral signature — not raw recordings. This is a GDPR / SOC2 surface any buyer will
  probe; the architecture must be "we never needed the person, only the pattern."
- **Does synthetic actually predict real?** The unproven core claim of the whole category
  (Artificial Societies' "80%" is self-reported). Shoal's advantage: it can *measure it
  honestly* by closing the loop against the customer's own funnel — "we predicted drop-off
  at step 3, you fixed it, the funnel confirms it." Build that measurement in from day one;
  it's both the credibility and the defense against the category's snake-oil reputation.
- **Abuse surface.** Shoal points agents at arbitrary URLs — a DDoS vector, more acute over
  MCP where runs are agent-initiated. A hosted version needs rate limits, domain
  verification, and per-run cost ceilings.
- **Thin engine moat.** The engine is copyable. Defensibility lives entirely in §3 (data)
  and being early + trusted in the MCP ecosystem — not in the swarm code.

---

## 10. Strategic summary

Open-source the engine + MCP server as the portfolio piece. Let real usage — especially
MCP invocations wired into people's Claude Code — be the market research. The product, if
it exists, is narrow and integrated: **the QA organ for AI-native development, tuned to
your real users.** The moat is the data grounding, not the swarm. License **MIT** now for
adoption and signal; dual-license later only if a real business appears.
