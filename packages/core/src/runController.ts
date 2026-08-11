import { spawn } from "node:child_process";
import { platform } from "node:os";
import { runSwarm } from "./orchestrator.js";
import { ShoalServer } from "./server.js";
import { loadStrategies } from "./strategies.js";
import { safeConcurrency } from "./capacity.js";
import type { ControlCommand, RunOptions, RunPhase } from "./types.js";

export { safeConcurrency } from "./capacity.js";

/**
 * Pop the dashboard in a real browser window — preferring Chrome, in a NEW window, so it
 * never lands in an editor's embedded browser (clicking the URL in a Cursor/VS Code
 * terminal opens their built-in one) and the tank is watchable from second one.
 */
function openDashboard(url: string): void {
  const attempts: [string, string[]][] =
    platform() === "win32"
      ? [["cmd", ["/c", "start", "", "chrome", "--new-window", url]], ["cmd", ["/c", "start", "", url]]]
      : platform() === "darwin"
        ? [["open", ["-na", "Google Chrome", "--args", "--new-window", url]], ["open", [url]]]
        : [["google-chrome", ["--new-window", url]], ["xdg-open", [url]]];
  const tryNext = (i: number): void => {
    if (i >= attempts.length) return; // no browser found — the printed URL still works
    const child = spawn(attempts[i][0], attempts[i][1], { stdio: "ignore", detached: true });
    child.on("error", () => tryNext(i + 1));
    child.on("exit", (code) => {
      if (code !== 0) tryNext(i + 1);
    });
    child.unref();
  };
  tryNext(0);
}

/**
 * Owns the run lifecycle so the dashboard can drive it.
 *
 * The server outlives individual runs — that is the whole trick. Browsers stay connected,
 * the WebSocket never drops, and stop/restart just swaps the swarm underneath a live UI.
 */
export class RunController {
  private server = new ShoalServer();
  private abort?: AbortController;
  private current?: Promise<unknown>;
  private phase: RunPhase = "idle";
  private runNumber = 0;

  constructor(private opts: RunOptions) {}

  async start(): Promise<void> {
    await this.server.start(this.opts.port);
    this.server.onControl = (cmd) => this.handle(cmd);
    this.broadcastState();
    if (this.opts.open !== false) openDashboard(`http://localhost:${this.opts.port}`);
    await this.run();
  }

  private broadcastState(): void {
    this.server.broadcast({
      type: "run_state",
      phase: this.phase,
      swarm: this.opts.swarm,
      strategy: this.opts.strategyIds?.[0],
      task: this.opts.task,
      runNumber: this.runNumber,
      strategies: loadStrategies().map((s) => ({ id: s.id, name: s.name })),
    });
  }

  private async run(): Promise<void> {
    this.abort = new AbortController();
    this.runNumber++;
    this.phase = "running";
    this.broadcastState();

    // Each run gets a clean dashboard; otherwise the previous swarm's tiles linger.
    this.server.resetRunState();

    this.current = runSwarm(this.opts, {
      server: this.server,
      signal: this.abort.signal,
      keepAlive: true,
    })
      .catch((err: Error) => console.error(`  ✗ run failed: ${err.message}`))
      .finally(() => {
        this.phase = "finished";
        this.broadcastState();
      });

    await this.current;
  }

  private async handle(cmd: ControlCommand): Promise<void> {
    if (cmd.cmd === "stop") {
      if (this.phase !== "running") return;
      console.log("  ⏹  stop requested from dashboard");
      this.phase = "stopping";
      this.broadcastState();
      this.abort?.abort();
      return;
    }

    if (cmd.cmd === "restart") {
      console.log("  ↻  restart requested from dashboard");
      // Apply any config the operator changed in the UI before relaunching.
      if (cmd.swarm && Number.isFinite(cmd.swarm)) {
        this.opts.swarm = Math.max(1, Math.min(Math.round(cmd.swarm), 5000));
        // Concurrency must grow with the swarm (or a big restart trickles through at the
        // old width) — but every concurrent agent is a live browser context costing tens
        // of MB, so this is capped by RAM, not ambition. Raising it beyond the default is
        // an explicit --concurrency decision, not something the dashboard does silently.
        // An operator who passed --concurrency keeps it: recomputing here used to silently
        // drop a pinned 150 back to machine capacity on the first restart.
        this.opts.concurrency = Math.min(
          this.opts.swarm,
          this.opts.concurrencyPinned ? this.opts.concurrency : safeConcurrency(),
        );
      }
      if (cmd.task?.trim()) this.opts.task = cmd.task.trim();
      if (cmd.strategy) {
        this.opts.strategyIds = cmd.strategy === "default" ? undefined : [cmd.strategy];
        this.opts.race = cmd.strategy === "race" ? (this.opts.race ?? {}) : undefined;
      }

      if (this.phase === "running") {
        this.phase = "stopping";
        this.broadcastState();
        this.abort?.abort();
        await this.current?.catch(() => {}); // let the in-flight swarm unwind first
      }
      await this.run();
    }
  }
}
