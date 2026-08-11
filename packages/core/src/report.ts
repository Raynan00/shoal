import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparisonRows } from "./pricing.js";
import type { Finding, FrictionCluster, RunOptions, RunSummary } from "./types.js";

/** Group near-duplicate findings (same trap hit by several agents) by normalized title words. */
export function clusterFindings(
  findings: Finding[],
): { title: string; severity: Finding["severity"]; hitBy: string[]; reach: number; examples: Finding[] }[] {
  const clusters: { key: Set<string>; items: Finding[] }[] = [];
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3));
  const overlap = (a: Set<string>, b: Set<string>) => {
    let n = 0;
    for (const t of a) if (b.has(t)) n++;
    return n / Math.max(1, Math.min(a.size, b.size));
  };

  for (const f of findings) {
    const key = tokens(f.title + " " + f.description);
    const hit = clusters.find((c) => overlap(c.key, key) >= 0.34);
    if (hit) {
      hit.items.push(f);
      for (const t of key) hit.key.add(t);
    } else {
      clusters.push({ key, items: [f] });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return clusters
    .map((c) => {
      const top = [...c.items].sort((a, b) => rank[a.severity] - rank[b.severity])[0];
      return {
        title: top.title,
        severity: top.severity,
        hitBy: [...new Set(c.items.map((i) => i.personaName))],
        // Reach is agent-SESSIONS (each finding is one), not distinct persona names — with a
        // cycled persona pool the same name recurs across hundreds of agents, and "312 users
        // hit this" is the number that matters, not "3 personas did".
        reach: new Set(c.items.map((i) => i.agentId)).size,
        examples: c.items,
      };
    })
    .sort((a, b) => b.reach - a.reach || rank[a.severity] - rank[b.severity]);
}

/** The friction map for the live dashboard — clusters stripped to what a viewer needs. */
export function frictionMap(findings: Finding[]): FrictionCluster[] {
  return clusterFindings(findings).map((c) => ({
    title: c.title,
    severity: c.severity,
    reach: c.reach,
    personas: c.hitBy.length,
    suspect: c.examples.every((e) => e.verdict?.status === "suspect"),
  }));
}

function costLines(summary: RunSummary, opts: RunOptions): string[] {
  if (opts.mock) return [`- **Cost:** $0.00 (mock mode)`];
  const totalTokens = summary.usage.input + summary.usage.cacheRead + summary.usage.cacheWrite + summary.usage.output;
  if (totalTokens === 0) return [];
  const lines = [
    summary.costUsd !== null
      ? `- **Cost:** $${summary.costUsd.toFixed(2)} total · $${(summary.costUsd / summary.total).toFixed(3)} per agent-session (${(totalTokens / 1000).toFixed(0)}k tokens on ${opts.model})`
      : `- **Tokens:** ${(totalTokens / 1000).toFixed(0)}k on ${opts.model} (price unknown — pass --price-in/--price-out)`,
    ``,
    `### What this token volume costs per tier`,
    ``,
    `*Rough estimate: same token counts priced at each tier's rates (tokenizers differ across models).*`,
    ``,
    `| Tier | Cost |`,
    `|---|---|`,
    ...comparisonRows(summary.usage).map((r) => `| ${r.label} | $${r.usd.toFixed(2)} |`),
  ];
  return lines;
}

export async function writeReport(findings: Finding[], summary: RunSummary, opts: RunOptions): Promise<string> {
  const clusters = clusterFindings(findings);
  const sevIcon = { high: "🔴", medium: "🟡", low: "🔵" } as const;

  const md = [
    `# 🐟 Shoal swarm report`,
    ``,
    `- **Target:** ${opts.url}`,
    `- **Task:** ${opts.task}`,
    `- **Swarm:** ${summary.total} agents (${opts.mock ? "mock mode" : opts.model})`,
    `- **Outcome:** ${summary.completed} completed · ${summary.gaveUp} gave up · ${summary.errored} errored`,
    ...costLines(summary, opts),
    ``,
    `## Findings (${clusters.length} issues, ${findings.length} reports${
      findings.some((f) => f.verdict)
        ? `; verify pass: ${findings.filter((f) => f.verdict?.status !== "suspect").length} confirmed, ${findings.filter((f) => f.verdict?.status === "suspect").length} suspect`
        : ""
    })`,
    ``,
    ...clusters.flatMap((c) => {
      const allSuspect = c.examples.every((e) => e.verdict?.status === "suspect");
      return [
        `### ${sevIcon[c.severity]} ${c.title}${allSuspect ? " ⚠️ *(suspect — possible agent artifact, review manually)*" : ""}`,
        ``,
        `Hit by **${c.reach}/${summary.total}** agents across ${c.hitBy.length} persona${c.hitBy.length === 1 ? "" : "s"}: ${c.hitBy.join(", ")}`,
        ``,
        ...c.examples.slice(0, 3).map(
          (e) =>
            `> *${e.personaName}:* ${e.description}${
              e.verdict?.status === "suspect" ? `\n> ⚠️ *verifier: ${e.verdict.note}*` : ""
            }`,
        ),
        ``,
      ];
    }),
  ].join("\n");

  const mdPath = join(process.cwd(), "shoal-report.md");
  const jsonPath = join(process.cwd(), "shoal-report.json");
  await writeFile(mdPath, md, "utf8");
  await writeFile(jsonPath, JSON.stringify({ summary, clusters, findings }, null, 2), "utf8");
  return mdPath;
}
