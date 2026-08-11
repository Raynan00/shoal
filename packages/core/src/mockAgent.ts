import { AgentBrowser } from "./browser.js";
import type { AgentState, Finding, Persona, RunOptions } from "./types.js";
import type { AgentCallbacks, AgentContext } from "./agent.js";

/**
 * Mock mode: scripted sessions against the bundled bait shop, driven through real
 * Playwright browsers. No API key, no token cost — used for the demo and for CI.
 */

interface MockStep {
  think?: string;
  click?: string; // selector
  type?: [string, string]; // selector, text
  pause?: number;
  finding?: Omit<Finding, "agentId" | "personaName" | "ts">;
  end?: { outcome: "completed" | "gave_up"; reason: string };
  /** Park here until every racer has arrived, then all fire together. */
  barrier?: true;
  /** Scene handoff: announce an event to the other agents. */
  signal?: { event: string; note?: string };
  /** Scene handoff: block until another agent announces this event. */
  awaitEvent?: string;
}

/**
 * Race flow: everyone lands on the last-unit page, waits at the barrier, then clicks
 * "Claim" in the same instant. The server's TOCTOU bug does the rest — and the oversell
 * is detected server-side as ground truth, not from these scripted opinions.
 */
const raceFlow: MockStep[] = [
  { think: "There's one Abyss Duffel left. I want it.", pause: 600 },
  { think: "Ready to claim — waiting for my moment…", barrier: true },
  { click: "#claimBtn", pause: 1400 },
  { think: "Did I get it? The page says my order is confirmed.", pause: 800 },
  { end: { outcome: "completed", reason: "Claimed the last unit — or so the confirmation says." } },
];

const buyFlow = (name: string, zip: string): MockStep[] => [
  { think: "Let me find something to buy. The anorak looks good.", pause: 900 },
  { click: 'button[data-name="Tidal Anorak"]', pause: 700 },
  { think: "Added. Now to the cart.", click: "#cartBtn", pause: 900 },
  { think: 'I\'ll hit "Continue to checkout".', click: "#continueBtn", pause: 1100 },
  { think: "…nothing happened? I definitely clicked it. Trying again.", click: "#continueBtn", pause: 1100 },
  {
    finding: {
      severity: "high",
      title: "Continue button silently ignores clicks",
      description: 'I clicked "Continue to checkout" twice and the page did not react at all — no error, no loading state. I almost left.',
    },
    think: "One more try before I give up…",
    click: "#continueBtn",
    pause: 900,
  },
  { think: "Finally! Filling in my details.", type: ["#f-name", name], pause: 500 },
  { type: ["#f-email", name.toLowerCase().replace(" ", ".") + "@sea.example"], pause: 500 },
  { type: ["#f-addr", "1 Reef Way"], pause: 500 },
  { type: ["#f-zip", zip], pause: 700 },
  {
    finding: {
      severity: "medium",
      title: "Hidden $19.50 shipping fee at checkout",
      description: "A $19.50 'priority reef shipping' charge appears only on the final step. It was never mentioned in the catalog or the cart.",
    },
    think: "Wait — where did this $19.50 shipping fee come from? That wasn't in the cart.",
    pause: 1200,
  },
  {
    finding: {
      severity: "high",
      title: "Place order button looks disabled",
      description: "The 'Place order' button is grey and looks disabled even when the form is complete. I only clicked it out of desperation — and it worked.",
    },
    think: "The 'Place order' button looks greyed out… is the form incomplete? Everything is filled in. I'll click it anyway.",
    click: "#placeOrderBtn",
    pause: 1000,
  },
  { end: { outcome: "completed", reason: "Order placed, but the checkout fought me the whole way." } },
];

const silentFailFlow: MockStep[] = [
  { think: "Okay, shopping. The duffel bag it is.", pause: 800 },
  { click: 'button[data-name="Abyss Duffel"]', pause: 700 },
  { click: "#cartBtn", think: "To the cart.", pause: 800 },
  { click: "#continueBtn", pause: 900 },
  { click: "#continueBtn", think: "Hm, the button must be slow. Again.", pause: 900 },
  { click: "#continueBtn", pause: 900 },
  { think: "Checkout. I'll fill in my name and address.", type: ["#f-name", "Kai Sturgeon"], pause: 500 },
  { type: ["#f-addr", "7 Kelp Court"], pause: 600 },
  { think: "That should be enough. Placing the order.", click: "#placeOrderBtn", pause: 1200 },
  { think: "Nothing happened. Did it work? Is it processing? There's no message anywhere.", click: "#placeOrderBtn", pause: 1200 },
  {
    finding: {
      severity: "high",
      title: "Form fails silently with no validation message",
      description: "I submitted the checkout form and nothing happened — no error, no highlight, no hint. I could not tell the postal code was required. I gave up.",
    },
    think: "I've clicked 'Place order' three times. The site just stares back at me. I'm done.",
    click: "#placeOrderBtn",
    pause: 1000,
  },
  { end: { outcome: "gave_up", reason: "The order button did nothing and never told me why." } },
];

