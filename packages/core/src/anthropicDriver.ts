import Anthropic from "@anthropic-ai/sdk";
import { DISPLAY_WIDTH, DISPLAY_HEIGHT } from "./browser.js";
import { readSubscriptionCreds } from "./subscriptionAuth.js";
import {
  A11Y_TOOL_DESCRIPTION,
  A11Y_TOOL_NAME,
  A11Y_TOOL_SCHEMA,
  FINDING_DESCRIPTION,
  FINDING_SCHEMA,
  RESULT_DESCRIPTION,
  RESULT_SCHEMA,
  SIGNAL_SCHEMA,
  AWAIT_SCHEMA,
  type AgentDriver,
  type ModelTurn,
  type Observation,
} from "./driver.js";
import type { RunOptions } from "./types.js";

/** Older models only support the older computer-use tool version. */
function computerToolFor(model: string): { toolType: string; beta: string } {
  if (model.includes("haiku") || model.includes("sonnet-4-5")) {
    return { toolType: "computer_20250124", beta: "computer-use-2025-01-24" };
  }
  return { toolType: "computer_20251124", beta: "computer-use-2025-11-24" };
}

/** effort / output_config is rejected by Haiku 4.5 and Sonnet 4.5 — omit it there. */
function effortSupported(model: string): boolean {
  return !model.includes("haiku") && !model.includes("sonnet-4-5");
}

/** Replace all but the newest `keep` screenshots in history with a text stub to bound token cost. */
function pruneImages(messages: Anthropic.Beta.BetaMessageParam[], keep: number): void {
  let seen = 0;
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m].content;
    if (!Array.isArray(content)) continue;
    for (let b = content.length - 1; b >= 0; b--) {
      const block = content[b] as { type: string; content?: unknown[] };
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (let i = block.content.length - 1; i >= 0; i--) {
          const inner = block.content[i] as { type: string };
          if (inner.type === "image") {
            seen++;
            if (seen > keep) block.content[i] = { type: "text", text: "[earlier screenshot omitted]" };
          }
        }
      } else if (block.type === "image") {
        seen++;
        if (seen > keep) (content as unknown[])[b] = { type: "text", text: "[earlier screenshot omitted]" };
      }
    }
  }
}

export class AnthropicDriver implements AgentDriver {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private pending: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  private system = "";
  private tools: Anthropic.Beta.BetaToolUnion[];
  private beta: string;
  private extraBetas: string[] = [];

