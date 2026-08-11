import { runSwarm } from "./orchestrator.js";
import type { Finding, RunOptions, RunSummary } from "./types.js";

/**
 * Tracks swarm runs started asynchronously. A run takes minutes and costs money, so an
 * MCP client must be able to start one, get an id back immediately, poll cheaply, and
 * read findings when they're ready — never block a tool call for four minutes.
 */

export interface TrackedRun {
  id: string;
  status: "starting" | "running" | "verifying" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  url: string;
  task: string;
  swarm: number;
  dashboardUrl: string;
  agentsDone: number;
  costUsd: number | null;
  findings: Finding[];
  summary?: RunSummary;
  reportPath?: string;
  error?: string;
}

const runs = new Map<string, TrackedRun>();
let seq = 0;

export function startRun(opts: RunOptions): TrackedRun {
  const id = `run_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const run: TrackedRun = {
    id,
    status: "starting",
    startedAt: Date.now(),
    url: opts.url,
    task: opts.task,
    swarm: opts.swarm,
    dashboardUrl: `http://localhost:${opts.port}`,
    agentsDone: 0,
    costUsd: null,
    findings: [],
  };
  runs.set(id, run);

  // Fire and forget — the caller polls. Never let a rejection become an unhandled crash.
  void runSwarm(opts, {
    quiet: true,
    keepAlive: false,
    onFinding: (f) => run.findings.push(f),
    onProgress: (p) => {
      run.status = "running";
      run.agentsDone = p.done;
      run.costUsd = p.costUsd;
      if (p.done >= p.total) run.status = "verifying";
    },
    onDone: ({ findings, summary, reportPath }) => {
      run.findings = findings;
      run.summary = summary;
      run.reportPath = reportPath;
      run.costUsd = summary.costUsd;
      run.status = "done";
      run.finishedAt = Date.now();
    },
  }).catch((err: Error) => {
    run.status = "error";
    run.error = err.message;
    run.finishedAt = Date.now();
  });

  return run;
}

export const getRun = (id: string): TrackedRun | undefined => runs.get(id);
export const listRuns = (): TrackedRun[] => [...runs.values()];

/** Best-effort cancel: marks the run finished so the client stops polling. */
export function stopRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status === "done") return false;
  run.status = "done";
  run.finishedAt = Date.now();
  return true;
}
