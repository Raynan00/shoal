export interface Persona {
  id: string;
  emoji: string;
  name: string;
  patience_steps: number;
  profile: string;
  /** Relative frequency in the real audience (from a brief's distribution). Default 1. */
  weight?: number;
  /** Where this persona came from: "builtin" | "product" | "logs". */
  source?: string;
  /**
   * How this persona perceives the page. "a11y" personas are screen-reader users: they
   * read the accessibility tree and navigate by keyboard, never by sight.
   */
  modality?: "vision" | "a11y";
}

/**
 * The second axis. A persona is WHO the user is; a strategy is WHAT they're trying to do
 * to the app. Orthogonal, so personas × strategies multiplies behavioral coverage.
 */
export interface Strategy {
  id: string;
  name: string;
  /** Replaces the run's task when present (e.g. the explorer has no task). */
  goal?: string;
  /** Appended to the agent's system prompt. */
  directive: string;
}

/**
 * Normalized input to persona synthesis. Comes from a product description, the target
 * URL (vision-inferred), or real analytics — all reduced to a product statement plus
 * grounded signals the synthesis weights toward.
 */
export interface AudienceBrief {
  source: "text" | "url" | "logs";
  /** What the product is and who it's for. */
  product: string;
  /** Grounded facts: audience distribution, drop-off points, common errors, rage-click spots. */
  signals: string[];
}

export type AgentStatus =
  /** Part of the swarm but not yet running — waiting for a concurrency slot. */
  | "queued"
  | "starting"
  | "browsing"
  | "thinking"
  | "confused"
  | "done"
  | "gave_up"
  | "error"
  /** Cut short by an operator stop/restart from the dashboard. */
  | "stopped";

export interface Finding {
  agentId: string;
  personaName: string;
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
  ts: number;
  /** What the agent was doing right before it filed this — used by the verify pass. */
  evidence?: { recent: string[]; screenshot?: string };
  /** Set by the Claude verify pass: was this a real issue or likely an agent artifact? */
  verdict?: { status: "confirmed" | "suspect"; note: string };
}

export interface AgentState {
  agentId: string;
  personaId: string;
  personaName: string;
  emoji: string;
  status: AgentStatus;
  step: number;
  lastThought: string;
  lastAction: string;
  screenshot?: string; // base64 jpeg
  /** Which attack strategy this agent is running. */
  strategyId?: string;
  strategyName?: string;
  /** "vision" (screenshots) or "a11y" (accessibility tree — screen-reader users). */
  modality?: "vision" | "a11y";
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Live run lifecycle, so the dashboard can enable/disable its controls correctly. */
export type RunPhase = "idle" | "running" | "stopping" | "finished";

/** Commands the dashboard can send back over the WebSocket. */
export type ControlCommand =
  | { cmd: "stop" }
  | { cmd: "restart"; swarm?: number; strategy?: string; task?: string }
  /** Stream this agent's screenshots — set when the operator clicks a fish. */
  | { cmd: "focus"; agentId: string | null };

export type ShoalEvent =
  | { type: "run_config"; task: string; url: string; swarm: number; mock: boolean; provider?: string; scene?: string }
  | {
      type: "run_state";
      phase: RunPhase;
      swarm: number;
      strategy?: string;
      task: string;
      runNumber: number;
      /** Strategy ids the UI can offer. */
      strategies?: { id: string; name: string }[];
    }
  | { type: "agent_state"; state: AgentState; ts: number }
  /** Many states in one frame — used to seed the whole swarm without 1000 re-renders. */
  | { type: "agent_batch"; states: AgentState[]; ts: number }
  | { type: "thought"; agentId: string; personaName: string; emoji: string; text: string; ts: number }
  | { type: "finding"; finding: Finding }
  /** One agent handed off to another (multi-user scene) — rendered specially in the feed. */
  | { type: "handoff"; from: string; fromEmoji: string; event: string; note?: string; ts: number }
  /** Wipe the wall — a new run is starting. */
  | { type: "run_reset" }
  | { type: "cost"; usage: TokenUsage; costUsd: number | null; ts: number }
  /** Live friction map — findings clustered and ranked by how many users hit each wall. */
  | { type: "clusters"; clusters: FrictionCluster[]; total: number; ts: number }
  | { type: "run_done"; findings: Finding[]; summary: RunSummary };

/** One row of the live friction map: a distinct issue and how much of the swarm hit it. */
export interface FrictionCluster {
  title: string;
  severity: Finding["severity"];
  /** Distinct agent-sessions that hit this wall — the "how many users" number. */
  reach: number;
  /** Distinct personas affected (a wall that trips every persona is worse than a niche one). */
  personas: number;
  /** The verifier flagged every report of this as a possible agent artifact. */
  suspect: boolean;
}

export interface RunSummary {
  total: number;
  completed: number;
  gaveUp: number;
  errored: number;
  durationMs: number;
  usage: TokenUsage;
  /** null when we don't know the model's price (unpriced third-party/local model). */
  costUsd: number | null;
}

export interface RunOptions {
  url: string;
  task: string;
  swarm: number;
  /** How many agents run at once; the rest queue in waves. */
  concurrency: number;
  /** Operator passed --concurrency explicitly: a dashboard restart must not overwrite it. */
  concurrencyPinned?: boolean;
  // "subscription" drives the swarm on the developer's Claude Code Pro/Max token.
  provider: "anthropic" | "openai" | "subscription";
  /** OpenAI-compatible endpoint base URL (OpenRouter, DashScope, Zhipu, Ollama, …). */
  baseUrl?: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Run the Claude verify pass over findings before the report. */
  verify: boolean;
  /** $/M token override for unpriced models: --price-in / --price-out. */
  price?: { inPerM: number; outPerM: number };
  personaIds?: string[];
  /** Strategy ids to cycle across the swarm (the second axis). Default: complete-task. */
  strategyIds?: string[];
  /** When set, synthesize personas for this run instead of using the built-in library. */
  generate?: { n: number; audience?: string; fromLogs?: string };
  /**
   * Race mode: agents sync at a barrier and fire the contended action simultaneously.
   * Implies the `race` strategy. `path` is the page they converge on.
   */
  race?: { path?: string };
  /** Multi-user scene id (e.g. "marketplace"). Casts agents in interacting roles. */
  scene?: string;
  /** Extra hostnames the swarm may target (safety allowlist). */
  allowDomains?: string[];
  /** Skip the target-domain safety confirmation (CI / trusted automation). */
  yes?: boolean;
  maxSteps: number;
  headless: boolean;
  mock: boolean;
  port: number;
  /** Auto-open the dashboard in a real browser window on start (default true; --no-open). */
  open?: boolean;
}
