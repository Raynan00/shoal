import { cpus, freemem, platform, totalmem } from "node:os";

/**
 * Two capacities, not one — the freeze-tier insight (see docs/SCALING.md).
 *
 * A vision agent spends ~90% of its life waiting: on the model, on a scene signal, on a
 * scripted pause. During those waits its page is FROZEN (CDP web lifecycle state) — full
 * state kept in RAM, ~zero CPU. So the two real limits are different resources:
 *
 *  - RESIDENT: how many agents can hold a live browser context at once. Memory-bound —
 *    a frozen page keeps its renderer memory (~110MB budgeted).
 *  - ACTIVE: how many of those may be unfrozen — rendering, acting, screenshotting — at
 *    the same moment. CPU-bound. The ActiveGate enforces this.
 *
 * Published context (docs/SCALING.md): browser farms report ~10 sessions/GB and ~2
 * browsers/core; the tier scheme is how the RL-training world (WebGym, OASIS) runs
 * thousands of envs on machines that could never render them all simultaneously.
 */

const MB_PER_AGENT = 110;
/** Hard ceiling on resident browsers; beyond this even idle-page overheads add up. */
const RESIDENT_MAX = 250;
/** Hard ceiling on simultaneously-unfrozen pages. */
const ACTIVE_MAX = 64;

/**
 * How many agents may hold a browser context at once. Memory-bound: the smaller of ~35%
 * of total RAM (stable ceiling) and ~55% of currently-free RAM (adapts to a busy machine).
 * Getting this wrong doesn't degrade gracefully — it swaps and the machine locks up
 * (it once froze a 16GB laptop mid-demo).
 */
export function residentCapacity(): number {
  const mb = 1024 ** 2;
  const byTotal = (totalmem() / mb) * 0.35;
  // macOS keeps "free" memory deliberately tiny (reclaimable file cache holds the rest),
  // so os.freemem() there would strangle capacity to nothing on an idle 32GB machine.
  // Trust the total-RAM budget on darwin; use the adaptive free-RAM term elsewhere.
  const byFree = platform() === "darwin" ? Infinity : (freemem() / mb) * 0.55;
  const byMemory = Math.floor(Math.min(byTotal, byFree) / MB_PER_AGENT);
  return Math.max(4, Math.min(byMemory, RESIDENT_MAX));
}

/** How many pages may be unfrozen (rendering + acting) at the same moment. CPU-bound. */
export function activeCapacity(): number {
  return Math.max(4, Math.min(cpus().length * 2, ACTIVE_MAX));
}

/**
 * Back-compat: the single number older call sites want — how many agents to run
 * concurrently. With the freeze tier this is the RESIDENT capacity; the ActiveGate
 * separately keeps the unfrozen set within activeCapacity().
 */
export function safeConcurrency(): number {
  return residentCapacity();
}
