import { runLlmAgent, type AgentCallbacks, type AgentContext } from "./agent.js";
import { runMockAgent } from "./mockAgent.js";
import { runGhostRacer } from "./ghostRacer.js";
import { pickPersonas, fillFromPool } from "./personas.js";
import { assignStrategies, getStrategy } from "./strategies.js";
import { briefFromText, briefFromLogs, briefFromUrl, synthesizePersonas } from "./personaGen.js";
import { ShoalServer } from "./server.js";
import { writeReport, frictionMap } from "./report.js";
import { verifyFindings } from "./verify.js";
import { closeSharedBrowser, configureBrowserPool } from "./browser.js";
import { closeSharedA11yBrowser } from "./a11yBrowser.js";
import { Barrier } from "./barrier.js";
import { ActiveGate } from "./gate.js";
import { activeCapacity } from "./capacity.js";
import { Rendezvous } from "./rendezvous.js";
import { getScene, expandRoles, sceneScales, type SceneInstance } from "./scenes.js";
import { addUsage, costUsd, priceFor, ZERO_USAGE } from "./pricing.js";
import { readSubscriptionCreds } from "./subscriptionAuth.js";
import type { AgentState, Finding, RunOptions, RunSummary, TokenUsage } from "./types.js";

/** Optional observers so a host (the MCP server) can track a run without the console. */
export interface RunHooks {
  onFinding?: (f: Finding) => void;
  onProgress?: (p: { done: number; total: number; costUsd: number | null }) => void;
  onDone?: (r: { findings: Finding[]; summary: RunSummary; reportPath: string }) => void;
  /** Keep the dashboard server alive after the run (CLI does; MCP shuts down). */
  keepAlive?: boolean;
  quiet?: boolean;
  /**
   * Reuse a server that outlives this run. The dashboard stays connected across
   * stop/restart cycles, which is what makes the UI controls work.
   */
  server?: ShoalServer;
  /** Aborted by an operator stop/restart. */
  signal?: AbortSignal;
}

function readSubTypeSafe(): string {
  try {
    return readSubscriptionCreds().subscriptionType;
  } catch {
    return "";
  }
}

/** How many agents keep streaming full screenshots when the swarm is large. Sized to
 * fill the camera wall — these are the only live viewports in a big run. */
const FEATURED = 18;

