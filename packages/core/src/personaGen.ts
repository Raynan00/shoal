import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { AgentBrowser, closeSharedBrowser } from "./browser.js";
import { readSubscriptionCreds } from "./subscriptionAuth.js";
import type { AudienceBrief, Persona } from "./types.js";

/**
 * Dynamic persona synthesis. Personas are no longer hand-written and cycled — they're
 * generated against a brief that comes from either the product outlook (a description,
 * or the target URL read by vision) or real log data (analytics export). One synthesis
 * step turns a brief into a weighted panel of distinct simulated users.
 */

type Provider = "anthropic" | "openai" | "subscription";

/** A capable text/vision Claude client for the synthesis + inference calls. */
function smartClient(provider: Provider): { client: Anthropic; model: string } {
  if (provider === "subscription") {
    const creds = readSubscriptionCreds();
    return {
      client: new Anthropic({
        authToken: creds.token,
        apiKey: null,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
        maxRetries: 6,
      }),
      // Sonnet 4.6 grounds and reasons well for a one-shot synthesis without hammering the pool.
      model: "claude-sonnet-4-6",
    };
  }
  // Works for provider "anthropic"; also the fallback for "openai" swarms that still have
  // Anthropic creds for generation. (Generating on an OpenAI-compatible endpoint is a TODO.)
  return { client: new Anthropic(), model: "claude-opus-5" };
}

function hasAnthropicCreds(provider: Provider): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  if (provider === "subscription") {
    try {
      readSubscriptionCreds();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Pull the first JSON array out of a model response, tolerating prose or code fences. */
export function extractJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array in model response");
  return JSON.parse(body.slice(start, end + 1));
}

const kebab = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "persona";

// ─── Briefs ──────────────────────────────────────────────────────────────────

export function briefFromText(product: string): AudienceBrief {
  return { source: "text", product, signals: [] };
}

/** Read the target page and let vision describe the product + its likely audience. */
export async function briefFromUrl(url: string, provider: Provider): Promise<AudienceBrief> {
  const { client, model } = smartClient(provider);
  const browser = new AgentBrowser();
  try {
    await browser.launch(url, true);
    await browser.page.waitForTimeout(600);
    const shot = await browser.screenshot();
    const res = await client.messages.create({
      model,
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "This is the landing page of a product. In 3–5 sentences describe: what the product is, " +
                "the primary task a visitor comes to do, and the distinct kinds of users you'd expect " +
                "(skill levels, devices, motivations). Be concrete about the audience.",
            },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot } },
          ],
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const product = res.content.find((b) => b.type === "text")?.text?.trim() ?? url;
    return { source: "url", product, signals: [] };
  } finally {
    await browser.close();
    await closeSharedBrowser();
  }
}

/**
 * Turn an analytics export into a brief. This is the log-data path. The connectors that
 * FETCH this JSON from PostHog / Sentry / Clarity are the (unbuilt) thin layer; the shape
 * below is the contract, and any of those tools can be reduced to it. Testable via fixture.
 *
 * Expected JSON:
 * {
 *   "product": "optional one-line description",
 *   "distribution": [{ "segment": "impatient mobile shopper", "share": 0.4 }],
 *   "dropoffs":     [{ "step": "checkout button", "rate": 0.31 }],
 *   "errors":       [{ "message": "TypeError ...", "route": "/checkout", "count": 120 }],
 *   "rageClicks":   [{ "element": "Place order", "count": 80 }]
 * }
 */
export function briefFromLogs(path: string): AudienceBrief {
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    product?: string;
    distribution?: { segment: string; share: number }[];
    dropoffs?: { step: string; rate: number }[];
    errors?: { message: string; route?: string; count: number }[];
    rageClicks?: { element: string; count: number }[];
  };
  const signals: string[] = [];
  for (const d of data.distribution ?? [])
    signals.push(`Audience segment: ${d.segment} — ~${Math.round(d.share * 100)}% of real users (weight the panel toward this).`);
  for (const d of data.dropoffs ?? [])
    signals.push(`Real drop-off: ${Math.round(d.rate * 100)}% of users abandon at "${d.step}" — include personas primed to hit and react to this.`);
  for (const e of data.errors ?? [])
    signals.push(`Real error: "${e.message}"${e.route ? ` on ${e.route}` : ""} (${e.count} occurrences) — a persona should reproduce the path that triggers it.`);
  for (const r of data.rageClicks ?? [])
    signals.push(`Rage-clicks on "${r.element}" (${r.count}×) — real users are fighting this control; include someone who will too.`);
  return {
    source: "logs",
    product: data.product ?? "The product these analytics came from (infer from the signals).",
    signals,
  };
}

