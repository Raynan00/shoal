import { AgentBrowser, type ComputerAction } from "./browser.js";
import { A11yBrowser, type A11yAction } from "./a11yBrowser.js";
import { AnthropicDriver } from "./anthropicDriver.js";
import { OpenAIDriver } from "./openaiDriver.js";
import { A11Y_TOOL_NAME, type AgentDriver, type Observation } from "./driver.js";
import type { Barrier } from "./barrier.js";
import type { ActiveGate } from "./gate.js";
import type { Rendezvous } from "./rendezvous.js";
import type { SceneRole } from "./scenes.js";
import type { AgentState, Finding, Persona, RunOptions, Strategy, TokenUsage } from "./types.js";

export interface AgentCallbacks {
  onState: (state: AgentState) => void;
  onThought: (text: string) => void;
  onFinding: (finding: Omit<Finding, "agentId" | "personaName" | "ts">) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface AgentContext {
  strategy?: Strategy;
  /** Screen-reader personas perceive the a11y tree instead of screenshots. */
  modality?: "vision" | "a11y";
  /** Race mode: all agents park here, then fire the contended action together. */
  barrier?: Barrier;
  /** Aborted when an operator hits stop/restart in the dashboard. */
  signal?: AbortSignal;
  /** Multi-user scene: the role this agent plays, and how it coordinates with others. */
  sceneRole?: SceneRole;
  rendezvous?: Rendezvous;
  /**
   * Browserless crowd action: fire the contended checkout directly against the server's
   * real logic. In-process so a whole 1000-strong crowd can hit the same non-atomic
   * check-then-write at once without 1000 sockets — the oversell is in the logic, not the wire.
   */
  rush?: (buyer: string) => Promise<{ ok: boolean; order?: string }>;
  /**
   * Bounds how many agents are unfrozen (rendering/acting) at once. Agents freeze their
   * page while waiting on the model or a scene signal, so resident count is memory-bound
   * while this gate keeps the rendering set within CPU capacity (docs/SCALING.md).
   */
  gate?: ActiveGate;
  /**
   * Whether anyone is watching this agent's screen right now (featured strip or the
   * operator's drill-down). In big mock swarms most frames are dropped before broadcast —
   * so agents nobody watches skip the unfreeze→render→encode cycle entirely. LLM agents
   * ignore this: their screenshots are perception, not decoration.
   */
  wantFrame?: () => boolean;
  /** First-wave agents stagger their entry so the tank fills progressively; later waves don't. */
  stagger?: boolean;
}

function systemPrompt(persona: Persona, task: string, ctx: AgentContext): string {
  const strategy = ctx.strategy;
  const role = ctx.sceneRole;
  const effectiveTask = role?.task || strategy?.goal?.trim() || task;
  const a11y = ctx.modality === "a11y";

  return `You are a simulated user testing a website inside a real browser, and you stay fully in character.

# Your persona: ${persona.name}
${persona.profile}

# Your task
${effectiveTask}
${
  strategy && strategy.id !== "complete-task"
    ? `\n# Your approach: ${strategy.name}\n${strategy.directive}`
    : ""
}
${
  ctx.barrier
    ? `\n# Timing\nOther users are going for the SAME limited thing at the SAME moment. Get to the contended action promptly; you will be held there and released together with them.`
    : ""
}${
  role
    ? `\n# You are the ${role.label}\nAnother real user is using this same product at the same time, in a different role. Coordinate with them using two tools:\n- signal(event, note): tell the other user something happened (e.g. event "listed", note "Blue Kayak $50").\n- await_signal(event): pause until the other user signals that event before you continue.\nThe most valuable finding here is a DISAGREEMENT between the two of you — where one side thinks something happened and the other side's screen doesn't reflect it. Watch for that and report it.`
    : ""
}

# How to behave
- Act ONLY as your persona would: their knowledge level, their patience, their reading habits. Do not use knowledge or diligence your persona would not have.
- Before each action, narrate one short first-person sentence of what you are thinking or expecting. This narration is the product; never skip it.
- You have a patience budget of roughly ${persona.patience_steps} actions. When it runs out, your persona would leave — call task_result with outcome "gave_up".
- The moment something confuses you, silently fails, or contradicts its own labels, call report_finding. A session with zero findings on a flawed site is a failed session.
- When the task is done or you quit, call task_result. Do not continue after that.
${
  a11y
    ? `- You are BLIND to the visual page. You perceive it only through your screen reader: read_screen surveys the accessibility tree, next_element / previous_element move focus, activate presses the focused control. There are no coordinates and no clicking.
- Report every control with no accessible name, every focus that is invisible or lost, every element you cannot reach by keyboard, and every place the reading order makes no sense. Those are the defects only you can find.`
    : `- Screenshots are your only eyes. If a click seems to do nothing, take a screenshot to check before assuming.`
}`;
}

export async function runLlmAgent(
  agentId: string,
  persona: Persona,
  opts: RunOptions,
  cb: AgentCallbacks,
  ctx: AgentContext = {},
): Promise<AgentState> {
  const modality = ctx.modality ?? "vision";
  // subscription + anthropic both use the Anthropic driver (auth differs internally).
  const withScene = Boolean(ctx.sceneRole && ctx.rendezvous);
  const driver: AgentDriver =
    opts.provider === "openai"
      ? new OpenAIDriver(opts, modality, withScene)
      : new AnthropicDriver(opts, modality, withScene);

  const visionBrowser = modality === "vision" ? new AgentBrowser() : null;
  const a11yBrowser = modality === "a11y" ? new A11yBrowser() : null;

  const state: AgentState = {
    agentId,
    personaId: persona.id,
    personaName: persona.name,
    emoji: persona.emoji,
    status: "starting",
    step: 0,
    lastThought: "",
    lastAction: "",
    strategyId: ctx.strategy?.id,
    strategyName: ctx.strategy?.name,
    modality,
  };
  const push = () => cb.onState({ ...state });
  const recent: string[] = []; // rolling trail, attached to findings as evidence
  const remember = (entry: string) => {
    recent.push(entry);
    if (recent.length > 6) recent.shift();
  };

  /** Current perception, in whichever modality this agent has. */
  const observe = async (): Promise<Observation> => {
    if (a11yBrowser) return { text: await a11yBrowser.describeFocused() };
    const shot = await visionBrowser!.screenshot();
    state.screenshot = shot;
    return { image: shot };
  };

  // Vision agents freeze their page whenever they're not acting — which is most of the
  // time, since every step waits on a model round-trip. The gate bounds how many pages
  // are unfrozen (rendering) at once; see docs/SCALING.md. A11y agents don't render, so
  // they only borrow the gate for the action itself.
  const gated = async <T>(fn: () => Promise<T>): Promise<T> => {
    const work = async () => {
      await visionBrowser?.unfreeze();
      try {
        return await fn();
      } finally {
        await visionBrowser?.freeze();
      }
    };
    return ctx.gate ? ctx.gate.use(work) : work();
  };

  try {
    if (ctx.signal?.aborted) {
      state.status = "stopped";
      state.lastThought = "(stopped by operator)";
      push();
      return state;
    }
    const first = await gated(async () => {
      if (a11yBrowser) {
        await a11yBrowser.launch(opts.url, opts.headless);
        return { text: `Accessibility tree:\n${await a11yBrowser.snapshot()}` } as Observation;
      }
      await visionBrowser!.launch(opts.url, opts.headless);
      return observe();
    });
    state.status = "browsing";
    push();

    driver.init(systemPrompt(persona, opts.task, ctx), first);

    const maxSteps = Math.min(opts.maxSteps, persona.patience_steps + 6);
    let finished = false;
    let barrierPassed = false;

    for (let step = 0; step < maxSteps && !finished; step++) {
      // Operator pressed stop/restart — leave promptly, between model calls.
      if (ctx.signal?.aborted) {
        state.status = "stopped";
        state.lastThought = "(stopped by operator)";
        push();
        return state;
      }
      state.step = step + 1;
      state.status = "thinking";
      push();

      const turn = await driver.next();
      if (turn.usage) cb.onUsage?.(turn.usage);

      if (turn.refusal) {
        state.status = "error";
        state.lastThought = "(request declined by safety classifiers)";
        push();
        break;
      }

      for (const thought of turn.thoughts) {
        state.lastThought = thought;
        remember(`thought: ${thought}`);
        cb.onThought(thought);
        push();
      }

      for (const call of turn.toolCalls) {
        if (call.name === "computer" || call.name === A11Y_TOOL_NAME) {
          // Race mode: hold everyone at the last step before the contended action, then
          // release together so the collision is real rather than incidental.
          if (ctx.barrier && !barrierPassed && step >= 1) {
            barrierPassed = true;
            state.status = "thinking";
            state.lastAction = "waiting for the other users…";
            push();
            await ctx.barrier.arrive();
          }

          state.status = "browsing";
          let desc = "";
          const obs = await gated(async () => {
            try {
              if (a11yBrowser) {
                const input = call.input as unknown as A11yAction;
                state.lastAction = input.action;
                push();
                desc = await a11yBrowser.execute(input);
                await a11yBrowser.page.waitForTimeout(250);
              } else {
                const input = call.input as unknown as ComputerAction;
                state.lastAction = input.action;
                push();
                desc = await visionBrowser!.execute(input);
                await visionBrowser!.page.waitForTimeout(400); // let the UI settle
              }
            } catch (err) {
              desc = `action failed: ${(err as Error).message}`;
            }
            return observe();
          });
          state.lastAction = desc.slice(0, 120);
          remember(`action: ${desc.slice(0, 200)}`);
          push();
          // For a11y the description IS the perception; don't duplicate it.
          driver.addToolResult(call.id, desc, a11yBrowser ? undefined : obs);
        } else if (call.name === "signal" && ctx.rendezvous) {
          const s = call.input as { event: string; note?: string };
          ctx.rendezvous.signal(s.event, persona.name, s.note);
          state.lastAction = `signalled "${s.event}"`;
          push();
          driver.addToolResult(call.id, `Signalled "${s.event}" to the other user.`);
        } else if (call.name === "await_signal" && ctx.rendezvous) {
          const s = call.input as { event: string };
          state.status = "thinking";
          state.lastAction = `waiting for "${s.event}"…`;
          push();
          const r = await ctx.rendezvous.await(s.event);
          driver.addToolResult(
            call.id,
            r.arrived
              ? `The other user signalled "${s.event}"${r.note ? `: ${r.note}` : ""}. Continue.`
              : `Timed out waiting for "${s.event}" — the other user never signalled it. This may itself be a finding.`,
          );
        } else if (call.name === "report_finding") {
          const f = call.input as { severity: Finding["severity"]; title: string; description: string };
          state.status = "confused";
          push();
          cb.onFinding({ ...f, evidence: { recent: [...recent], screenshot: state.screenshot } });
          driver.addToolResult(call.id, "Finding recorded. Continue.");
        } else if (call.name === "task_result") {
          const r = call.input as { outcome: "completed" | "gave_up"; reason: string };
          state.status = r.outcome === "completed" ? "done" : "gave_up";
          state.lastThought = r.reason;
          cb.onThought(r.reason);
          push();
          driver.addToolResult(call.id, "Session ended.");
          finished = true;
        } else {
          driver.addToolResult(call.id, `Unknown tool: ${call.name}`);
        }
      }

      if (turn.endTurn && turn.toolCalls.length === 0) {
        state.status = "done";
        push();
        break;
      }
    }

    // (an aborted run returns from inside the loop, so it can't reach here)
    if (state.status !== "done" && state.status !== "gave_up" && state.status !== "error") {
      state.status = "gave_up";
      state.lastThought = "(ran out of patience — session ended)";
      cb.onThought(state.lastThought);
      push();
    }
  } catch (err) {
    state.status = "error";
    state.lastThought = `error: ${(err as Error).message}`;
    push();
  } finally {
    await visionBrowser?.close();
    await a11yBrowser?.close();
  }
  return state;
}
