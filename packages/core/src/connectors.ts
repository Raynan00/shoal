/**
 * Analytics connectors: turn real product data into the brief JSON that grounds persona
 * synthesis (see docs/GENERATION.md).
 *
 * The reducers are pure and independently testable — they carry the actual mapping logic
 * from each vendor's shape into ours. The fetchers around them are deliberately thin, so
 * a user with an existing export can skip the network entirely and just pipe JSON in.
 */

export interface AnalyticsExport {
  product?: string;
  distribution?: { segment: string; share: number }[];
  dropoffs?: { step: string; rate: number }[];
  errors?: { message: string; route?: string; count: number }[];
  rageClicks?: { element: string; count: number }[];
}

// ── PostHog ──────────────────────────────────────────────────────────────────

/** PostHog funnel insight → drop-off rates between consecutive steps. */
export function reducePostHogFunnel(raw: unknown): AnalyticsExport["dropoffs"] {
  const steps = (raw as { result?: { name?: string; count?: number }[] })?.result ?? [];
  const out: NonNullable<AnalyticsExport["dropoffs"]> = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const from = steps[i]?.count ?? 0;
    const to = steps[i + 1]?.count ?? 0;
    if (from <= 0) continue;
    const rate = Math.max(0, Math.min(1, 1 - to / from));
    if (rate > 0.02) {
      out.push({
        step: `${steps[i]?.name ?? `step ${i + 1}`} → ${steps[i + 1]?.name ?? `step ${i + 2}`}`,
        rate: Number(rate.toFixed(3)),
      });
    }
  }
  return out;
}

/** PostHog breakdown insight (device, browser, cohort…) → audience distribution. */
export function reducePostHogBreakdown(raw: unknown, label = ""): AnalyticsExport["distribution"] {
  const rows = (raw as { result?: { breakdown_value?: unknown; count?: number; aggregated_value?: number }[] })?.result ?? [];
  const scored = rows
    .map((r) => ({
      segment: `${label ? `${label}: ` : ""}${String(r.breakdown_value ?? "unknown")}`,
      count: r.aggregated_value ?? r.count ?? 0,
    }))
    .filter((r) => r.count > 0);
  const total = scored.reduce((s, r) => s + r.count, 0);
  if (total === 0) return [];
  return scored
    .map((r) => ({ segment: r.segment, share: Number((r.count / total).toFixed(3)) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 8);
}

// ── Sentry ───────────────────────────────────────────────────────────────────

/** Sentry issues list → the errors real users actually hit, most frequent first. */
export function reduceSentryIssues(raw: unknown): AnalyticsExport["errors"] {
  const issues = (raw as Array<{
    title?: string;
    culprit?: string;
    count?: string | number;
    metadata?: { value?: string; type?: string };
  }>) ?? [];
  return issues
    .map((i) => ({
      message: i.metadata?.value || i.title || i.metadata?.type || "unknown error",
      route: i.culprit,
      count: Number(i.count ?? 0),
    }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// ── Clarity / FullStory ──────────────────────────────────────────────────────

/**
 * Clarity's Data Export returns metric buckets. We want the behavioural signatures:
 * rage clicks and dead clicks, which mark controls real users are fighting.
 */
export function reduceClarityMetrics(raw: unknown): AnalyticsExport["rageClicks"] {
  const metrics = (raw as Array<{
    metricName?: string;
    information?: Array<{ subTotal?: number | string; sessionsCount?: number | string; url?: string; selector?: string }>;
  }>) ?? [];
  const out: NonNullable<AnalyticsExport["rageClicks"]> = [];
  for (const m of metrics) {
    const name = (m.metricName ?? "").toLowerCase();
    if (!name.includes("rage") && !name.includes("dead")) continue;
    const kind = name.includes("rage") ? "rage-click" : "dead-click";
    for (const info of m.information ?? []) {
      const count = Number(info.subTotal ?? info.sessionsCount ?? 0);
      const where = info.selector || info.url;
      if (count > 0 && where) out.push({ element: `${where} (${kind})`, count });
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 10);
}

// ── Fetchers (thin) ──────────────────────────────────────────────────────────

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function fetchPostHog(opts: {
  host?: string;
  projectId: string;
  apiKey: string;
  funnelInsightId?: string;
  breakdownInsightId?: string;
}): Promise<AnalyticsExport> {
  const host = (opts.host ?? "https://us.posthog.com").replace(/\/$/, "");
  const h = { Authorization: `Bearer ${opts.apiKey}` };
  const out: AnalyticsExport = {};
  if (opts.funnelInsightId) {
    const raw = await getJson(`${host}/api/projects/${opts.projectId}/insights/${opts.funnelInsightId}/`, h);
    out.dropoffs = reducePostHogFunnel((raw as { result?: unknown }).result ? raw : { result: [] });
  }
  if (opts.breakdownInsightId) {
    const raw = await getJson(`${host}/api/projects/${opts.projectId}/insights/${opts.breakdownInsightId}/`, h);
    out.distribution = reducePostHogBreakdown(raw);
  }
  return out;
}

export async function fetchSentry(opts: {
  host?: string;
  org: string;
  project: string;
  token: string;
}): Promise<AnalyticsExport> {
  const host = (opts.host ?? "https://sentry.io").replace(/\/$/, "");
  const raw = await getJson(
    `${host}/api/0/projects/${opts.org}/${opts.project}/issues/?statsPeriod=14d&query=is:unresolved`,
    { Authorization: `Bearer ${opts.token}` },
  );
  return { errors: reduceSentryIssues(raw) };
}

/** Merge partial exports from several sources into one brief input. */
export function mergeExports(...parts: AnalyticsExport[]): AnalyticsExport {
  const out: AnalyticsExport = {};
  for (const p of parts) {
    if (p.product) out.product = p.product;
    if (p.distribution?.length) out.distribution = [...(out.distribution ?? []), ...p.distribution];
    if (p.dropoffs?.length) out.dropoffs = [...(out.dropoffs ?? []), ...p.dropoffs];
    if (p.errors?.length) out.errors = [...(out.errors ?? []), ...p.errors];
    if (p.rageClicks?.length) out.rageClicks = [...(out.rageClicks ?? []), ...p.rageClicks];
  }
  return out;
}
