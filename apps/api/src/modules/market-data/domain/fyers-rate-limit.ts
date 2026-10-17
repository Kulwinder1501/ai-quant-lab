/**
 * Fyers' three REST limits and what to do when one is hit.
 *
 * On 2026-10-16 the Standard plan's 5,000 requests a day ran out at 11:04 IST, about 45 requests a minute since the open
 * and right at the 50-a-minute ceiling. The failure then fed itself: both quote clients retried every 429 (up to four
 * requests for one refused call, the daily cap included), the two collectors died on the error and were restarted
 * 86 and 110 times, and every restart asked again. The option chain, live prices and the market-watch stream all
 * degraded for the rest of the session.
 *
 * Each limit needs a different answer, so the response is classified from its text:
 *
 * - **DAILY**: nothing will succeed until the quota resets. Retrying only spends requests, so do not.
 * - **PER_MINUTE**: waiting about a minute clears it. A retry in half a second does not.
 * - **PER_SECOND**: a retry after just over a second clears it.
 * - **UNKNOWN**: a 429 that says nothing about which limit. Treated as it always was, retried.
 */
export type FyersRateLimitKind = "DAILY" | "PER_MINUTE" | "PER_SECOND" | "UNKNOWN";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The limit a Fyers response hit, or null when it was not a rate limit. */
export function classifyFyersRateLimit(input: {
  status?: number | null;
  code?: number | null;
  message?: string | null;
}): FyersRateLimitKind | null {
  const text = input.message ?? "";
  const named = /requests\s*(?:\/|per)\s*(day|minute|second)/i.exec(text);
  const limited = input.status === 429 || input.code === 429 || (input.code === -360 && named !== null);
  if (!limited) return null;
  if (named === null) return "UNKNOWN";
  const unit = named[1]!.toLowerCase();
  return unit === "day" ? "DAILY" : unit === "minute" ? "PER_MINUTE" : "PER_SECOND";
}

/** The same classification for an error message that already carries the provider's text. */
export function classifyFyersRateLimitFromText(text: string): FyersRateLimitKind | null {
  return classifyFyersRateLimit({ status: /HTTP 429/i.test(text) ? 429 : null, message: text });
}

function msUntilNextIstMidnight(nowMs: number): number {
  const istMs = nowMs + IST_OFFSET_MS;
  return DAY_MS - (((istMs % DAY_MS) + DAY_MS) % DAY_MS);
}

/**
 * How long to stay quiet after a limit.
 *
 * The daily cooldown is a re-probe interval, not a wait until midnight: it is capped at fifteen minutes so a plan
 * upgrade or an early reset is noticed, and never longer than the time to the next IST midnight plus a minute.
 */
export function rateLimitCooldownMs(kind: FyersRateLimitKind, nowMs: number): number {
  switch (kind) {
    case "PER_SECOND": return 1_100;
    case "PER_MINUTE": return 65_000;
    case "UNKNOWN": return 30_000;
    case "DAILY": return Math.min(15 * 60_000, msUntilNextIstMidnight(nowMs) + 60_000);
  }
}

/** Thrown, without a request being sent, while a limit's cooldown is running, and when a call hits one. */
export class FyersRateLimitedError extends Error {
  constructor(message: string, readonly kind: FyersRateLimitKind, readonly retryAtMs: number) {
    super(message);
    this.name = "FyersRateLimitedError";
  }
}

export function isFyersRateLimitedError(error: unknown): error is FyersRateLimitedError {
  return error instanceof FyersRateLimitedError;
}

/**
 * A process-local cooldown. After a limit is hit, every caller sharing the gate fails fast for the cooldown instead of
 * each spending a request to learn what one already found out.
 */
export class FyersRateLimitGate {
  private blockedUntilMs = 0;
  private blockedKind: FyersRateLimitKind = "UNKNOWN";

  constructor(private readonly nowMs: () => number = Date.now) {}

  open(kind: FyersRateLimitKind): void {
    const until = this.nowMs() + rateLimitCooldownMs(kind, this.nowMs());
    // Keep the longer of two cooldowns: a per-second hit must not shorten a daily one.
    if (until > this.blockedUntilMs) {
      this.blockedUntilMs = until;
      this.blockedKind = kind;
    }
  }

  remainingMs(): number {
    return Math.max(0, this.blockedUntilMs - this.nowMs());
  }

  state(): { blocked: false } | { blocked: true; kind: FyersRateLimitKind; retryAtMs: number } {
    return this.remainingMs() > 0
      ? { blocked: true, kind: this.blockedKind, retryAtMs: this.blockedUntilMs }
      : { blocked: false };
  }

  /** Throws if a cooldown is running; sends nothing. */
  assertOpen(): void {
    const state = this.state();
    if (state.blocked) {
      throw new FyersRateLimitedError(
        `Fyers REST paused after a ${state.kind} rate limit; retrying in ${Math.ceil(this.remainingMs() / 1000)}s.`,
        state.kind,
        state.retryAtMs,
      );
    }
  }

  reset(): void {
    this.blockedUntilMs = 0;
  }
}

/** The gate the production clients share. Tests inject their own. */
export const fyersRateLimitGate = new FyersRateLimitGate();

/**
 * The scheduled jobs that call Fyers REST and are safe to skip for a cooldown: collection and polling, not the exit
 * sweep, which reads stored ticks and must keep running.
 */
export const FYERS_REST_JOB_TYPES: ReadonlySet<string> = new Set([
  "INDICES_INTRADAY",
  "INDIA_VIX_INTRADAY",
  "OPTION_CHAIN",
  "OPTION_PREMIUM_TICKS",
  "INDEX_FUTURES_INTRADAY",
  "AI_AGENT_TICK",
]);

/** Standard plan daily quota cap. */
export const FYERS_DAILY_REQUEST_CAP = 5_000;

/**
 * 70% budget threshold. When daily usage exceeds this, low-priority polling jobs are paused to
 * protect trading bot execution and exit sweeps until the next session.
 */
export const FYERS_DAILY_BUDGET_WARNING_THRESHOLD = 3_500;

/**
 * Low-value/non-critical jobs that should pause when daily usage passes the 70% threshold (3,500).
 * High-value execution (PAPER_TRADING_BOT, PAPER_TRADE_EXIT_SWEEP, INDICES_INTRADAY) stays active.
 */
export const LOW_PRIORITY_FYERS_JOBS: ReadonlySet<string> = new Set([
  "AI_AGENT_TICK",
  "OPTION_CHAIN",
  "INDIA_VIX_INTRADAY",
  "INDEX_FUTURES_INTRADAY",
]);

