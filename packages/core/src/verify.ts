import Anthropic from "@anthropic-ai/sdk";
import type { Finding, TokenUsage } from "./types.js";

/**
 * The editor-in-chief pass: cheap models (or grounding slips on any model) produce
 * findings that are artifacts of the agent, not the site — "the button doesn't work"
 * when the agent simply missed it. One strong Claude call reviews every finding
 * against the agent's action trail + screenshot and marks it confirmed or suspect.
 * Suspect findings stay in the report, flagged for human review, never silently dropped.
 */

const MAX_SCREENSHOTS = 16;

export async function verifyFindings(
  findings: Finding[],
  task: string,
  auth?: { authToken?: string; model?: string },
): Promise<TokenUsage | undefined> {
  if (findings.length === 0) return undefined;
  // OAuth (subscription) tokens need the oauth beta header on every request.
  const client = auth?.authToken
    ? new Anthropic({ authToken: auth.authToken, apiKey: null, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })
    : new Anthropic();
  const model = auth?.model ?? "claude-opus-5";

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `Simulated user-testing agents attempted this task on a website: "${task}".\n` +
        `Below are the usability findings they filed, each with the agent's persona, its recent ` +
        `thoughts/actions before filing, and (for some) the screenshot at that moment.\n\n` +
        `For each finding, judge: is this plausibly a real problem with the SITE, or likely an ` +
        `artifact of the AGENT (missed click, hallucinated element, misread screen, persona ` +
        `over-dramatizing something normal)? Lean "confirmed" when the evidence is consistent; ` +
        `use "suspect" when the action trail contradicts the claim or the claim is unfalsifiable ` +
        `from the evidence.`,
    },
  ];

  findings.forEach((f, i) => {
    content.push({
      type: "text",
      text:
        `\n--- Finding ${i} ---\n` +
        `Persona: ${f.personaName}\nSeverity: ${f.severity}\nTitle: ${f.title}\n` +
        `Description: ${f.description}\n` +
        `Recent trail:\n${(f.evidence?.recent ?? []).map((r) => `  - ${r}`).join("\n") || "  (none)"}`,
    });
    if (f.evidence?.screenshot && i < MAX_SCREENSHOTS) {
      content.push({ type: "text", text: `Screenshot at the moment of finding ${i}:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: f.evidence.screenshot },
      });
    }
  });

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            verdicts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer" },
                  status: { type: "string", enum: ["confirmed", "suspect"] },
                  note: { type: "string", description: "One sentence: why" },
                },
                required: ["index", "status", "note"],
                additionalProperties: false,
              },
            },
          },
          required: ["verdicts"],
          additionalProperties: false,
        },
      },
    },
  } as Anthropic.MessageCreateParamsNonStreaming);

  const usage: TokenUsage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  };
  if (response.stop_reason === "refusal") return usage;
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(text) as { verdicts: { index: number; status: "confirmed" | "suspect"; note: string }[] };
  for (const v of parsed.verdicts ?? []) {
    const f = findings[v.index];
    if (f) f.verdict = { status: v.status, note: v.note };
  }
  return usage;
}
