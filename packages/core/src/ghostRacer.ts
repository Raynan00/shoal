import type { AgentState, Persona, RunOptions } from "./types.js";
import type { AgentCallbacks, AgentContext } from "./agent.js";

/**
 * A ghost racer is a crowd participant with no browser: it parks on a scene signal, then
 * fires ONE real HTTP request at the live server the instant the drop opens. A thousand of
 * them cost a thousand fetches, not a thousand Chromium processes — which is the only way a
 * laptop can put a genuinely-simultaneous crowd of ~1000 on the same endpoint.
 *
 * This is deliberate: proving a flash-sale oversell is a test of the SERVER's concurrency,
 * not of a thousand vision models. Each racer is a real shopper hitting checkout at the same
 * millisecond, and each success is a real order confirmation — so the oversell the oracle
 * reports is ground truth, not theatre. The racer still emits fish state, so the whole shoal
 * rushes the drop on screen and the winners sink to the gold seabed as conversions.
 */
export async function runGhostRacer(
  agentId: string,
  persona: Persona,
  opts: RunOptions,
  cb: AgentCallbacks,
  ctx: AgentContext = {},
): Promise<AgentState> {
  const role = ctx.sceneRole;
  const state: AgentState = {
    agentId,
    personaId: persona.id,
    personaName: persona.name,
    emoji: persona.emoji,
    status: "queued",
    step: 0,
    lastThought: "Waiting for the drop…",
    lastAction: "",
    strategyId: role?.id,
    strategyName: role?.label,
  };
  const push = () => cb.onState({ ...state });
  push();

  // Wait for the coordinator to open the sale. Every racer releases together.
  const openEvent = role?.script.find((s) => s.awaitEvent)?.awaitEvent;
  if (openEvent && ctx.rendezvous) {
    state.status = "thinking";
    state.lastAction = `waiting for "${openEvent}"…`;
    push();
    await ctx.rendezvous.await(openEvent);
  }
  if (ctx.signal?.aborted) {
    state.status = "stopped";
    state.lastThought = "(stopped by operator)";
    push();
    return state;
  }

  state.status = "browsing";
  state.step = 1;
  state.lastThought = "GO — grabbing the last one!";
  state.lastAction = "rushing checkout";
  push();

  try {
    const out = ctx.rush ? await ctx.rush(agentId) : { ok: false };
    if (out.ok) {
      state.status = "done"; // a conversion — sinks to the gold seabed
      state.lastThought = `Order confirmed! ${out.order} 🎉`;
      state.lastAction = "checkout succeeded";
    } else {
      state.status = "gave_up";
      state.lastThought = "Sold out — didn't get it.";
      state.lastAction = "checkout failed";
    }
  } catch (err) {
    state.status = "error";
    state.lastThought = `error: ${(err as Error).message}`;
  }
  push();
  return state;
}