// ─── Synthesis ───────────────────────────────────────────────────────────────

const SYNTH_SYSTEM =
  "You design a diverse panel of simulated USERS for stress-testing a product's website. " +
  "The panel's value is behavioral diversity grounded in reality — never a set of interchangeable 'average users'.";

function synthPrompt(brief: AudienceBrief, n: number): string {
  return `Product / audience:
${brief.product}

${brief.signals.length ? `Real usage signals (ground the panel in these — weight toward the distribution, and turn known failure points into personas primed to encounter them):\n${brief.signals.map((s) => `- ${s}`).join("\n")}\n` : ""}
Design ${n} DISTINCT personas that reflect this product's actual likely audience — a realistic spread across skill level, patience, device, motivation, and intent. Make them genuinely different from one another.

Return ONLY a JSON array of exactly ${n} objects, each:
{
  "name": "a human first + last name",
  "emoji": "one emoji capturing them",
  "patience_steps": <integer 8-35, lower = quits sooner>,
  "weight": <integer 1-10, relative frequency in the real audience>,
  "profile": "2-4 sentences, written in the SECOND PERSON ('You are...'), describing how they behave, what they know and don't, their reading habits, and how they tend to fail. This is a character brief another AI will role-play verbatim."
}
No prose, no code fence — just the JSON array.`;
}

/**
 * Normalize a model's raw persona array into Persona objects: clamp patience, dedupe ids,
 * fill defaults. Split out from the API call so the fragile parsing/normalizing path is
 * testable without spending tokens.
 */
export function normalizePersonas(raw: Array<Record<string, unknown>>, n: number, source: string): Persona[] {
  const seen = new Set<string>();
  return raw.slice(0, n).map((p, i) => {
    let id = kebab(String(p.name ?? `persona-${i}`));
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const patience = Number(p.patience_steps);
    return {
      id,
      emoji: typeof p.emoji === "string" && p.emoji.trim() ? p.emoji.trim() : "🧑",
      name: String(p.name ?? `Persona ${i + 1}`),
      patience_steps: Number.isFinite(patience) ? Math.min(40, Math.max(6, Math.round(patience))) : 20,
      profile: String(p.profile ?? "You are a typical user trying to complete the task."),
      weight: Number.isFinite(Number(p.weight)) ? Math.max(1, Math.round(Number(p.weight))) : 1,
      source: source === "logs" ? "logs" : "product",
    };
  });
}

export async function synthesizePersonas(
  brief: AudienceBrief,
  n: number,
  provider: Provider,
): Promise<Persona[]> {
  if (!hasAnthropicCreds(provider)) {
    throw new Error(
      "Persona generation needs Anthropic credentials (API key or a Claude Code subscription). " +
        "Set ANTHROPIC_API_KEY, or use --provider subscription.",
    );
  }
  const { client, model } = smartClient(provider);
  const res = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYNTH_SYSTEM,
    messages: [{ role: "user", content: synthPrompt(brief, n) }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  if (res.stop_reason === "refusal") throw new Error("Persona generation was declined by safety classifiers.");
  const text = res.content.find((b) => b.type === "text")?.text ?? "";
  const raw = extractJsonArray(text) as Array<Record<string, unknown>>;
  return normalizePersonas(raw, n, brief.source);
}

/** Serialize a generated panel back to the same YAML schema the built-in library uses. */
export function personasToYaml(personas: Persona[]): string {
  return stringify({
    personas: personas.map((p) => ({
      id: p.id,
      emoji: p.emoji,
      name: p.name,
      patience_steps: p.patience_steps,
      weight: p.weight ?? 1,
      profile: p.profile,
    })),
  });
}
