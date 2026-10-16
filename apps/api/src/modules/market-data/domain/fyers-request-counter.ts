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

export class FyersRequestCounter {
  private counts = new Map<string, number>();

  constructor(private readonly nowMs: () => number = Date.now, private windowStartedMs: number = nowMs()) {}

  record(endpoint: string, requests = 1): void {
    this.counts.set(endpoint, (this.counts.get(endpoint) ?? 0) + requests);
  }

  /** The counts since the last drain, then a fresh window. */
  drain(): FyersRequestCountWindow {
    const now = this.nowMs();
    const counts = Object.fromEntries([...this.counts.entries()].sort((a, b) => b[1] - a[1]));
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const window = { windowSeconds: Math.round((now - this.windowStartedMs) / 1000), total, counts };
    this.counts = new Map();
    this.windowStartedMs = now;
    return window;
  }
}

/** Writes one log line for the window, or nothing when no request was sent. */
export function reportFyersRequestCounts(
  counter: FyersRequestCounter,
  write: (line: string) => void,
  script: string,
): void {
  const window = counter.drain();
  if (window.total === 0) return;
  write(JSON.stringify({ level: "info", message: "Fyers REST request counts", script, ...window }));
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
