import type { TokenUsage } from "./types.js";

/**
 * $ per million tokens [input, output]. Cache reads bill at ~0.1x input,
 * cache writes at ~1.25x. Matched by substring so date-suffixed ids still hit.
 * Third-party prices drift — treat non-Anthropic rows as ballpark, and override
 * with --price-in/--price-out when you know your rate.
 */
const PRICES: Array<{ match: string; inPerM: number; outPerM: number }> = [
  { match: "claude-opus-5", inPerM: 5, outPerM: 25 },
  { match: "claude-opus-4", inPerM: 5, outPerM: 25 },
  { match: "claude-sonnet-5", inPerM: 3, outPerM: 15 },
  { match: "claude-sonnet-4", inPerM: 3, outPerM: 15 },
  { match: "claude-haiku-4-5", inPerM: 1, outPerM: 5 },
  // Ballpark third-party rates (per their public pages; verify yours):
  { match: "qwen3-vl-plus", inPerM: 0.2, outPerM: 1.6 },
  { match: "qwen", inPerM: 0.4, outPerM: 1.2 },
  { match: "glm", inPerM: 0.6, outPerM: 2.2 },
];

export function priceFor(model: string, override?: { inPerM: number; outPerM: number }): { inPerM: number; outPerM: number } | null {
  if (override) return override;
  const m = model.toLowerCase();
  // Local endpoints are free regardless of model name.
  return PRICES.find((p) => m.includes(p.match)) ?? null;
}

export function costUsd(u: TokenUsage, price: { inPerM: number; outPerM: number }): number {
  return (
    (u.input * price.inPerM +
      u.cacheRead * price.inPerM * 0.1 +
      u.cacheWrite * price.inPerM * 1.25 +
      u.output * price.outPerM) /
    1_000_000
  );
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** What the same token volume would cost on other tiers — the marketing table. */
export function comparisonRows(u: TokenUsage): Array<{ label: string; usd: number }> {
  const tiers = [
    { label: "claude-opus-5", inPerM: 5, outPerM: 25 },
    { label: "claude-haiku-4-5", inPerM: 1, outPerM: 5 },
    { label: "qwen3-vl-plus (est.)", inPerM: 0.2, outPerM: 1.6 },
    { label: "local model (Ollama)", inPerM: 0, outPerM: 0 },
  ];
  return tiers.map((t) => ({ label: t.label, usd: costUsd(u, t) }));
}