  constructor(
    private opts: RunOptions,
    private modality: "vision" | "a11y" = "vision",
    private withScene = false,
  ) {
    if (opts.provider === "subscription") {
      // Drive on the Claude Code Pro/Max token: bearer auth + the OAuth beta header,
      // read live (it rotates hourly). Extra retries soak up the shared-pool 429s.
      const creds = readSubscriptionCreds();
      this.client = new Anthropic({ authToken: creds.token, apiKey: null, maxRetries: 6 });
      this.extraBetas = ["oauth-2025-04-20"];
    } else {
      this.client = new Anthropic();
    }
    const { toolType, beta } = computerToolFor(opts.model);
    this.beta = beta;
    const perceptionTool: Anthropic.Beta.BetaToolUnion =
      this.modality === "a11y"
        ? ({
            name: A11Y_TOOL_NAME,
            description: A11Y_TOOL_DESCRIPTION,
            input_schema: A11Y_TOOL_SCHEMA,
          } as Anthropic.Beta.BetaToolUnion)
        : ({
            type: toolType,
            name: "computer",
            display_width_px: DISPLAY_WIDTH,
            display_height_px: DISPLAY_HEIGHT,
          } as Anthropic.Beta.BetaToolUnion);
    this.tools = [
      perceptionTool,
      { name: "report_finding", description: FINDING_DESCRIPTION, input_schema: FINDING_SCHEMA, strict: true },
      { name: "task_result", description: RESULT_DESCRIPTION, input_schema: RESULT_SCHEMA, strict: true },
      ...(this.withScene
        ? [
            { name: "signal", description: "Tell the other user something happened.", input_schema: SIGNAL_SCHEMA, strict: true },
            { name: "await_signal", description: "Pause until the other user signals an event.", input_schema: AWAIT_SCHEMA, strict: true },
          ]
        : []),
    ] as Anthropic.Beta.BetaToolUnion[];
    // Cache breakpoint #1 — the tool definitions. Identical for every agent in the swarm,
    // so the whole swarm shares this prefix cache; reads bill at 10% of input price.
    (this.tools[this.tools.length - 1] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
  }

  /**
   * Prompt caching (docs/SCALING.md): an agent loop resends its whole history every step,
   * so cached prefixes cut input cost ~5x and most of time-to-first-token. Budget is 4
   * breakpoints: tools (constructor) + system + two moving markers set here.
   */
  private markCaching(): void {
    // Strip last turn's message markers so the budget never overflows.
    for (const m of this.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) delete (b as { cache_control?: unknown }).cache_control;
    }
    const mark = (idx: number) => {
      const content = this.messages[idx]?.content;
      if (!Array.isArray(content)) return;
      // thinking blocks can't carry cache_control — walk back to one that can.
      for (let i = content.length - 1; i >= 0; i--) {
        const b = content[i] as { type: string; cache_control?: unknown };
        if (b.type !== "thinking" && b.type !== "redacted_thinking") {
          b.cache_control = { type: "ephemeral" };
          return;
        }
      }
    };
    // Newest message: caches the full conversation for the next step.
    mark(this.messages.length - 1);
    // Trailing marker behind the image-prune horizon: pruneImages rewrites history a few
    // tool-results back, which breaks exact-prefix matching at the newest marker — this
    // one sits on a prefix that will never be rewritten again, so it always hits.
    if (this.messages.length > 5) mark(this.messages.length - 5);
  }

  private image(b64: string) {
    return {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/jpeg" as const, data: b64 },
    };
  }

  /** Tool results accept only a narrow block union, so keep the return type tight. */
  private observe(obs: Observation): Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> {
    if (obs.image) return [this.image(obs.image)];
    if (obs.text) return [{ type: "text", text: obs.text }];
    return [];
  }

  init(system: string, first: Observation): void {
    this.system = system;
    const opener =
      this.modality === "a11y"
        ? "The page is loaded. You cannot see it — here is what your screen reader announces. Begin your task."
        : "The browser is open. Here is what you see. Begin your task.";
    this.messages = [
      { role: "user", content: [{ type: "text", text: opener }, ...this.observe(first)] },
    ];
  }

  addToolResult(id: string, text: string, obs?: Observation): void {
    this.pending.push({
      type: "tool_result",
      tool_use_id: id,
      content: obs && (obs.image || obs.text)
        ? [{ type: "text", text }, ...this.observe(obs)]
        : text,
    });
  }

  async next(): Promise<ModelTurn> {
    if (this.pending.length > 0) {
      this.messages.push({ role: "user", content: this.pending });
      this.pending = [];
      pruneImages(this.messages, 3);
    }
    this.markCaching();

    const response = await this.client.beta.messages.create({
      model: this.opts.model,
      max_tokens: 8192,
      // a11y needs no computer-use beta — so it also runs on text-only models.
      betas: this.modality === "a11y" ? this.extraBetas : [this.beta, ...this.extraBetas],
      // Cache breakpoint #2 — the persona's system prompt, reused on every step.
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      ...(effortSupported(this.opts.model) ? { output_config: { effort: this.opts.effort } } : {}),
      tools: this.tools,
      messages: this.messages,
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    if (response.stop_reason === "refusal") {
      return { thoughts: [], toolCalls: [], endTurn: true, refusal: true };
    }

    // Echo the assistant turn back unchanged (required for thinking blocks).
    this.messages.push({ role: "assistant", content: response.content });

    const turn: ModelTurn = {
      thoughts: [],
      toolCalls: [],
      endTurn: response.stop_reason === "end_turn",
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        turn.thoughts.push(block.text.trim());
      } else if (block.type === "tool_use") {
        turn.toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }
    return turn;
  }
}
