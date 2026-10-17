/**
 * Counts the Fyers REST requests each process sends, by endpoint, and logs the totals.
 *
 * On 2026-10-16 the 5,000-a-day quota ran out at 11:04 IST and nothing could say who had spent it: only the total was
 * known, so the split had to be estimated from job run counts. Every request now goes through `recordFyersRequest`,
 * and each process logs one line every five minutes and again on exit (the short-lived CLI jobs the scheduler spawns
 * would otherwise take their counts with them). The line carries the script name, so the scheduler's log shows which
 * job and which endpoint a request belongs to.
 *
 * Endpoints are named by what they are, not by class: `quotes:api`, `quotes:collector`, `quotes:premium`, `history`,
 * `optionchain`.
 */
export interface FyersRequestCountWindow {
  windowSeconds: number;
  total: number;
  counts: Record<string, number>;
}

export type FyersRequestPersister = (counts: Record<string, number>, dateKey: string) => Promise<void> | void;

export class FyersRequestCounter {
  private counts = new Map<string, number>();
  private dailyTotal = 0;
  private currentDayKey: string;

  constructor(private readonly nowMs: () => number = Date.now, private windowStartedMs: number = nowMs()) {
    this.currentDayKey = this.dayKeyFor(this.windowStartedMs);
  }

  private dayKeyFor(ms: number): string {
    const ist = new Date(ms + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(0, 10);
  }

  private checkDayRollover(): void {
    const today = this.dayKeyFor(this.nowMs());
    if (today !== this.currentDayKey) {
      this.currentDayKey = today;
      this.dailyTotal = 0;
    }
  }

  record(endpoint: string, requests = 1): void {
    this.checkDayRollover();
    this.counts.set(endpoint, (this.counts.get(endpoint) ?? 0) + requests);
    this.dailyTotal += requests;
  }

  getDailyTotal(): number {
    this.checkDayRollover();
    return this.dailyTotal;
  }

  getCurrentDayKey(): string {
    this.checkDayRollover();
    return this.currentDayKey;
  }

  /** The counts since the last drain, then a fresh window. */
  drain(): FyersRequestCountWindow {
    this.checkDayRollover();
    const now = this.nowMs();
    const counts = Object.fromEntries([...this.counts.entries()].sort((a, b) => b[1] - a[1]));
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const window = { windowSeconds: Math.round((now - this.windowStartedMs) / 1000), total, counts };
    this.counts = new Map();
    this.windowStartedMs = now;
    return window;
  }
}

let activePersister: FyersRequestPersister | null = null;

export function setFyersRequestPersister(persister: FyersRequestPersister | null): void {
  activePersister = persister;
}

/** Writes one log line for the window, or nothing when no request was sent. */
export function reportFyersRequestCounts(
  counter: FyersRequestCounter,
  write: (line: string) => void,
  script: string,
): void {
  const dayKey = counter.getCurrentDayKey();
  const window = counter.drain();
  if (window.total === 0) return;
  write(JSON.stringify({ level: "info", message: "Fyers REST request counts", script, ...window }));
  if (activePersister) {
    try {
      void activePersister(window.counts, dayKey);
    } catch {
      // Ignored: logging/metrics persistence must not throw
    }
  }
}

export const fyersRequestCounter = new FyersRequestCounter();

let reporting = false;

/** Counts one request and, on the first, starts this process's periodic and on-exit reporting. */
export function recordFyersRequest(endpoint: string): void {
  fyersRequestCounter.record(endpoint);
  if (reporting) return;
  reporting = true;
  const script = (process.argv[1] ?? "unknown").split(/[\\/]/).pop() ?? "unknown";
  const report = () => reportFyersRequestCounts(fyersRequestCounter, (line) => console.info(line), script);
  // Unreffed: the counter must not keep a finished CLI job alive.
  setInterval(report, 5 * 60_000).unref();
  process.on("exit", report);
}

