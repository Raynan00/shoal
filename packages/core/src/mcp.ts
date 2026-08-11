import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadPersonas } from "./personas.js";
import { frictionMap } from "./report.js";
import { loadStrategies } from "./strategies.js";
import { getRun, listRuns, startRun, stopRun, type TrackedRun } from "./runManager.js";
import { isTargetAllowed } from "./safety.js";
import type { RunOptions } from "./types.js";

/**
 * Shoal as an MCP server — the swarm inside your coding agent's loop.
 *
 * The developer says "test this checkout with a swarm"; the agent starts a run, polls,
 * reads verified findings, and fixes them without leaving the editor. Two design rules
 * follow from that:
 *
 *  1. ASYNC. Runs take minutes; MCP tool calls should return in seconds. start → poll →
 *     read, never a four-minute blocking call.
 *  2. VERDICTS TRAVEL. A human skims a shaky finding and moves on; an agent ACTS on it.
 *     Every finding carries confirmed/suspect so the caller can weight it — and can
 *     re-verify itself (on its own subscription) rather than paying Shoal's verifier.
 *
 * Transport is newline-delimited JSON-RPC 2.0 on stdio, implemented directly so the
 * package takes no extra dependency.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "shoal_list_personas",
    description:
      "List the simulated-user personas and attack strategies available to a swarm. Call this " +
      "first if you want to target specific user types (e.g. the screen-reader persona for an " +
      "accessibility pass) or a specific strategy (e.g. rage-quit to find where users abandon).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "shoal_start_run",
    description:
      "Start a swarm of AI users against a URL. Returns immediately with a run_id — poll " +
      "shoal_run_status, then read shoal_findings. Runs take minutes and cost money, so keep " +
      "swarm small (3-8) unless asked otherwise, and prefer a local/dev URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL (usually a local dev server or deploy preview)" },
        task: { type: "string", description: "What the simulated users should try to do" },
        swarm: { type: "integer", description: "Number of agents (default 5)" },
        personas: { type: "array", items: { type: "string" }, description: "Persona ids (default: all)" },
        strategy: {
          type: "array",
          items: { type: "string" },
          description: "Strategy ids, e.g. rage-quit, dark-patterns, adversarial-input, state-breaker",
        },
        generate: { type: "integer", description: "Synthesize N personas for this run instead of using the library" },
        audience: { type: "string", description: "Audience/product description to synthesize personas from" },
        race: { type: "boolean", description: "Race mode: agents sync and hit one contended action together" },
        verify: {
          type: "boolean",
          description:
            "Run Shoal's own verify pass (default true). Set false to verify the findings YOURSELF " +
            "from their evidence — cheaper, and you are the stronger reviewer.",
        },
        max_usd: { type: "number", description: "Advisory cost ceiling for this run" },
      },
      required: ["url", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "shoal_run_status",
    description: "Cheap progress poll for a run: status, agents finished, cost so far, findings count.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "shoal_findings",
    description:
      "Verified findings for a run, plus a friction_map — the findings clustered into distinct " +
      "issues ranked by how many agents hit each one (fix the top of that list first). Each " +
      "finding carries a verdict: 'confirmed' (evidence supports it) or 'suspect' (possible " +
      "agent artifact — treat as a lead, not a fact). Evidence is the agent's action trail.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        include_suspect: { type: "boolean", description: "Include suspect findings (default true)" },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "shoal_stop",
    description: "Stop tracking a run early (e.g. you have enough findings, or it is taking too long).",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
];

function summarize(run: TrackedRun) {
  return {
    run_id: run.id,
    status: run.status,
    agents_done: run.agentsDone,
    agents_total: run.swarm,
    findings_so_far: run.findings.length,
    cost_so_far_usd: run.costUsd,
    dashboard_url: run.dashboardUrl,
    ...(run.summary
      ? {
          completed: run.summary.completed,
          gave_up: run.summary.gaveUp,
          errored: run.summary.errored,
          duration_s: Math.round(run.summary.durationMs / 1000),
        }
      : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function findingsPayload(run: TrackedRun, includeSuspect: boolean) {
  const list = run.findings
    .filter((f) => includeSuspect || f.verdict?.status !== "suspect")
    .map((f) => ({
      title: f.title,
      severity: f.severity,
      description: f.description,
      persona: f.personaName,
      verdict: f.verdict?.status ?? "unverified",
      verdict_note: f.verdict?.note,
      evidence: f.evidence?.recent ?? [],
    }));
  const suspect = run.findings.filter((f) => f.verdict?.status === "suspect").length;
  return {
    status: run.status,
    total: run.findings.length,
    confirmed: run.findings.length - suspect,
    suspect,
    // The fix-this-first view: findings clustered into distinct issues, ranked by how
    // many agent-sessions hit each one. Reach is the prioritization signal.
    friction_map: frictionMap(run.findings).map((c) => ({
      title: c.title,
      severity: c.severity,
      agents_hit: c.reach,
      personas_hit: c.personas,
      ...(c.suspect ? { all_reports_suspect: true } : {}),
    })),
    findings: list,
    ...(run.reportPath ? { report_path: run.reportPath } : {}),
    note:
      "Findings marked 'suspect' may be artifacts of the simulated user rather than real defects — " +
      "check the evidence trail before acting on them. 'unverified' means no verify pass ran; you " +
      "should judge them from their evidence yourself.",
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "shoal_list_personas":
      return {
        personas: loadPersonas().map((p) => ({
          id: p.id,
          name: p.name,
          modality: p.modality ?? "vision",
          patience_steps: p.patience_steps,
          summary: p.profile.trim().split("\n")[0].slice(0, 160),
        })),
        strategies: loadStrategies().map((s) => ({ id: s.id, name: s.name })),
      };

    case "shoal_start_run": {
      const url = String(args.url ?? "");
      if (!url) throw new Error("url is required");
      // The agent is spending someone else's money and bandwidth — gate non-local targets.
      const allow = (process.env.SHOAL_ALLOW_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!isTargetAllowed(url, allow)) {
        throw new Error(
          `Refusing to swarm ${new URL(url).hostname}: not a local target. ` +
            `Set SHOAL_ALLOW_DOMAINS=${new URL(url).hostname} on the MCP server if you are authorised to test it.`,
        );
      }
      const swarm = Math.max(1, Math.min(Number(args.swarm ?? 5), 50));
      const opts: RunOptions = {
        url,
        task: String(args.task ?? "Explore the site and report anything confusing."),
        swarm,
        concurrency: Math.min(swarm, 5),
        provider: (process.env.SHOAL_PROVIDER as RunOptions["provider"]) ?? "anthropic",
        model: process.env.SHOAL_MODEL ?? "claude-opus-5",
        baseUrl: process.env.SHOAL_BASE_URL,
        effort: "medium",
        // Default true, but an MCP client is usually the better verifier — see tool description.
        verify: args.verify !== false,
        personaIds: Array.isArray(args.personas) ? (args.personas as string[]) : undefined,
        strategyIds: Array.isArray(args.strategy) ? (args.strategy as string[]) : undefined,
        generate: args.generate
          ? { n: Number(args.generate), audience: args.audience ? String(args.audience) : undefined }
          : undefined,
        race: args.race ? {} : undefined,
        maxSteps: 30,
        headless: true,
        mock: false,
        port: 4300 + Math.floor(Math.random() * 400),
      };
      const run = startRun(opts);
      return {
        ...summarize(run),
        next: "Poll shoal_run_status with this run_id; when status is 'done', call shoal_findings.",
      };
    }

    case "shoal_run_status": {
      const run = getRun(String(args.run_id));
      if (!run) throw new Error(`Unknown run_id: ${args.run_id}`);
      return summarize(run);
    }

    case "shoal_findings": {
      const run = getRun(String(args.run_id));
      if (!run) throw new Error(`Unknown run_id: ${args.run_id}`);
      return findingsPayload(run, args.include_suspect !== false);
    }

    case "shoal_stop": {
      const ok = stopRun(String(args.run_id));
      return { stopped: ok };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function startMcpServer(): void {
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: RpcRequest["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: RpcRequest["id"], code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(text) as RpcRequest;
    } catch {
      return; // not our problem; a malformed frame shouldn't kill the server
    }

    void (async () => {
      try {
        switch (req.method) {
          case "initialize":
            reply(req.id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "shoal", version: "0.1.0" },
              instructions:
                "Shoal runs swarms of simulated users against a website and returns verified UX " +
                "findings. Runs are asynchronous: shoal_start_run → poll shoal_run_status → " +
                "shoal_findings. Findings marked 'suspect' may be artifacts of the simulated user; " +
                "check the evidence trail before changing code because of one.",
            });
            return;

          case "notifications/initialized":
          case "notifications/cancelled":
            return; // notifications take no reply

          case "ping":
            reply(req.id, {});
            return;

          case "tools/list":
            reply(req.id, { tools: TOOLS });
            return;

          case "tools/call": {
            const name = String(req.params?.name ?? "");
            const args = (req.params?.arguments as Record<string, unknown>) ?? {};
            try {
              const result = await callTool(name, args);
              reply(req.id, {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              });
            } catch (err) {
              // Tool errors ride in the result so the model can read and adapt to them.
              reply(req.id, {
                content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
                isError: true,
              });
            }
            return;
          }

          case "resources/list":
            reply(req.id, {
              resources: listRuns()
                .filter((r) => r.reportPath)
                .map((r) => ({
                  uri: `shoal://runs/${r.id}/report`,
                  name: `Shoal report — ${r.task.slice(0, 60)}`,
                  description: `${r.findings.length} findings from ${r.swarm} agents on ${r.url}`,
                  mimeType: "text/markdown",
                })),
            });
            return;

          case "resources/read": {
            const uri = String(req.params?.uri ?? "");
            const id = uri.match(/^shoal:\/\/runs\/([^/]+)\/report$/)?.[1];
            const run = id ? getRun(id) : undefined;
            if (!run?.reportPath) {
              fail(req.id, -32602, `No report available for ${uri}`);
              return;
            }
            reply(req.id, {
              contents: [
                { uri, mimeType: "text/markdown", text: readFileSync(run.reportPath, "utf8") },
              ],
            });
            return;
          }

          default:
            if (req.id !== undefined && req.id !== null) fail(req.id, -32601, `Method not found: ${req.method}`);
        }
      } catch (err) {
        if (req.id !== undefined && req.id !== null) fail(req.id, -32603, (err as Error).message);
      }
    })();
  });

  rl.on("close", () => process.exit(0));
  // stderr is free-form for MCP; stdout is strictly the protocol.
  process.stderr.write("shoal MCP server ready (stdio)\n");
}
