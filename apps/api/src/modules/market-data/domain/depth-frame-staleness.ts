/**
 * Operational health of the raw L2 depth capture. **Monitoring only.**
 *
 * Same contract as `collector-health.ts`, for the same reason: this answers "is the depth collector
 * producing rows", which is an infrastructure question. Nothing in the research path may import it,
 * and `collector-health-isolation.test.ts`'s sibling guard keeps it that way. A tuned operational
 * threshold must never become an admission criterion for a frozen experiment.
 *
 * ## The failure this exists for
 *
 * `depth_frames` cannot be backfilled. Candles have a repair path -- `heal-candle-gaps` refetches a
 * session from the provider -- and the order book has none: an L2 update that was not received when
 * it happened is gone. So the cost of a silent depth outage is strictly higher than a silent candle
 * gap, and the detection latency needs to be minutes, not days.
 *
 * It was days. On 2026-08-25 the collector captured a full session (42,704 frames) against
 * `NSE:BANKNIFTY26AUGFUT`. That contract's monthly expiry *was* 2026-08-25. From the next session it
 * no longer existed, and the feed's response to a subscription for a dead contract is not an error --
 * it accepts the subscription and delivers nothing, which on the wire is indistinguishable from a
 * book with no updates. The container stayed "Up", the WebSocket stayed open, and two full sessions
 * were lost before anyone looked.
 *
 * ## Why this is symbol-agnostic, deliberately
 *
 * The obvious check -- "is `NSE:BANKNIFTY26SEPFUT` producing frames" -- reproduces the bug it is
 * meant to catch. That symbol rolls on 2026-09-29, and a checker holding its own hardcoded copy
 * would go stale in exactly the same way, one month later, while reporting healthy.
 *
 * So the scheduled check asserts only this: **during market hours, `depth_frames` is growing.**
 * A rolled contract, a dropped socket, a lapsed token, a crashed container and a full disk all
 * produce that same observable, and every one of them is worth waking up for. It cannot rot, because
 * it names nothing that expires.
 *
 * `expectedSymbols` remains available for a caller that genuinely wants a per-symbol assertion, but
 * the cron job passes none. See `check-depth-frame-staleness.ts`.
 */

/** Depth capture serves derivatives, so its day is the derivatives day: 09:15-15:40 IST. */
export const DEPTH_CAPTURE_SEGMENT = "EQUITY_DERIVATIVES" as const;

/**
 * Silence longer than this is structural rather than merely quiet.
 *
 * Derived, not chosen, and the derivation is the same one `collector-health.ts` uses: the streamer's
 * `reconnectDelayMs` backs off exponentially and caps at 300 s, so a healthy collector that lost its
 * socket should have re-established it and resumed inside one cap. Beyond that, recovery is not
 * happening on its own.
 *
 * It also matches the collector's own in-process `--stale-after-seconds` default, so the out-of-process
 * check and the in-process heartbeat agree on what "silent" means rather than disagreeing by minutes.
 */
export const DEPTH_STRUCTURAL_SILENCE_MS = 300_000;

/**
 * Grace after the opening bell before silence counts.
 *
 * The collector reconnects and resubscribes at open, and the first frames legitimately take a few
 * seconds. Alarming inside the warm-up would fire every morning and train an operator to ignore it,
 * which is the failure mode `detect-candle-gaps` avoids by not failing on an ambiguous short tail.
 */
export const DEPTH_SESSION_WARMUP_MS = 300_000;

export interface DepthSymbolObservation {
  readonly providerSymbol: string;
  readonly frames: number;
  readonly lastFrameAt: Date;
}

export interface DepthSessionWindow {
  readonly opensAt: Date;
  readonly closesAt: Date;
}

/**
 * `NOT_DUE` is kept distinct from `HEALTHY` for the reason `collector-health.ts` keeps `INCOMPLETE`
 * distinct from `DEGRADED`: "cannot judge yet" is not "it works". Outside market hours a silent depth
 * collector is correct behaviour, and reporting that as HEALTHY would let a check that never actually
 * ran look like a passing one.
 */
export type DepthCaptureStatusValue = "HEALTHY" | "STALE" | "SILENT" | "NOT_DUE";

export interface DepthCaptureStatus {
  readonly status: DepthCaptureStatusValue;
  readonly checkedAt: Date;
  /** Since the newest frame across all symbols. Null when nothing was observed at all. */
  readonly silentForMs: number | null;
  readonly observedSymbols: readonly DepthSymbolObservation[];
  /** Named in `expectedSymbols`, present in the window, but individually silent. */
  readonly staleSymbols: readonly string[];
  /** Named in `expectedSymbols` and entirely absent from the window. */
  readonly missingSymbols: readonly string[];
  /** Machine-readable causes, in the style of `collector-health.ts`'s findings. */
  readonly findings: readonly string[];
}

export interface EvaluateDepthCaptureInput {
  readonly now: Date;
  /** Null on a weekend or holiday. */
  readonly session: DepthSessionWindow | null;
  readonly observations: readonly DepthSymbolObservation[];
  readonly expectedSymbols?: readonly string[];
  readonly structuralSilenceMs?: number;
  readonly warmupMs?: number;
}

