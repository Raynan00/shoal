# 🐟 shoal

**What if a thousand AI users tried to use your product at once — and told you where they got stuck?**

That's shoal. Point it at a URL and a swarm of persona-driven agents descends in real
browsers: an impatient speedrunner, a confused first-timer, a skeptic hunting for hidden
fees, a keyboard-only user, someone who reads nothing and clicks everything. Each one sees
the page as pixels (Claude computer use + Playwright), attempts the task in character,
narrates its confusion out loud, and files a finding the moment something breaks, misleads,
or silently fails.

It all streams to a live dashboard, and when the swarm is done you get a **friction map** —
every wall they hit, ranked by how many of them hit it ("312 stalled on the checkout
button"), not a thousand raw transcripts.

![The shoal — 1000 agents](docs/images/aquarium-1000.png)

**Every agent is a fish, and depth is your funnel.** They enter at the surface, swim down
as they get through your flow, and end up in one of two places: a gold carpet on the
seabed (converted) or a grey raft of belly-up fish at the surface (rage-quit). The water
level rises as the swarm grows. Orange flashes are agents filing a finding.

You can read the funnel in one glance — no chart required.

Alongside the tank, the **friction map** builds in real time: every distinct issue the
swarm found, ranked by how many agents hit it, each a bar you can read at a glance. That
ranking is the whole point — a wall 300 users hit matters more than one that tripped a
single agent.

**Click any fish** to see exactly what that agent is looking at, what it just thought, and
how far it got:

![Drill-down](docs/images/aquarium-drilldown.png)

The dashboard is also a **control surface** — stop the swarm mid-flight, relaunch it, and
change swarm size or attack strategy without touching the terminal. Toggle `▦ cams` for
the classic camera wall of live browser viewports:

![Camera wall](docs/images/dashboard-camera-wall.png)

<details>
<summary><b>More views</b> — race mode</summary>

**Race mode** — six agents claim the same single-stock item simultaneously. All six get an
order confirmation, and the finding is server-verified ground truth.

![Race mode](docs/images/dashboard-race-mode.png)

</details>

## Quick start — the 60-second demo (no API key)

Runs on macOS, Windows, and Linux — Node 18+ and a few GB of free RAM is all it needs.

```bash
npm install
npx playwright install chromium
npm run demo
```

Open **http://localhost:4321** and watch 8 scripted agents (real Chromium browsers, zero
API cost) tear into the bundled bait shop — a deliberately flawed demo store with four
planted UX traps:

1. A checkout button that silently ignores the first two clicks
2. A working submit button styled to look disabled
3. A form that fails validation with no error message
4. A $19.50 shipping fee revealed only at the last step

Watch how many agents each trap catches. Then try the concurrency demo:

```bash
npm run demo -- --race --swarm 5
```

Five agents converge on a "last one in stock" page, park at a barrier, and claim it in the
same instant. All five get an order confirmation for one unit — and shoal reports the
oversell as **server-verified ground truth**, not an agent's opinion.

Then the multi-user demos — where agents don't just test alone, they interact:

```bash
npm run demo -- --scene marketplace              # seller ↔ buyer: the sale the seller never sees
npm run demo -- --scene flash-sale --swarm 1000  # 1 unit, 1000 buyers rush it — how many oversell?
npm run demo -- --scene collab-doc               # two editors at once: the silently-lost edit
npm run demo -- --scene chat                     # sent ≠ delivered: the message that vanishes
```

A scene casts agents in interacting **roles** that coordinate live over the real site. In
`marketplace`, a **seller** lists an item and hands off to a **buyer**, who buys it — the
buyer gets a confirmation, but the seller's dashboard never shows the sale.

`flash-sale` is the scale showpiece: one seller drops a **single unit**, then a crowd of up
to **~1000 buyers rush checkout in the same instant** — and every one of them gets an order
confirmation. That's a textbook oversell from a **non-atomic stock check** (the "is it in
stock?" read and the "mark it sold" write straddle an async gap, so every concurrent request
passes the stale check). The crowd runs as lightweight **concurrent clients** hitting the
server's real checkout path in-process — because proving a server-side race needs a thousand
*simultaneous requests*, not a thousand browsers, which is exactly what lets it fit on a
laptop and show all 1000 fish at once. The coordinator and the two-party scenes still drive
full vision browsers.

