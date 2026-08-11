/**
 * Multi-user coordination.
 *
 * The race Barrier synchronises N agents to the SAME instant. A Rendezvous does the other
 * half of multi-user testing: SEQUENCING. One agent does something, announces it, and a
 * second agent waits for that announcement before acting — "the seller listed an item,
 * now the buyer can buy it."
 *
 * A named signal also carries a note (a shared blackboard), so the waiter learns *what*
 * happened, not just *that* it happened. And every await has a timeout — because a signal
 * that never arrives is itself the finding ("I waited for the sale to show up; it never
 * did").
 */
export interface SignalResult {
  arrived: boolean;
  note?: string;
}

export class Rendezvous {
  private fired = new Map<string, string | undefined>();
  private waiters = new Map<string, Array<(r: SignalResult) => void>>();
  /** Everything announced so far — the report's record of who handed off what. */
  readonly log: { event: string; from: string; note?: string; ts: number }[] = [];
  /** Called whenever a signal fires, so the orchestrator can surface handoffs live. */
  onSignal?: (entry: { event: string; from: string; note?: string }) => void;

  /** Announce an event (idempotent per name); wakes anyone waiting on it. */
  signal(event: string, from: string, note?: string): void {
    this.fired.set(event, note);
    this.log.push({ event, from, note, ts: Date.now() });
    this.onSignal?.({ event, from, note });
    const pending = this.waiters.get(event) ?? [];
    this.waiters.delete(event);
    for (const resolve of pending) resolve({ arrived: true, note });
  }

  /** Wait for an event. Resolves immediately if already fired; times out otherwise. */
  await(event: string, timeoutMs = 40_000): Promise<SignalResult> {
    if (this.fired.has(event)) {
      return Promise.resolve({ arrived: true, note: this.fired.get(event) });
    }
    return new Promise<SignalResult>((resolve) => {
      const list = this.waiters.get(event) ?? [];
      let done = false;
      const settle = (r: SignalResult) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      list.push(settle);
      this.waiters.set(event, list);
      setTimeout(() => settle({ arrived: false }), timeoutMs);
    });
  }

  /** Release every waiter (used when a run is aborted so nothing hangs). */
  releaseAll(): void {
    for (const list of this.waiters.values()) {
      for (const resolve of list) resolve({ arrived: false });
    }
    this.waiters.clear();
  }
}