/** Run `fn` over every index with at most `limit` in flight (wave scheduling). */
async function pool<R>(
  count: number,
  limit: number,
  fn: (i: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(count);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    // Queued agents never start once an operator has stopped the run.
    while (next < count && !signal?.aborted) {
      const i = next++;
      results[i] = await fn(i);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean) as R[];
}

export async function runSwarm(opts: RunOptions, hooks: RunHooks = {}): Promise<RunSummary> {
  const log = hooks.quiet ? () => {} : console.log;
  const server = hooks.server ?? new ShoalServer();
  if (!hooks.server) await server.start(opts.port);
  else server.race.reset(); // fresh contended resource for each run

  const dashboardUrl = `http://localhost:${opts.port}`;
  // Race mode converges everyone on the contended page.
  const racePath = opts.race ? (opts.race.path ?? "/shop/race.html") : null;
  const targetUrl = opts.mock
    ? `${dashboardUrl}${racePath ?? "/shop"}`
    : racePath && opts.race?.path
      ? new URL(racePath, opts.url).toString()
      : opts.url;
  // Multi-user scene: cast agents in interacting roles. A scene can be a small fixed cast
  // (2 coordinators) or a coordinator in front of a scalable CROWD (1 seller + N buyers).
  // Fixed casts run all-at-once; a crowd runs in memory-safe waves like the swarm.
  const scene = opts.scene ? getScene(opts.scene) : null;
  const instances: SceneInstance[] | null = scene ? expandRoles(scene, opts.swarm) : null;
  const scaled = scene ? sceneScales(scene) : false;
  if (scene) {
    server.market.reset();
    server.doc.reset();
    server.chat.reset();
  }
  const rendezvous = scene ? new Rendezvous() : undefined;

  const effectiveSwarm = instances ? instances.length : opts.swarm;
  // A browserless crowd (ghost racers) costs one fetch each, so the whole shoal can be live
  // and parked on the drop at once — that simultaneity is the whole point of a flash sale.
  // A crowd of real browsers still runs in memory-safe waves.
  const browserlessCrowd = scene?.roles.some((r) => r.scalable && r.browserless) ?? false;
  const effectiveConcurrency = scene
    ? scaled
      ? browserlessCrowd
        ? Math.min(effectiveSwarm, 1200)
        : Math.max(2, opts.concurrency)
      : instances!.length
    : opts.concurrency;
  const bigSwarm = effectiveSwarm > 24;

  const roleCounts = scene
    ? scene.roles.map((r) => `${instances!.filter((x) => x.role.id === r.id).length} ${r.label}`).join(" + ")
    : "";
  log(`\n  🐟 shoal — ${scene ? `scene "${scene.name}"` : `swarm of ${effectiveSwarm}`} on ${targetUrl}`);
  log(`  🌊 ${effectiveConcurrency} at a time${opts.mock ? " (mock mode)" : ` · ${opts.provider}:${opts.model}`}`);
  if (opts.race) log(`  🏁 race mode — agents sync at a barrier, then strike together`);
  if (scene) log(`  🎭 multi-user — ${roleCounts}, coordinating live`);
  log(`  📺 dashboard: ${dashboardUrl}\n`);

  server.broadcast({
    type: "run_config",
    task: opts.task,
    url: targetUrl,
    swarm: effectiveSwarm,
    mock: opts.mock,
    provider: opts.provider,
    scene: scene?.id,
  });

  // Resolve each agent's persona. Scene roles carry their persona; otherwise generate or
  // pick from the library.
  let personas;
  if (instances) {
    personas = instances.map((x) => x.persona);
  } else if (opts.generate && !opts.mock) {
    const brief = opts.generate.fromLogs
      ? briefFromLogs(opts.generate.fromLogs)
      : opts.generate.audience
        ? briefFromText(opts.generate.audience)
        : await briefFromUrl(targetUrl, opts.provider); // infer product outlook from the page
    log(`  🧬 synthesizing ${opts.generate.n} personas from ${brief.source === "logs" ? "log data" : "product outlook"}…`);
    const gen = await synthesizePersonas(brief, opts.generate.n, opts.provider);
    log(`  🧬 ${gen.map((p) => `${p.emoji} ${p.name}`).join(" · ")}\n`);
    personas = fillFromPool(gen, opts.swarm);
  } else {
    personas = pickPersonas(opts.swarm, opts.personaIds);
  }

  // The second axis. Race mode forces the race strategy on everyone; scenes use roles.
  const strategies = instances
    ? instances.map(() => undefined)
    : opts.race
      ? Array.from({ length: opts.swarm }, () => getStrategy("race"))
      : assignStrategies(opts.swarm, opts.strategyIds);
  if (opts.strategyIds?.length || opts.race) {
    const names = [...new Set(strategies.map((s) => s?.name).filter(Boolean))];
    log(`  🎯 strategies: ${names.join(" · ")}\n`);
  }
  // Everyone in a race run must reach the contended action before anyone fires.
  const barrier = opts.race ? new Barrier(opts.swarm) : undefined;

  // Freeze-tier scheduling (docs/SCALING.md): `concurrency` says how many agents are
  // RESIDENT (hold a browser context — memory-bound); this gate says how many may be
  // UNFROZEN at the same moment (rendering/acting — CPU-bound). Agents freeze their page
  // between actions, so a big resident swarm shares a small active set.
  const gate = new ActiveGate(activeCapacity());
  // Size the browser-shard pool to the launch demand: one browser process creates
  // contexts at ~1/sec, so shards are what let a big swarm reach full concurrency
  // quickly instead of trickling in.
  configureBrowserPool(effectiveConcurrency);

  // If the operator stops the run, wake any agent parked on an await so nothing hangs.
  if (rendezvous) hooks.signal?.addEventListener("abort", () => rendezvous.releaseAll());

  // Surface handoffs live: when one role signals, the other's screen may or may not agree.
  // Dedupe crowd signals (500 buyers all signalling "bought" would flood the feed).
  if (scene && rendezvous) {
    const seenHandoff = new Set<string>();
    rendezvous.onSignal = (e) => {
      if (seenHandoff.has(e.event)) return;
      seenHandoff.add(e.event);
      const p = personas.find((pp) => pp.name === e.from);
      log(`  🔗 ${e.from} → ${e.event}${e.note ? ` (${e.note})` : ""}`);
      server.broadcast({
        type: "handoff",
        from: e.from,
        fromEmoji: p?.emoji ?? "🔗",
        event: e.event,
        note: e.note,
        ts: Date.now(),
      });
    };
  }

  const findings: Finding[] = [];
  const started = Date.now();
  let agentsDone = 0;

  // The friction map: findings clustered and ranked by how many of the swarm hit each wall.
  // This is the payoff view — the thing single-user and load testing don't produce — so it
  // streams live, throttled, as reports come in and reorder.
  let lastClusterBroadcast = 0;
  const broadcastClusters = (force = false) => {
    const now = Date.now();
    if (!force && now - lastClusterBroadcast < 400) return;
    lastClusterBroadcast = now;
    server.broadcast({ type: "clusters", clusters: frictionMap(findings), total: effectiveSwarm, ts: now });
  };

  // Seed the ENTIRE swarm up front as queued agents. Only `concurrency` of them hold a
  // live browser at any moment, but all of them are genuinely part of this run — so the
  // shoal should be visible from the first second rather than trickling in. Costs one
  // small object each; the browsers are still spawned lazily by the pool.
  const agentIdOf = (i: number) => `${personas[i].id}-${i}`;
  server.broadcast({
    type: "agent_batch",
    ts: Date.now(),
    states: personas.map((persona, i) => ({
      agentId: agentIdOf(i),
      personaId: persona.id,
      personaName: persona.name,
      emoji: persona.emoji,
      status: "queued" as const,
      step: 0,
      lastThought: "",
      lastAction: "",
      strategyId: instances ? instances[i].role.id : strategies[i]?.id,
      strategyName: instances ? instances[i].role.label : strategies[i]?.name,
      modality: persona.modality ?? ("vision" as const),
    })),
  });

  /** Scene roles each load their own view (seller dashboard vs buyer storefront). */
  const urlFor = (i: number): string => {
    if (!instances) return targetUrl;
    const path = instances[i].role.path;
    return opts.mock ? `${dashboardUrl}${path}` : new URL(path, opts.url).toString();
  };

  // Live cost meter. On the subscription the marginal cost is $0 (flat fee), so we
  // report $0 but still track token volume and what it *would* cost on the metered API.
  const isSub = opts.provider === "subscription";
  const price = priceFor(opts.model, opts.price);
  let usage: TokenUsage = { ...ZERO_USAGE };
  let lastCostBroadcast = 0;
  const dollarsFor = (u: TokenUsage): number | null => (isSub ? 0 : price ? costUsd(u, price) : null);
  const trackUsage = (u: TokenUsage, force = false) => {
    usage = addUsage(usage, u);
    const now = Date.now();
    if (force || now - lastCostBroadcast > 500) {
      lastCostBroadcast = now;
      server.broadcast({ type: "cost", usage, costUsd: dollarsFor(usage), ts: now });
    }
  };

  // The featured set — which agents stream live video — ROTATES: when a featured agent
  // finishes, its slot passes to the next agent that launches. A static "first 12" would
  // leave every video slot showing a finished agent ~30s into a long run.
  const featuredSet = new Set<number>();

  const runOne = async (index: number): Promise<AgentState> => {
    const persona = personas[index];
    const agentId = `${persona.id}-${index}`;
    if (featuredSet.size < FEATURED) featuredSet.add(index);
    const cb: AgentCallbacks = {
      onState: (state) => {
        // In big swarms only a featured few stream screenshots — plus whichever agent the
        // operator has clicked on, so any fish can be inspected live without pushing 1000
        // JPEGs down the socket.
        const watched = server.focusedAgentId === agentId;
        if (bigSwarm && !featuredSet.has(index) && !watched) delete state.screenshot;
        server.broadcast({ type: "agent_state", state, ts: Date.now() });
      },
      onThought: (text) => {
        log(`  ${persona.emoji} ${persona.name}: ${text}`);
        server.broadcast({ type: "thought", agentId, personaName: persona.name, emoji: persona.emoji, text, ts: Date.now() });
      },
      onFinding: (f) => {
        const finding: Finding = { ...f, agentId, personaName: persona.name, ts: Date.now() };
        findings.push(finding);
        log(`  🚩 [${f.severity}] ${f.title} — ${persona.name}`);
        hooks.onFinding?.(finding);
        // The evidence screenshot stays server-side for the verify pass; don't ship it to every dashboard client.
        const { evidence, ...wire } = finding;
        server.broadcast({ type: "finding", finding: { ...wire, evidence: evidence ? { recent: evidence.recent } : undefined } });
        broadcastClusters();
      },
      onUsage: trackUsage,
    };
    const ctx: AgentContext = {
      strategy: strategies[index],
      modality: personas[index].modality ?? "vision",
      barrier,
      signal: hooks.signal,
      sceneRole: instances?.[index].role,
      rendezvous,
      rush: instances?.[index].role.rush === "market" ? (buyer: string) => server.market.rush(buyer) : undefined,
      gate,
      // Featured strip + whichever fish the operator clicked. Everyone else skips
      // rendering entirely — the broadcast path was already dropping their frames.
      wantFrame: () => !bigSwarm || featuredSet.has(index) || server.focusedAgentId === agentId,
      stagger: index < effectiveConcurrency,
    };
    // Crowd roles race as lightweight concurrent clients (no browser); everyone else drives
    // a real browser — mock-scripted in demos, vision-driven with an API key.
    const run = ctx.sceneRole?.browserless ? runGhostRacer : opts.mock ? runMockAgent : runLlmAgent;
    const result = await run(agentId, persona, { ...opts, url: urlFor(index) }, cb, ctx);
    featuredSet.delete(index); // hand the video slot to the next agent that launches
    agentsDone++;
    hooks.onProgress?.({ done: agentsDone, total: effectiveSwarm, costUsd: dollarsFor(usage) });
    return result;
  };

  const states = await pool(effectiveSwarm, effectiveConcurrency, runOne, hooks.signal);
  rendezvous?.releaseAll();
  await closeSharedBrowser();
  await closeSharedA11yBrowser();

  const stopped = hooks.signal?.aborted ?? false;
  if (stopped) log(`\n  ⏹  run stopped by operator`);

  // Ground-truth multi-user oracles. The server sees what both agents did, so a
  // disagreement between them is a FACT — the finding no single agent could file.
  if (scene && opts.mock) {
    const oracle = (title: string, description: string, note: string) => {
      const finding: Finding = {
        agentId: "shoal-oracle",
        personaName: "Shoal (cross-user oracle)",
        severity: "high",
        title,
        description,
        ts: Date.now(),
        verdict: { status: "confirmed", note },
      };
      findings.push(finding);
      hooks.onFinding?.(finding);
      log(`  🎭 [high] ${title} (cross-user oracle)`);
      server.broadcast({ type: "finding", finding });
    };

    if (scene.id === "marketplace" && server.market.sellerNeverNotified) {
      const sale = server.market.sales[0];
      oracle(
        "Sale completed but the seller was never notified",
        `The buyer purchased "${sale.title}" and got a confirmation, but the seller's dashboard shows no ` +
          `sale — the purchase and the seller-notification paths are disconnected. It only surfaces by ` +
          `comparing what both users experienced.`,
        "A sale exists server-side but the seller notification queue is empty.",
      );
    }
    if (scene.id === "flash-sale") {
      const over = server.market.oversold;
      const buyers = server.market.sales.length;
      if (over.length > 0) {
        const o = over[0];
        oracle(
          `Flash sale oversold: 1 unit, ${o.buyers.length} winners`,
          `${effectiveSwarm - 1} buyers rushed a single "${o.title}", and ${o.buyers.length} of them each ` +
            `received a successful order confirmation for the one unit in stock. The stock check and the ` +
            `decrement aren't atomic, so simultaneous buyers all pass the check.`,
          `${o.buyers.length} sales recorded for a listing with quantity 1.`,
        );
      } else {
        log(`  🎭 flash sale: ${buyers} winner of ${effectiveSwarm - 1} buyers — no oversell this run`);
      }
    }
    if (scene.id === "collab-doc" && server.doc.lostEdits.length > 0) {
      const lost = server.doc.lostEdits[0];
      oracle(
        "Concurrent edit silently lost (lost update)",
        `Two editors saved the shared doc at nearly the same time. ${lost.who}'s save ("${lost.text}") is ` +
          `absent from the final document — the later save overwrote it with no merge and no warning.`,
        `An editor's saved text is not present in the final document content.`,
      );
    }
    if (scene.id === "chat" && server.chat.undelivered.length > 0) {
      const m = server.chat.undelivered[0];
      oracle(
        "Sent message never delivered to the recipient",
        `${m.from} sent "${m.text}" to ${m.to} and their thread shows it delivered — but ${m.to}'s inbox is ` +
          `empty. The message was accepted on the sender's side but never written to the recipient's.`,
        `A message exists on the sender's thread but the recipient's thread is empty.`,
      );
    }
  }

  // Ground-truth race detection. The server knows how many claims actually succeeded, so
  // an oversell is a FACT, not an agent's opinion — the one finding that needs no verifier.
  if (opts.race && opts.mock && server.race.oversold) {
    const claims = server.race.claims;
    const finding: Finding = {
      agentId: "shoal-oracle",
      personaName: "Shoal (server-side oracle)",
      severity: "high",
      title: "Race condition: single-stock item oversold",
      description:
        `${claims.length} concurrent buyers each received a successful order confirmation for an item ` +
        `with stock of 1 (orders ${claims.map((c) => c.order).join(", ")}, all within ` +
        `${Math.max(...claims.map((c) => c.at)) - Math.min(...claims.map((c) => c.at))}ms). ` +
        `The stock check and the decrement are not atomic, so simultaneous requests both pass the check.`,
      ts: Date.now(),
      verdict: { status: "confirmed", note: "Observed server-side: claim count exceeds available stock." },
    };
    findings.push(finding);
    hooks.onFinding?.(finding);
    log(`  🏁 [high] Race condition: ${claims.length} buyers claimed 1 unit (server-verified)`);
    server.broadcast({ type: "finding", finding });
  }

  // Verify pass: one strong model reviews the swarm's findings against their evidence.
  // (Its own tokens are counted into the run cost — the editor isn't free either.)
  // Uses env Anthropic creds when present; otherwise the subscription token on a
  // sub-reachable model. Delegating verify to an MCP orchestrator is the future path.
  // Skipped on a stopped run — the operator wants out now, not after a model call.
  if (opts.verify && !opts.mock && !stopped && findings.length > 0) {
    const envAnthropic = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    let verifyAuth: { authToken?: string; model?: string } | null = null;
    if (envAnthropic) verifyAuth = {}; // default: env creds, claude-opus-5
    else if (isSub) {
      try {
        verifyAuth = { authToken: readSubscriptionCreds().token, model: "claude-haiku-4-5" };
      } catch {
        verifyAuth = null;
      }
    }
    if (verifyAuth) {
      log(`\n  🔎 verify pass: reviewing ${findings.length} findings…`);
      try {
        // Ground-truth findings (the race oracle) are already certain — don't re-litigate them.
        const toVerify = findings.filter((f) => !f.verdict);
        const verifyUsage = await verifyFindings(toVerify, opts.task, verifyAuth);
        if (verifyUsage) trackUsage(verifyUsage, true);
        const suspect = findings.filter((f) => f.verdict?.status === "suspect").length;
        log(`  🔎 ${findings.length - suspect} confirmed · ${suspect} flagged as possible agent artifacts`);
      } catch (err) {
        console.warn(`  🔎 verify pass failed (report will be unverified): ${(err as Error).message}`);
      }
    } else {
      console.warn("  🔎 skipping verify pass — no credentials available");
    }
  }

  const summary: RunSummary = {
    total: states.length,
    completed: states.filter((s) => s.status === "done").length,
    gaveUp: states.filter((s) => s.status === "gave_up").length,
    errored: states.filter((s) => s.status === "error").length,
    durationMs: Date.now() - started,
    usage,
    costUsd: opts.mock ? 0 : dollarsFor(usage),
  };

  // Evidence screenshots have served their purpose; drop them before report/broadcast.
  for (const f of findings) if (f.evidence) delete f.evidence.screenshot;

  broadcastClusters(true); // final map, including oracle findings and any post-verify changes
  server.broadcast({ type: "run_done", findings, summary });
  const reportPath = await writeReport(findings, summary, { ...opts, url: targetUrl });

  log(`\n  ── swarm finished in ${(summary.durationMs / 1000).toFixed(0)}s ──`);
  log(`  ✓ ${summary.completed} completed · ✗ ${summary.gaveUp} gave up · ⚠ ${summary.errored} errored`);
  const totalTok = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  if (opts.mock) {
    log(`  💰 cost: $0.00 (mock mode)`);
  } else if (isSub) {
    const apiEquiv = price ? ` · ~$${costUsd(usage, price).toFixed(2)} if it were the metered API` : "";
    log(`  💰 cost: $0.00 (Claude ${readSubTypeSafe()} subscription — flat fee) · ${(totalTok / 1000).toFixed(0)}k tokens${apiEquiv}`);
  } else if (summary.costUsd !== null) {
    log(`  💰 cost: $${summary.costUsd.toFixed(2)} (${((usage.input + usage.cacheRead + usage.cacheWrite) / 1000).toFixed(0)}k in / ${(usage.output / 1000).toFixed(0)}k out)`);
  } else {
    log(`  💰 tokens: ${(totalTok / 1000).toFixed(0)}k (no price known for ${opts.model} — set --price-in/--price-out)`);
  }
  log(`  🚩 ${findings.length} findings → ${reportPath}`);

  hooks.onDone?.({ findings, summary, reportPath });

  if (hooks.keepAlive === false && !hooks.server) {
    await server.stop();
  } else if (!hooks.server) {
    log(`  📺 dashboard stays live at ${dashboardUrl} — Ctrl+C to exit\n`);
  }
  return summary;
}
