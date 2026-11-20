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
 * Daily budget guard: 84% of the cap (4,200). When the day's count reaches it, the low-priority polling jobs below are paused so
 * what is left of the quota goes to execution and the exit sweep.
 *
 * It was 70% (3,500) until 2026-10-24. On 2026-10-23 the day's total was 4,001 with the UI quote cap already in force, so a
 * 3,500 guard paused the futures-bar fetch at about 14:43 with a thousand requests of headroom left; the volume profile, the
 * developing value and the volume-by-time views all read those bars and were cut short. 4,200 leaves 800 requests below the cap
 * for the jobs that are never paused.
 */
export const FYERS_DAILY_BUDGET_WARNING_THRESHOLD = 4_200;

/**
 * Non-critical jobs that pause once the day's count reaches the guard. Execution (PAPER_TRADING_BOT, PAPER_TRADE_EXIT_SWEEP,
 * INDICES_INTRADAY) stays active.
 *
 * OPTION_CHAIN and INDIA_VIX_INTRADAY are deliberately not here. The chain costs about five requests every twelve
 * minutes, and the premium tick collector selects its contracts from a snapshot no more than forty minutes old, so
 * pausing it stops the whole option series: on 2026-10-19 the guard paused it at 11:54, the last snapshot was
 * 11:41, and ticks and the chain page degraded from there. The VIX feeds the implied volatility behind option marks.
 *
 * INDEX_FUTURES_INTRADAY is deliberately not here either (changed 2026-10-24). Its bars are the only volume source for the
 * index profile views, and a day's bars cannot be fetched again cheaply: the history endpoint is limited separately and a
 * truncated session is permanently a partial one. The cost of keeping it running past the guard is small next to the 800
 * requests of headroom the guard leaves.
 */
export const LOW_PRIORITY_FYERS_JOBS: ReadonlySet<string> = new Set([
  "AI_AGENT_TICK",
]);

/**
 * Keeps the end-of-day run's share of the daily quota.
 *
 * The 4,200 guard above only pauses the agent tick. Everything else keeps polling, so the day's count reached 5,270 on
 * 2026-11-18, 6,434 on 2026-11-19 and 7,356 on 2026-11-17. On 2026-11-19 Fyers started refusing at about 13:30 IST, and at
 * 16:05 every step of the EOD pipeline failed with HTTP 429 (heal 15m/30m/60m, the 1d bars of 26 series), as on 11-17.
 * Measured on 11-19 from the scheduler's own request-count lines: option premium polling 2,379 requests (it falls back to
 * HTTP whenever the websocket is quiet), index history 1,461, futures bars 929, agent tick 675, option chain 113.
 *
 * A flat threshold cannot protect the EOD, because the polling that must not stop (index history, VIX, futures bars) keeps
 * spending after it. So the test looks ahead: pause the optional polling when the day's count, plus what the essential
 * polling will still spend before the close, plus the EOD's share, would reach the cap.
 */

/** Held back for the 16:05 EOD pipeline and the jobs near it (measured about 150 requests; 250 leaves room). */
export const FYERS_EOD_RESERVE_REQUESTS = 250;

/**
 * What the polling that never pauses spends per minute of session: index history about 3.9, futures bars about 1,
 * collector and UI quotes about 2.3 (2026-11-19). Rounded up so the projection errs towards pausing early.
 */
export const FYERS_ESSENTIAL_REQUESTS_PER_MINUTE = 8;

/**
 * Optional polling, paused by the projection. Option premium polling and the chain go together on purpose: the premium
 * collector chooses its contracts from a chain snapshot, so pausing only one of them leaves a half-working series (see
 * 2026-10-19 above). Index history, VIX and futures bars are not here: bots and the volume views read them.
 */
export const FYERS_RESERVE_PAUSED_JOBS: ReadonlySet<string> = new Set([
  "OPTION_PREMIUM_TICKS",
  "OPTION_CHAIN",
  "AI_AGENT_TICK",
]);

/** The session length used when it is not yet 09:15: 09:15 to 15:30 IST. */
const SESSION_MINUTES = 375;
const SESSION_CLOSE_IST_MINUTE = 15 * 60 + 30;

/** Minutes left until 15:30 IST, between 0 and a full session. */
export function minutesToFyersSessionClose(now: Date): number {
  const istMinuteOfDay = Math.floor(((now.getTime() + IST_OFFSET_MS) % DAY_MS) / 60_000);
  return Math.min(SESSION_MINUTES, Math.max(0, SESSION_CLOSE_IST_MINUTE - istMinuteOfDay));
}

export interface FyersReserveDecision {
  pause: boolean;
  /** The day's count if the essential polling carries on to the close, plus the EOD's reserve. */
  projectedWithReserve: number;
  minutesToClose: number;
}

export function fyersEodReserveDecision(input: { dailyTotal: number; now: Date }): FyersReserveDecision {
  const minutesToClose = minutesToFyersSessionClose(input.now);
  const projectedWithReserve = input.dailyTotal
    + minutesToClose * FYERS_ESSENTIAL_REQUESTS_PER_MINUTE
    + FYERS_EOD_RESERVE_REQUESTS;
  return { pause: projectedWithReserve >= FYERS_DAILY_REQUEST_CAP, projectedWithReserve, minutesToClose };
}
