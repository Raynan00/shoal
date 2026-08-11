/**
 * A driver owns the conversation with one model provider. The agent loop is
 * provider-agnostic: it asks the driver for the next turn, executes any browser
 * actions, and feeds results (text + fresh screenshot) back.
 */

export interface ModelToolCall {
  id: string;
  name: string; // "computer" | "report_finding" | "task_result"
  input: Record<string, unknown>;
}

export interface ModelTurn {
  thoughts: string[];
  toolCalls: ModelToolCall[];
  /** Model ended its turn without asking for tools. */
  endTurn: boolean;
  /** Request was declined by safety classifiers (Anthropic) or the endpoint. */
  refusal?: boolean;
  /** Tokens consumed by this API call (for the live cost meter). */
  usage?: import("./types.js").TokenUsage;
}

/**
 * What the agent perceives after an action. Vision agents get an image; accessibility
 * agents get text (the a11y tree / focused-element description). Never both.
 */
export interface Observation {
  image?: string; // base64 jpeg
  text?: string;
}

export interface AgentDriver {
  init(system: string, first: Observation): void;
  /** Sends pending tool results (if any) and gets the model's next turn. */
  next(): Promise<ModelTurn>;
  addToolResult(id: string, text: string, obs?: Observation): void;
}

/**
 * The screen-reader tool. Deliberately has NO coordinates — a screen-reader user cannot
 * point at pixels. This is what makes the a11y modality an authentic simulation rather
 * than a cheaper vision agent.
 */
export const A11Y_TOOL_NAME = "screen_reader";
export const A11Y_TOOL_DESCRIPTION =
  "Operate the page the way a screen-reader user does: read the accessibility tree, move " +
  "focus with Tab/Shift-Tab, activate the focused control, and type. You cannot see the " +
  "screen and you cannot click coordinates — only these actions exist.";
export const A11Y_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    action: {
      type: "string",
      enum: [
        "read_screen",
        "read_focused",
        "next_element",
        "previous_element",
        "activate",
        "type",
        "list_landmarks",
        "go_back",
        "wait",
      ],
      description:
        "read_screen = survey the whole accessibility tree; next/previous_element = Tab / Shift-Tab; " +
        "activate = press Enter on the focused control; list_landmarks = headings and regions.",
    },
    text: { type: "string", description: "Text to type (type action only)" },
    count: { type: "integer", description: "How many elements to move past (next/previous only, max 15)" },
  },
  required: ["action"],
  additionalProperties: false,
};

/** Provider-neutral schemas for the two shoal tools; drivers adapt the wrapper format. */
export const FINDING_SCHEMA = {
  type: "object" as const,
  properties: {
    severity: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "How badly this hurts a user like you",
    },
    title: { type: "string", description: "Short label for the problem (max ~10 words)" },
    description: {
      type: "string",
      description: "What you did, what you expected, what actually happened",
    },
  },
  required: ["severity", "title", "description"],
  additionalProperties: false,
};

export const FINDING_DESCRIPTION =
  "Report a usability problem, bug, confusing element, or deceptive pattern you just experienced. " +
  "Call this the moment something confuses you, breaks, or violates your expectations — do not wait " +
  "until the end. Describe it from your persona's point of view.";

export const RESULT_SCHEMA = {
  type: "object" as const,
  properties: {
    outcome: { type: "string", enum: ["completed", "gave_up"] },
    reason: { type: "string", description: "One or two sentences on why, in character" },
  },
  required: ["outcome", "reason"],
  additionalProperties: false,
};

export const RESULT_DESCRIPTION =
  "Call exactly once, when you have either completed the task or decided to give up. Ends your session.";

/** Multi-user coordination tools (only offered when the agent has a scene role). */
export const SIGNAL_SCHEMA = {
  type: "object" as const,
  properties: {
    event: { type: "string", description: "Short event name the other user is waiting on, e.g. \"listed\"" },
    note: { type: "string", description: "What happened, for the other user to read (e.g. \"Blue Kayak $50\")" },
  },
  required: ["event"],
  additionalProperties: false,
};
export const AWAIT_SCHEMA = {
  type: "object" as const,
  properties: {
    event: { type: "string", description: "Event name to wait for before continuing" },
  },
  required: ["event"],
  additionalProperties: false,
};
