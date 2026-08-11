/**
 * Race-mode synchronisation.
 *
 * Concurrency bugs need agents to collide, not merely to run in parallel — a swarm that
 * drifts apart by a few seconds never contends for anything. A Barrier holds every
 * participant until all of them have arrived (or the deadline passes), then releases them
 * together so their contended action lands inside the same few hundred milliseconds.
 */
export class Barrier {
  private waiting: Array<() => void> = [];
  private released = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly parties: number,
    /** Release anyway after this long, so one slow/dead agent can't hang the swarm. */
    private readonly timeoutMs = 45_000,
  ) {}

  /** Resolves when everyone has arrived (or the deadline fires). */
  arrive(): Promise<void> {
    if (this.released || this.parties <= 1) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length === 1) {
        this.timer = setTimeout(() => this.release(), this.timeoutMs);
      }
      if (this.waiting.length >= this.parties) this.release();
    });
  }

  /** How many are currently parked at the barrier. */
  get waitingCount(): number {
    return this.waiting.length;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearTimeout(this.timer);
    const all = this.waiting;
    this.waiting = [];
    // Release on the same tick so nobody gets a head start.
    for (const r of all) r();
  }
}