const skepticFlow: MockStep[] = [
  { think: "Before I buy anything, let me see what this site is hiding.", pause: 1000 },
  { click: 'button[data-name="Dorsal Fin Cap"]', think: "Cheapest item, $28. Adding it as a probe.", pause: 800 },
  { click: "#cartBtn", pause: 900 },
  { think: "Cart says $28.00, subtotal only. No mention of shipping. Suspicious. Proceeding.", click: "#continueBtn", pause: 1000 },
  { click: "#continueBtn", pause: 900 },
  { click: "#continueBtn", pause: 900 },
  {
    finding: {
      severity: "medium",
      title: "Undisclosed shipping fee — 70% of item price",
      description: "A $28 item becomes $47.50 at the last step via a $19.50 shipping fee never disclosed in catalog or cart. Classic drip pricing.",
    },
    think: "There it is. $19.50 'priority reef shipping' on a $28 hat. Nearly 70% on top, revealed at the last moment.",
    pause: 1400,
  },
  { end: { outcome: "gave_up", reason: "Found the hidden fee I was looking for. Refusing to buy on principle." } },
];

const newbieFlow: MockStep[] = [
  { think: "I want the yellow hat. I'll press the button under it that says 'Add to cart'.", pause: 1200 },
  { click: 'button[data-name="Dorsal Fin Cap"]', pause: 900 },
  { think: "A little message said it was added. But… where did it go? I don't see it anywhere.", pause: 1500 },
  {
    finding: {
      severity: "low",
      title: "No clear path from 'added' toast to the cart",
      description: "After adding an item, the confirmation vanishes and nothing tells me where my item went or what to do next. I only found the cart by luck.",
    },
    think: "Maybe that 'Cart (1)' thing at the top? I'll try pressing it.",
    click: "#cartBtn",
    pause: 1200,
  },
  { think: "Oh good, there's my hat. Now this orange button says 'Continue to checkout'.", click: "#continueBtn", pause: 1300 },
  { think: "It didn't continue. Did I press it wrong? I'll press harder.", click: "#continueBtn", pause: 1300 },
  { think: "Still nothing. Maybe the website is broken. One more time.", click: "#continueBtn", pause: 1100 },
  {
    finding: {
      severity: "high",
      title: "Continue button needs multiple clicks with no feedback",
      description: "The checkout button did nothing the first two times. A less stubborn person would have left. Nothing told me to wait or try again.",
    },
    think: "It worked! Why did it take three tries?",
    pause: 1000,
  },
  { type: ["#f-name", "Nora Pike"], think: "Typing my name where it asks.", pause: 700 },
  { type: ["#f-email", "nora@pond.example"], pause: 600 },
  { type: ["#f-addr", "3 Lily Pad Lane"], pause: 600 },
  { type: ["#f-zip", "45330"], pause: 800 },
  { think: "The 'Place order' button is grey. Grey means I'm not allowed to press it, right? I'll wait.", pause: 2000 },
  { think: "Nothing is changing. Maybe I'll press it anyway even though it looks off.", click: "#placeOrderBtn", pause: 1100 },
  {
    finding: {
      severity: "high",
      title: "Enabled button styled as disabled",
      description: "The order button looked forbidden (grey, no hover change), so I waited for it to 'unlock'. It was actually clickable the whole time.",
    },
    end: { outcome: "completed", reason: "I got my hat, but I was sure the site was broken twice." },
  },
];

const SCRIPTS: Record<string, MockStep[]> = {
  "speedrun-sam": [
    { think: "Buy something, fast. Anorak. Go.", pause: 400 },
    { click: 'button[data-name="Tidal Anorak"]', pause: 300 },
    { click: "#cartBtn", pause: 400 },
    { click: "#continueBtn", pause: 500 },
    {
      finding: {
        severity: "high",
        title: "Checkout button dead on first click",
        description: "Clicked Continue, nothing happened, no spinner. In real life I'm already on a competitor's site.",
      },
      think: "Dead button. Unbelievable. I'm out.",
      pause: 600,
    },
    { end: { outcome: "gave_up", reason: "Button didn't respond instantly. Life is too short." } },
  ],
  "careful-carl": buyFlow("Carl Herring", "20500"),
  "keyboard-kai": silentFailFlow,
  "skeptic-saul": skepticFlow,
  "newbie-nora": newbieFlow,
  "literal-lena": buyFlow("Lena Bass", "10001"),
  "distracted-dee": silentFailFlow,
  "chaos-cathy": buyFlow("Cathy Roe", "60614"),
};

