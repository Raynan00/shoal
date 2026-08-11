# 🔌 Shoal as an MCP server

Put the swarm inside your coding agent's loop. You say *"test this checkout with a swarm"*
in Claude Code / Cursor / Codex; the agent runs Shoal against your dev server, reads the
verified findings, and fixes them — without you leaving the editor.

```
you → agent → shoal_start_run → (swarm runs) → shoal_findings → agent fixes code → re-run
```

## Setup

Claude Code:

```bash
claude mcp add shoal -- node /absolute/path/to/Code-Smash/packages/core/dist/cli.js mcp
```

Or in `.mcp.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shoal": {
      "command": "node",
      "args": ["/absolute/path/to/Code-Smash/packages/core/dist/cli.js", "mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-…",
        "SHOAL_ALLOW_DOMAINS": "staging.myapp.com"
      }
    }
  }
}
```

Environment:

| Var | Purpose |
|---|---|
| `SHOAL_PROVIDER` | `anthropic` (default), `openai`, or `subscription` |
| `SHOAL_MODEL` | Model for the swarm drivers |
| `SHOAL_BASE_URL` | OpenAI-compatible endpoint (Ollama, OpenRouter, …) |
| `SHOAL_ALLOW_DOMAINS` | Comma-separated non-local hosts the agent may target |

## Tools

| Tool | Purpose |
|---|---|
| `shoal_list_personas` | Personas + strategies available (call first to target specific user types) |
| `shoal_start_run` | Start a swarm. **Returns immediately** with a `run_id` |
| `shoal_run_status` | Cheap poll: status, agents done, cost so far, findings count |
| `shoal_findings` | Verified findings + the **friction map**: issues ranked by how many agents hit each (fix the top first) |
| `shoal_stop` | Stop tracking early |

Reports are also exposed as **resources** at `shoal://runs/{run_id}/report`, so the agent
(or you, in the same client) can re-read a report without re-running anything.

### Why async

A swarm takes minutes and costs money; an MCP tool call should return in seconds. So
`shoal_start_run` returns a `run_id` immediately and the agent polls. This also means the
agent can bail (`shoal_stop`) instead of being trapped in a four-minute call.

## Verdicts travel — and you can do the verifying

Every finding carries `verdict: "confirmed" | "suspect" | "unverified"`.

This matters more over MCP than anywhere else: a human skims a shaky finding and moves on,
but **a coding agent will act on whatever you hand it** — an unverified "the button is
broken" makes it "fix" a working button.

There are two ways to get verdicts:

1. **Shoal verifies** (default) — it spends its own tokens on a reviewer model.
2. **You verify** — pass `verify: false`. Findings come back `unverified` with their full
   evidence trail, and the *calling agent* judges them. This is usually better: your agent
   is the stronger reviewer, it already has the codebase in context, and on a Claude Code
   subscription that reasoning is flat-fee rather than metered.

Option 2 is the architecture the project recommends: **cheap/local models drive the swarm,
your subscription-backed agent orchestrates and verifies.**

## Safety

The MCP server refuses non-local targets unless they are in `SHOAL_ALLOW_DOMAINS`:

```
Error: Refusing to swarm example.com: not a local target.
Set SHOAL_ALLOW_DOMAINS=example.com on the MCP server if you are authorised to test it.
```

Agent-initiated runs are exactly where "point a swarm of browsers at a URL" becomes an
abuse vector, so the default is deny.

## Example agent session

```
› Test the checkout on localhost:3000 with a swarm and fix what it finds.

  → shoal_start_run {url: "http://localhost:3000", task: "Buy something and check out",
                     swarm: 5, strategy: ["rage-quit"], verify: false}
  ← {run_id: "run_m2x…", dashboard_url: "http://localhost:4312", status: "starting"}

  → shoal_run_status {run_id: "run_m2x…"}      (a few times)
  ← {status: "done", agents_done: 5, findings_so_far: 6, cost_so_far_usd: 0.31}

  → shoal_findings {run_id: "run_m2x…"}
  ← friction_map: 3 issues ranked by agents_hit, + 6 findings with personas,
    severity, and each agent's action trail

  The agent starts at the top of the friction map, discards one finding as an
  artifact, and patches the rest.
```
