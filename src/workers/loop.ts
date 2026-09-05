import type { WorkerHealth } from "../types.js";

export class WorkerLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastErrorCode: string | null = null;
  private consecutiveFailures = 0;
  private retryNotBeforeMs = 0;
  private drainResolvers: Array<() => void> = [];

  constructor(
    private readonly task: () => Promise<boolean>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.running) return;
    await new Promise<void>((resolve) => this.drainResolvers.push(resolve));
  }

  kick(): void {
    void this.tick();
  }

  health(): WorkerHealth {
    return {
      running: this.running,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode
    };
  }

  private async tick(): Promise<void> {
    if (this.running || Date.now() < this.retryNotBeforeMs) return;
    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    try {
      for (let count = 0; count < 25 && await this.task(); count += 1) {
        // Drain a bounded batch, then yield until the next tick.
      }
      this.lastCompletedAt = new Date().toISOString();
      this.lastErrorCode = null;
      this.consecutiveFailures = 0;
      this.retryNotBeforeMs = 0;
    } catch (error) {
      this.lastErrorAt = new Date().toISOString();
      this.lastErrorCode = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code.slice(0, 80)
        : "WORKER_LOOP_ERROR";
      this.consecutiveFailures += 1;
      const baseDelayMs = Math.max(250, this.intervalMs);
      this.retryNotBeforeMs = Date.now() + Math.min(30_000, baseDelayMs * 2 ** Math.min(this.consecutiveFailures - 1, 5));
      try {
        this.onError(error);
      } catch {
        // Error reporting must never turn a handled worker failure into an
        // unhandled rejection that can terminate the process.
      }
    } finally {
      this.running = false;
      for (const resolve of this.drainResolvers.splice(0)) resolve();
    }
  }
}
