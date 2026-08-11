import { DISPLAY_WIDTH, DISPLAY_HEIGHT } from "./browser.js";
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

/**
 * OpenAI-compatible driver for the scale tier: Qwen-VL (DashScope), GLM-V (Zhipu),
 * anything on OpenRouter, or a local model via Ollama/vLLM. The model must support
 * vision + tool calling — it sees screenshots and emits actions through a generic
 * "computer" function tool (no provider-native computer-use needed).
 *
 * Uses plain fetch, no SDK dependency.
 */

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const COMPUTER_TOOL = {
  type: "function",
  function: {
    name: "computer",
    description:
      `Control the browser you are looking at. The screen is ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT} pixels; ` +
      `coordinates are [x, y] from the top-left of the screenshot. After every action you receive a fresh screenshot. ` +
      `Use "screenshot" alone to look again without acting.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot", "left_click", "double_click", "right_click", "type",
            "key", "scroll", "left_click_drag", "mouse_move", "wait",
          ],
          description: "What to do",
        },
        coordinate: {
          type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2,
          description: "[x, y] target for click/move/scroll actions",
        },
        start_coordinate: {
          type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2,
          description: "[x, y] drag start (left_click_drag only)",
        },
        text: { type: "string", description: "Text to type, or key combo like 'ctrl+a' / 'Enter' for the key action" },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "integer", description: "Scroll clicks, ~3 is one notch" },
        duration: { type: "number", description: "Seconds to wait (wait action only)" },
      },
      required: ["action"],
    },
  },
};

const A11Y_TOOL = {
  type: "function",
  function: { name: A11Y_TOOL_NAME, description: A11Y_TOOL_DESCRIPTION, parameters: A11Y_TOOL_SCHEMA },
};

const toolsFor = (modality: "vision" | "a11y", withScene: boolean) => [
  modality === "a11y" ? A11Y_TOOL : COMPUTER_TOOL,
  { type: "function", function: { name: "report_finding", description: FINDING_DESCRIPTION, parameters: FINDING_SCHEMA } },
  { type: "function", function: { name: "task_result", description: RESULT_DESCRIPTION, parameters: RESULT_SCHEMA } },
  ...(withScene
    ? [
        { type: "function", function: { name: "signal", description: "Tell the other user something happened.", parameters: SIGNAL_SCHEMA } },
        { type: "function", function: { name: "await_signal", description: "Pause until the other user signals an event.", parameters: AWAIT_SCHEMA } },
      ]
    : []),
];

/** Keep only the newest `keep` screenshots in history; stub the rest. */
function pruneImages(messages: OAIMessage[], keep: number): void {
  let seen = 0;
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m].content;
    if (!Array.isArray(content)) continue;
    for (let b = content.length - 1; b >= 0; b--) {
      if ((content[b] as { type?: string }).type === "image_url") {
        seen++;
        if (seen > keep) content[b] = { type: "text", text: "[earlier screenshot omitted]" };
      }
    }
  }
}

export class OpenAIDriver implements AgentDriver {
  private messages: OAIMessage[] = [];
  private pendingResults: { id: string; text: string }[] = [];
  private pendingScreenshot?: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(
    private opts: RunOptions,
    private modality: "vision" | "a11y" = "vision",
    private withScene = false,
  ) {
    this.baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = process.env.SHOAL_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  }

  private image(b64: string) {
    return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } };
  }

  init(system: string, first: Observation): void {
    const opener =
      this.modality === "a11y"
        ? "The page is loaded. You cannot see it — here is what your screen reader announces. Begin your task."
        : "The browser is open. Here is what you see. Begin your task.";
    this.messages = [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: opener },
          ...(first.image ? [this.image(first.image)] : []),
          ...(first.text ? [{ type: "text", text: first.text }] : []),
        ],
      },
    ];
  }

  addToolResult(id: string, text: string, obs?: Observation): void {
    // a11y observations are plain text, so they fold straight into the tool result.
    this.pendingResults.push({ id, text: obs?.text ? `${text}\n${obs.text}` : text });
    // Most OpenAI-compatible endpoints reject images inside `tool` messages,
    // so a screenshot rides in a follow-up user message instead.
    if (obs?.image) this.pendingScreenshot = obs.image;
  }

  async next(): Promise<ModelTurn> {
    for (const r of this.pendingResults) {
      this.messages.push({ role: "tool", tool_call_id: r.id, content: r.text });
    }
    this.pendingResults = [];
    if (this.pendingScreenshot) {
      this.messages.push({
        role: "user",
        content: [{ type: "text", text: "Current screenshot:" }, this.image(this.pendingScreenshot)],
      });
      this.pendingScreenshot = undefined;
    }
    pruneImages(this.messages, 3);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: 2048,
        messages: this.messages,
        tools: toolsFor(this.modality, this.withScene),
        tool_choice: "auto",
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${this.baseUrl} returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: OAIMessage & { content: string | null }; finish_reason: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Endpoint returned no choices");

    // Echo the assistant message back verbatim so tool_call ids stay linked.
    this.messages.push({
      role: "assistant",
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
    });

    const turn: ModelTurn = {
      thoughts: [],
      toolCalls: [],
      endTurn: !choice.message.tool_calls?.length,
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    const text = typeof choice.message.content === "string" ? choice.message.content.trim() : "";
    if (text) turn.thoughts.push(text);
    for (const call of choice.message.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        // Weak models sometimes emit malformed JSON args; skip rather than crash.
        continue;
      }
      turn.toolCalls.push({ id: call.id, name: call.function.name, input });
    }
    return turn;
  }
}