export function evaluateDepthCaptureStaleness(input: EvaluateDepthCaptureInput): DepthCaptureStatus {
  const {
    now,
    session,
    observations,
    expectedSymbols = [],
    structuralSilenceMs = DEPTH_STRUCTURAL_SILENCE_MS,
    warmupMs = DEPTH_SESSION_WARMUP_MS,
  } = input;

  const notDue = (finding: string): DepthCaptureStatus => ({
    status: "NOT_DUE",
    checkedAt: now,
    silentForMs: null,
    observedSymbols: observations,
    staleSymbols: [],
    missingSymbols: [],
    findings: [finding],
  });

  if (session === null) return notDue("MARKET_CLOSED");
  // Half-open at both ends on purpose. Before open + warm-up there is nothing to expect; at or after
  // the close the daemon is correctly idle, and the last minutes of a session are not a window in
  // which to start alarming about a feed that is about to stop anyway.
  if (now.getTime() < session.opensAt.getTime() + warmupMs) return notDue("SESSION_WARMUP");
  if (now.getTime() >= session.closesAt.getTime()) return notDue("SESSION_CLOSED");

  const findings: string[] = [];
  const newestMs = observations.reduce(
    (newest, observation) => Math.max(newest, observation.lastFrameAt.getTime()),
    Number.NEGATIVE_INFINITY,
  );

  // Nothing at all, from any symbol, during a live session. This is the 2026-08-26 shape: socket open,
  // container up, table frozen.
  if (!Number.isFinite(newestMs)) {
    return {
      status: "SILENT",
      checkedAt: now,
      silentForMs: null,
      observedSymbols: [],
      staleSymbols: [],
      missingSymbols: [...expectedSymbols],
      findings: ["NO_DEPTH_FRAMES_DURING_MARKET_HOURS"],
    };
  }

  const silentForMs = now.getTime() - newestMs;
  if (silentForMs >= structuralSilenceMs) findings.push("DEPTH_CAPTURE_SILENT");

  const observedBySymbol = new Map(observations.map((o) => [o.providerSymbol.toUpperCase(), o]));
  const staleSymbols: string[] = [];
  const missingSymbols: string[] = [];
  for (const symbol of expectedSymbols) {
    const observation = observedBySymbol.get(symbol.toUpperCase());
    if (observation === undefined) {
      missingSymbols.push(symbol);
      findings.push(`EXPECTED_SYMBOL_ABSENT:${symbol}`);
      continue;
    }
    if (now.getTime() - observation.lastFrameAt.getTime() >= structuralSilenceMs) {
      staleSymbols.push(symbol);
      findings.push(`EXPECTED_SYMBOL_SILENT:${symbol}`);
    }
  }

  // A named symbol that is entirely absent while others stream is the roll signature, so it reads as
  // SILENT (that subscription produced nothing) rather than STALE (it produced, then stopped).
  const status: DepthCaptureStatusValue = missingSymbols.length > 0
    ? "SILENT"
    : findings.length > 0 ? "STALE" : "HEALTHY";

  return {
    status,
    checkedAt: now,
    silentForMs,
    observedSymbols: observations,
    staleSymbols,
    missingSymbols,
    findings: findings.length > 0 ? findings : ["DEPTH_CAPTURE_STREAMING"],
  };
}

/** A Fyers futures ticker decomposed far enough to ask whether it has rolled. */
export interface ParsedFuturesSymbol {
  readonly exchange: string | null;
  readonly underlying: string;
  /** Two-digit contract year as written in the ticker, e.g. 26. */
  readonly year: number;
  /** 1-12, from the three-letter month in the ticker. */
  readonly month: number;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * Parses `NSE:BANKNIFTY26AUGFUT` into its parts. Returns null for anything that is not a futures
 * ticker -- options and equities are not this function's business and must not be guessed at.
 */
export function parseFuturesSymbol(symbol: string): ParsedFuturesSymbol | null {
  const match = /^(?:([A-Z]+):)?([A-Z]+?)(\d{2})([A-Z]{3})FUT$/.exec(symbol.trim().toUpperCase());
  if (match === null) return null;
  const month = MONTHS.indexOf(match[4]!);
  if (month < 0) return null;
  return {
    exchange: match[1] ?? null,
    underlying: match[2]!,
    year: Number(match[3]),
    month: month + 1,
  };
}

/**
 * Explains a silent capture when the cause is a contract that has rolled.
 *
 * This is the `repairHint` of `detect-candle-gaps`: the alarm is worth little if the operator still
 * has to work out what to do about it, and for depth capture the overwhelmingly likely cause of a
 * whole-session silence is the monthly roll. The expiry dates come from `option_expiry_calendar`
 * rather than from a rule about last Thursdays -- BANKNIFTY is monthly-only and NSE moves expiries
 * around holidays, so a computed date would be wrong exactly when it mattered.
 *
 * Returns null when the last captured symbol is not a futures ticker, or when its contract month has
 * not passed -- in which case the silence has some other cause and a confident roll hint would send
 * the operator the wrong way.
 */
export function describeContractRoll(input: {
  readonly lastCapturedSymbol: string;
  readonly now: Date;
  /** Expiry dates for the underlying, as `YYYY-MM-DD`. */
  readonly expiries: readonly string[];
}): { readonly expiredContract: string; readonly expiredOn: string; readonly hint: string } | null {
  const parsed = parseFuturesSymbol(input.lastCapturedSymbol);
  if (parsed === null) return null;

  const contractMonth = `${String(2000 + parsed.year)}-${String(parsed.month).padStart(2, "0")}`;
  const expiry = input.expiries.find((date) => date.startsWith(contractMonth));
  if (expiry === undefined) return null;

  // Date-only comparison against the IST session date: an expiry is spent once its day is over, and
  // the contract is untradeable from the next session, which is when capture actually stops.
  const todayIst = new Date(input.now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  if (expiry >= todayIst) return null;

  return {
    expiredContract: input.lastCapturedSymbol,
    expiredOn: expiry,
    hint: `${input.lastCapturedSymbol} expired on ${expiry}. The feed accepts a subscription to an `
      + "expired contract and then delivers nothing, with no error. Roll --symbols on depth-collector-v2 "
      + "in docker-compose.v2.yml to the current front month and recreate the container.",
  };
}
