/**
 * Detects system suspend/resume (sleep/wake) and large wall-clock jumps
 * (WP-20).
 *
 * Node has no portable power-event API. A timer that should fire every
 * `intervalMs` instead fires late after the machine slept: when the wall clock
 * advanced by much more than the interval, the process was suspended (or the
 * clock was changed). The service then re-checks its endpoints.
 */
export interface ResumeDetectorOptions {
  readonly intervalMs?: number;
  /** Gap beyond the interval that counts as a resume. */
  readonly thresholdMs?: number;
  readonly now?: () => number;
  readonly onResume: (gapMs: number) => void;
  /** Called on every check (periodic health work of the owner). */
  readonly onTick?: () => void;
}

export const RESUME_CHECK_INTERVAL_MS = 5_000;
export const RESUME_THRESHOLD_MS = 15_000;

export class ResumeDetector {
  private timer: NodeJS.Timeout | undefined;
  private last: number;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;

  constructor(private readonly options: ResumeDetectorOptions) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? RESUME_CHECK_INTERVAL_MS;
    this.thresholdMs = options.thresholdMs ?? RESUME_THRESHOLD_MS;
    this.last = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
  }

  /** One check (called by the timer; exposed for tests). */
  check(): void {
    const now = this.now();
    const gap = now - this.last - this.intervalMs;
    this.last = now;
    if (gap > this.thresholdMs) this.options.onResume(gap);
    else this.options.onTick?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
