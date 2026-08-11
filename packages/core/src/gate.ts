/**
 * The active gate: a FIFO semaphore bounding how many agents may be UNFROZEN — rendering,
 * clicking, screenshotting — at the same moment. Everything outside the gate is frozen
 * (zero CPU) or waiting its turn.
 *
 * This is what decouples "agents resident" (memory-bound, ~250) from "agents rendering"
 * (CPU-bound, ~2× cores) — the tier scheme from docs/SCALING.md. An agent holds a slot
 * only for the milliseconds it takes to act and capture a frame, then freezes and yields.
 */
export class ActiveGate {
  private inUse = 0;
  private queue: (() => void)[] = [];

  constructor(readonly size: number) {}

  private async acquire(): Promise<void> {
    if (this.inUse < this.size) {
      this.inUse++;
      return;
    }
    // Slot is handed over directly in release(), so inUse stays correct.
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.inUse--;
  }

  /** Run `fn` while holding an active slot. Never hold a slot across a long wait. */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