None of these bugs is any single agent's opinion: shoal reports them as **server-verified
ground truth** from comparing what every participant actually experienced. `shoal scenes`
lists them all.

![Multi-user scene](docs/images/scene-marketplace.png)

## What's in the box

| | |
|---|---|
| **Friction map** | Findings clustered into distinct issues and ranked by how many of the swarm hit each one — the payoff view, built live |
| **Two axes** | 9 personas × 7 strategies — *who* the user is × *what they do to your app* → [STRATEGIES.md](docs/STRATEGIES.md) |
| **Multi-user scenes** | Agents in interacting roles catch bugs *between* users — the sale the seller never sees, one unit oversold to a crowd, the edit that's silently lost, the message that's sent but never delivered. Scales to ~1000 participants (`shoal scenes`) |
| **Dynamic personas** | Synthesized from your product outlook or real analytics → [GENERATION.md](docs/GENERATION.md) |
| **MCP server** | The swarm inside Claude Code / Cursor: find → fix → re-run → [MCP.md](docs/MCP.md) |
| **Accessibility modality** | A screen-reader persona that perceives the a11y tree, never pixels |
| **Race mode** | Barrier-synced agents that surface real concurrency bugs |
| **Verify pass** | Every finding marked confirmed / suspect before you act on it |
| **Cost meter** | Live dollar counter; $0 on local models or a Claude subscription |

## The real thing — unleash an LLM swarm

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login`
npm run build
npm run shoal -- run http://localhost:3000 --task "Sign up and buy something" --swarm 8
```

**Want proof before you spend anything?** [`examples/real-run-report.md`](examples/real-run-report.md)
is the unedited output of a real four-agent run — real vision agents, their own words,
$0.64 metered. (The `demo` above is scripted on purpose: it makes the tool free to try
and gives CI something deterministic to run.)