export async function runMockAgent(
  agentId: string,
  persona: Persona,
  opts: RunOptions,
  cb: AgentCallbacks,
  ctx: AgentContext = {},
): Promise<AgentState> {
  const browser = new AgentBrowser();
  const state: AgentState = {
    agentId,
    personaId: persona.id,
    personaName: persona.name,
    emoji: persona.emoji,
    status: "starting",
    step: 0,
    lastThought: "",
    lastAction: "",
  };
  state.strategyId = ctx.strategy?.id;
  state.strategyName = ctx.strategy?.name;
  if (ctx.sceneRole) {
    state.strategyId = ctx.sceneRole.id;
    state.strategyName = ctx.sceneRole.label;
  }
  const push = () => cb.onState({ ...state });

  // Scene role has its own scripted flow with signal/await handoffs; race has its barrier
  // flow; otherwise the persona's normal buy attempt.
  const script: MockStep[] = ctx.sceneRole
    ? (ctx.sceneRole.script as MockStep[])
    : ctx.barrier
      ? raceFlow
      : SCRIPTS[persona.id] ?? buyFlow("Alex Minnow", "94110");

  // Browser work runs inside the active gate: unfreeze → act → frame → freeze. Waits
  // (thinks, pauses, barriers, rendezvous) happen frozen and hold no slot — that's the
  // tier scheme that lets hundreds of resident agents share a CPU-bound active set.
  const gated = async (fn: () => Promise<void>) => {
    const work = async () => {
      await browser.unfreeze();
      try {
        await fn();
      } finally {
        await browser.freeze();
      }
    };
    if (ctx.gate) await ctx.gate.use(work);
    else await work();
  };

  try {
    // Claimed by a worker: show "starting" immediately so the dashboard's swimming count
    // reflects agents in the pipeline, not just those already past browser launch.
    push();
    // Stagger launches so the wall comes alive progressively (but not in a race or scene —
    // there the agents must be ready to coordinate — and only for the first wave: later
    // waves are already naturally staggered by when slots free up).
    if (!ctx.barrier && !ctx.sceneRole && (ctx.stagger ?? true))
      await new Promise((r) => setTimeout(r, Math.random() * 2500));
    const doLaunch = async () => {
      // Stop pressed while waiting for a launch slot — don't pay 1-3s of renderer spawn
      // just to find out. This is what makes ⏹ feel instant on a big swarm.
      if (ctx.signal?.aborted) return;
      await browser.launch(opts.url, opts.headless);
      if (ctx.wantFrame?.() ?? true) state.screenshot = await browser.screenshot();
      await browser.freeze();
    };
    if (ctx.gate) await ctx.gate.use(doLaunch);
    else await doLaunch();
    if (ctx.signal?.aborted) {
      state.status = "stopped";
      state.lastThought = "(stopped by operator)";
      push();
      return state;
    }
    state.status = "browsing";
    push();

    for (const step of script) {
      if (ctx.signal?.aborted) {
        state.status = "stopped";
        state.lastThought = "(stopped by operator)";
        push();
        return state;
      }
      state.step++;
      if (step.think) {
        state.lastThought = step.think;
        state.status = "thinking";
        cb.onThought(step.think);
        push();
        await new Promise((r) => setTimeout(r, 500));
      }
      if (step.barrier && ctx.barrier) {
        state.status = "thinking";
        state.lastAction = "waiting for the other buyers…";
        push();
        await ctx.barrier.arrive();
      }
      if (step.awaitEvent && ctx.rendezvous) {
        state.status = "thinking";
        state.lastAction = `waiting for "${step.awaitEvent}"…`;
        push();
        await ctx.rendezvous.await(step.awaitEvent);
      }
      if (step.signal && ctx.rendezvous) {
        ctx.rendezvous.signal(step.signal.event, persona.name, step.signal.note);
      }
      if (step.finding) {
        state.status = "confused";
        push();
        cb.onFinding(step.finding);
      }
      // If nobody's watching this fish and the step has no page action, there's nothing
      // to unfreeze for — the whole render/encode cycle is skipped, not just the upload.
      const wantFrame = ctx.wantFrame?.() ?? true;
      if (step.click || step.type || wantFrame) {
        await gated(async () => {
          if (step.click) {
            state.status = "browsing";
            state.lastAction = `click ${step.click}`;
            await browser.page.click(step.click, { timeout: 5000 }).catch(() => {});
          }
          if (step.type) {
            state.status = "browsing";
            state.lastAction = `type into ${step.type[0]}`;
            await browser.page.fill(step.type[0], step.type[1]).catch(() => {});
          }
          if (wantFrame) state.screenshot = await browser.screenshot();
        });
      }
      push();
      await new Promise((r) => setTimeout(r, step.pause ?? 600));
      if (step.end) {
        state.status = step.end.outcome === "completed" ? "done" : "gave_up";
        state.lastThought = step.end.reason;
        cb.onThought(step.end.reason);
        push();
        break;
      }
    }
    if (state.status !== "done" && state.status !== "gave_up") {
      state.status = "done";
      push();
    }
  } catch (err) {
    state.status = "error";
    state.lastThought = `error: ${(err as Error).message}`;
    push();
  } finally {
    // Keep the final frame on screen briefly — but only if anyone is watching this
    // agent's screen, and never while the operator is trying to stop the run. For
    // unwatched fish in a big swarm this was 1.5s of dead time per agent.
    if (!ctx.signal?.aborted && (ctx.wantFrame?.() ?? true)) await new Promise((r) => setTimeout(r, 1500));
    await browser.close();
  }
  return state;
}