Each agent runs a Claude [computer-use](https://platform.claude.com/docs/en/agents-and-tools/computer-use) loop
against its own Playwright browser: screenshot → decide → act. Agents get two extra tools —
`report_finding` (file a UX issue the moment it happens) and `task_result` (declare
victory or ragequit, in character).

### Options

| Flag | Default | Notes |
|---|---|---|
| `--task "<text>"` | "Buy any product and complete checkout." | What the swarm attempts |
| `--swarm <n>` | 8 | Number of agents (hundreds work — see Scale) |
| `--concurrency <n>` | auto | Demo: measured machine capacity. LLM runs: min(swarm, 12) — rate limits bind first |
| `--provider <p>` | `anthropic` | or `openai` for any OpenAI-compatible endpoint |
| `--model <id>` | `claude-opus-5` | see Model tiers below |
| `--base-url <url>` | OpenRouter | OpenAI-compatible endpoint (Ollama, DashScope, Zhipu, vLLM…) |
| `--effort <level>` | `medium` | Anthropic only. `low` → cheaper, `high` → more thorough |
| `--no-verify` | verify on | Skip the Claude review of findings |
| `--personas <ids>` | all, cycled | e.g. `--personas speedrun-sam,newbie-nora` |
| `--strategy <ids>` | complete-task | The second axis — `rage-quit`, `dark-patterns`, … |
| `--race` | off | Barrier-synced concurrency run |
| `--scene <id>` | off | Multi-user scene: `marketplace`, `flash-sale` (scales with `--swarm`), `collab-doc`, `chat`. See `shoal scenes` |
| `--allow-domain <d>` | — | Permit a non-local target (else confirm interactively) |
| `--max-steps <n>` | 30 | Hard cap per agent (personas also have patience budgets) |
| `--headed` | off | Show the actual browser windows |
| `--port <n>` | 4321 | Dashboard port |

Reports land in `./shoal-report.md` + `./shoal-report.json`, findings clustered by
similarity and ranked by how many agents hit them.

## Model tiers — premium, subscription, cheap, free

Agents see pixels, so any **vision + tool-calling** model can drive one. Three providers:

**`--provider anthropic`** (default) uses Claude's native
[computer use](https://platform.claude.com/docs/en/agents-and-tools/computer-use) —
the strongest driving, grounding, and in-character narration, metered per token.
`claude-opus-5` for quality, `claude-haiku-4-5` for cheap swarms.

**`--provider subscription`** runs the swarm on your **Claude Code Pro/Max login** — no
API key, no metering, just the flat fee you already pay. If you're logged into Claude
Code, this works with zero setup:

```bash
npm run shoal -- run https://your-app.test --provider subscription --swarm 3
```

It reads your Claude Code token live (the token rotates hourly — Claude Code keeps it
fresh) and drives small, gently-paced swarms. The **binding constraint is the rate pool
you share with your own Claude Code usage** — in testing, a single 2-agent run was enough
to rate-limit the whole subscription for a while. So the default model is `claude-haiku-4-5`
not because it's cheap (the sub is flat-fee — model choice costs nothing) but because it's
the **lightest load on that shared pool**, giving you the most agent-steps before you
throttle your own coding. For better grounding and better-worded findings, use
`--model claude-sonnet-4-6` — and expect to hit the limit faster. The cost meter reads
`$0 · sub` and still shows what the run *would* have cost on the metered API.

> This uses a subscription credential outside the first-party Claude Code app. It works,
> it's great for personal/local use, and it's the honest cheapest path for a solo dev —
> but keep swarms modest, and don't build production automation on it (the token rotates
> and the shared rate pool is real). For big or unattended swarms, use `--provider openai`
> with a local/cheap model, or `--provider anthropic` with an API key.
>
> **macOS note:** Claude Code on macOS stores its token in the Keychain rather than
> `~/.claude/.credentials.json`, so subscription mode currently finds no credentials
> there — use `--provider anthropic` or `--provider openai` on a Mac. Everything else
> (demo, scenes, LLM swarms) is fully cross-platform.

**`--provider openai`** speaks to any OpenAI-compatible endpoint through a generic
computer tool. This is the scale tier:

```bash
# Qwen-VL via OpenRouter (cheap, good GUI grounding)
OPENAI_API_KEY=sk-or-... npm run shoal -- run <url> --provider openai \
  --model qwen/qwen3-vl-plus --swarm 50 --concurrency 10

# GLM-V via Zhipu's endpoint
OPENAI_API_KEY=... npm run shoal -- run <url> --provider openai \
  --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-4.6v

# Local model via Ollama — zero marginal cost per agent
OPENAI_API_KEY=ollama npm run shoal -- run <url> --provider openai \
  --base-url http://localhost:11434/v1 --model qwen3-vl
```

**The verify pass keeps cheap swarms honest.** Weak models produce artifact findings —
"the button doesn't work" when the agent simply missed the button. After the swarm
finishes, one strong Claude call reviews every finding against the agent's action trail
and screenshot, and marks it **✓ confirmed** or **⚠ suspect** (kept in the report,
flagged for human review — never silently dropped). This is the tiered pattern: *many
cheap explorers, one smart editor.* Skip with `--no-verify`; it runs whenever Anthropic
credentials are present, whatever provider drove the swarm.

## Scale: up to 1,000 agents

Agents share a small **pool of Chromium processes** (isolated context each) and are
**freeze-tier scheduled**: an agent's page is frozen — zero CPU — whenever it's waiting
on the model, a scene signal, or a scripted pause, and thaws only for the instant it
acts and screenshots. So hundreds of agents can be *resident* (memory-bound, measured
~57MB each) while only a CPU-bound active set renders at any moment. Past 24 agents the
camera wall shows the agents that are streaming video — a rotating set, since not every
agent in a big swarm can push frames — while the tank view is what represents the whole
swarm at once.

```bash
npm run demo -- --swarm 100 --concurrency 16     # 100 scripted agents, zero API cost
```

Mock mode scales as far as your RAM; LLM mode scales as far as your budget and your
provider's rate limits — which usually means waves of 10–50 on Claude, and much larger
swarms on the cheap tier.

How far one machine actually goes, with the measurements:
**[Running 1,000 browser sessions on one machine](docs/SCALING.md)**.

### Cost — measured, not claimed

Shoal meters every token. The dashboard shows a **live dollar counter** while the swarm
runs, the CLI prints the total, and the report includes cost per agent-session plus a
what-if table pricing the same token volume at each tier:

| Tier | Same swarm costs |
|---|---|
| `claude-opus-5` | $$$ (premium: best driving + narration) |
| `claude-haiku-4-5` | ~5× cheaper |
| Qwen/GLM-tier APIs | ~25–50× cheaper |
| local model (Ollama) | $0.00 |

A browser agent step is one vision API call; a session is ~15–25 steps. For models
shoal doesn't know prices for, pass `--price-in`/`--price-out` ($ per million tokens)
to enable the meter. Start small with `--effort low`, scale what works.

## Personas are the whole trick

The failure mode of simulated users is that all your "different" users are secretly the
same user. Shoal's personas force behavioral diversity: distinct goals, knowledge limits,
patience budgets, and quirks.

The built-in library ([`personas.yaml`](packages/core/personas/personas.yaml)) is a
starting point — ⚡ Speedrun Sam · 🧐 Careful Carl · 🌱 Newbie Nora · 🌀 Chaos Cathy ·
🕵️ Skeptic Saul · ⌨️ Keyboard Kai · 📱 Distracted Dee · 📖 Literal Lena — and adding one
is ~10 lines of YAML.

But the real power is **generating personas dynamically** so the swarm mirrors *your*
audience, from either the **product outlook** or **real analytics**:

```bash
# From what the product is (or inferred from the URL by vision)
npm run shoal -- run https://your-app.test --generate 15 \
  --audience "impulse-buy streetwear store, Gen-Z, almost entirely mobile"

# Grounded in real PostHog/Sentry/Clarity data — weighted by your actual traffic,
# primed to hit your actual drop-offs and errors
npm run shoal -- run https://your-app.test --generate 15 --from-logs ./analytics.json
```

Product-outlook generation is the zero-setup on-ramp; the **log-data path is where it gets
interesting** — personas shaped by your real traffic, primed to hit your real drop-offs.
Full guide, including the analytics JSON shape: **[docs/GENERATION.md](docs/GENERATION.md)**.

## How it works

```
┌─ CLI ─────────────────────────────────────────────────────┐
│ orchestrator                                              │
│   ├─ agent #1 ── Playwright browser ⇄ Claude computer use │
│   ├─ agent #2 ── Playwright browser ⇄ Claude computer use │
│   ├─ …                                                    │
│   └─ events ──► one server, one port:                     │
│        /      dashboard (camera wall, React)              │
│        /ws    live event stream (screenshots, thoughts,   │
│        /shop  the bait shop                    findings)  │
└───────────────────────────────────────────────────────────┘
```

- **Vision, not DOM.** Agents see rendered pixels, so they catch what selector-based
  tests can't: buttons that *look* disabled, invisible focus states, error messages
  that never appear.
- **Findings are the point.** Every agent narrates in first person and files findings
  in the moment. The report clusters near-duplicates across agents — a trap hit by 5
  personas ranks above one hit by 1.
- **Mock mode is a feature, not a stub.** `shoal demo` drives real browsers through
  scripted sessions — reproducible demos, CI smoke tests, and dashboard development,
  all at zero token cost.

## What shoal is not

It's a **filter, not an oracle**. Agent behavior correlates with human behavior
imperfectly; treat findings as cheap leads for real user testing, not a replacement.
The five humans you do test with should never waste their session on a bug an agent
would have caught for pennies.

## Development

```bash
npm install
npm run build                 # dashboard + core
npm run dev:dashboard         # Vite dev server (proxies /ws to :4321)
npm run shoal -- demo         # scripted swarm
```

Built in the open. Fork it, break it, send a PR — or just point it at your own site and
watch the shoal go. A hosted version may happen — ⭐ star and watch the repo if you'd
use one. MIT. 🐟
