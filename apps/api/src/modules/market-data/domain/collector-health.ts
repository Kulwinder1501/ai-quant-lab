/**
 * Operational health of the option-premium collector. **Monitoring only.**
 *
 * This module must never influence research semantics. It answers "is the collector running", which
 * is an infrastructure question; D2's qualification question is a different one and stays where it
 * is:
 *
 *   CollectorHealth   = operational warning     (this file)
 *   D2SessionCoverage = research qualification  (d2-premium-cost-gate.ts)
 *
 * The separation is physical, not conventional: this lives in `market-data`, the research modules do
 * not import it, and `collector-health-isolation.test.ts` fails the build if that ever changes. The
 * reason is specific — a health threshold is an operations judgement that will be tuned as the
 * deployment changes, and letting a tuned number qualify or disqualify a frozen experiment's sessions
 * would make the experiment's admission criteria drift without anyone re-registering them.
 *
 * The authoritative D2 coverage test remains, unchanged and elsewhere: frozen opportunity → correct
 * frozen contract → entry ask within 60 s → same-contract exit bid within 60 s.
 */

/** The collector serves options, so its day is the derivatives day: 09:15-15:40 IST. */
export const COLLECTOR_HEALTH_SEGMENT = "EQUITY_DERIVATIVES" as const;

/**
 * A silence longer than this is structurally abnormal rather than merely quiet.
 *
 * Derived, not chosen: `reconnectDelayMs` in `fyers-live-streamer.ts` backs off exponentially and
 * **caps at 300 s**, so a healthy collector that lost its socket should have re-established it and
 * resumed inside one cap. Silence beyond that means recovery is not happening on its own, which is
 * the structural failure worth alerting on.
 *
 * It is deliberately not a tunable quality bar, and nothing in the research path reads it.
 */
export const STRUCTURAL_SILENCE_MS = 300_000;

/** How late a start, or how early a stop, still counts as covering the session. */
export const SESSION_EDGE_TOLERANCE_MS = 300_000;

export interface CollectorObservation {
  /** Our receipt clock, always present. */
  readonly observedAt: Date;
  /** The exchange's clock where the regime records one; null for collectors that did not. */
  readonly exchangeFeedTime: Date | null;
  /** When the row was written, for persistence lag. */
  readonly persistedAt: Date;
  readonly collectorRegime: string | null;
}

export interface CollectorGap {
  readonly startAt: Date;
  readonly endAt: Date;
  readonly durationMs: number;
}

export type CollectorHealthStatusValue = "HEALTHY" | "DEGRADED" | "INCOMPLETE";

/**
 * Gaps in a single clock domain.
 *
 * Reported per domain rather than as one uptime number, because the three answer different
 * questions and a single figure conflates them:
 *
 *   receipt gap        -> our collector stopped receiving
 *   exchange-feed gap  -> the vendor stopped sending
 *   persistence lag    -> the database stopped writing
 *
 * A receipt gap with no exchange-feed gap is our process; both together is the feed.
 */
export interface ClockDomainHealth {
  readonly available: boolean;
  readonly gaps: readonly CollectorGap[];
  readonly maxGapMs: number;
  /** Populated when the domain could not be measured, so absent is never read as clean. */
  readonly unavailableReason: string | null;
}

export interface CollectorHealthStatus {
  readonly sessionDate: string;
  readonly segment: typeof COLLECTOR_HEALTH_SEGMENT;
  readonly expectedOpenAt: Date;
  readonly expectedCloseAt: Date;
  readonly firstObservedAt: Date | null;
  readonly lastObservedAt: Date | null;
  readonly maxGapMs: number;
  readonly gaps: readonly CollectorGap[];
  readonly collectorRegimes: readonly string[];
  /**
   * Derived, not measured: the number of silences that resolved into further observations.
   *
   * The streamer counts its own reconnects in memory and persists nothing, so this is a lower bound
   * inferred from resumption. Named here rather than presented as a vendor-reported figure.
   */
  readonly reconnectCount: number;
  readonly receipt: ClockDomainHealth;
  readonly exchangeFeed: ClockDomainHealth;
  readonly persistenceLagMs: { readonly median: number; readonly max: number } | null;
  /** Named structural failures, in the order detected. Empty when HEALTHY. */
  readonly findings: readonly string[];
  readonly status: CollectorHealthStatusValue;
}

function detectGaps(times: readonly Date[], thresholdMs: number): CollectorGap[] {
  const gaps: CollectorGap[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const startAt = times[index - 1]!;
    const endAt = times[index]!;
    const durationMs = endAt.getTime() - startAt.getTime();
    if (durationMs > thresholdMs) gaps.push({ startAt, endAt, durationMs });
  }
  return gaps;
}

function domainHealth(times: readonly Date[], thresholdMs: number, unavailableReason: string | null): ClockDomainHealth {
  if (unavailableReason !== null) {
    return { available: false, gaps: [], maxGapMs: 0, unavailableReason };
  }
  const gaps = detectGaps(times, thresholdMs);
  return {
    available: true,
    gaps,
    maxGapMs: gaps.reduce((largest, gap) => Math.max(largest, gap.durationMs), 0),
    unavailableReason: null,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Classifies one session's collection.
 *
 * `INCOMPLETE` is reserved for "cannot judge yet" — the session has not finished, or nothing was
 * collected at all — and is kept distinct from `DEGRADED`, which is a positive finding that
 * something structurally failed. Collapsing them would make "we have not looked yet" and "it broke"
 * indistinguishable, which is the same conflation that made the 2026-08-24 pattern loss invisible.
 */
export function evaluateCollectorHealth(input: {
  sessionDate: string;
  expectedOpenAt: Date;
  expectedCloseAt: Date;
  observations: readonly CollectorObservation[];
  /** Evaluation time; a session still in progress cannot be judged complete. */
  now: Date;
}): CollectorHealthStatus {
  const { sessionDate, expectedOpenAt, expectedCloseAt, now } = input;
  const observations = [...input.observations].sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  // Regimes are read from in-session rows for the same reason gaps are: a boundary crossed outside
  // trading hours is a deploy, not an unexpected mid-session change.
  const inWindow = observations.filter((item) => (
    item.observedAt.getTime() >= input.expectedOpenAt.getTime()
    && item.observedAt.getTime() <= input.expectedCloseAt.getTime()
  ));
  const regimes = [...new Set(inWindow.map((item) => item.collectorRegime ?? "(unstamped)"))].sort();
  const findings: string[] = [];

  if (observations.length === 0) {
    return {
      sessionDate,
      segment: COLLECTOR_HEALTH_SEGMENT,
      expectedOpenAt,
      expectedCloseAt,
      firstObservedAt: null,
      lastObservedAt: null,
      maxGapMs: 0,
      gaps: [],
      collectorRegimes: [],
      reconnectCount: 0,
      receipt: domainHealth([], STRUCTURAL_SILENCE_MS, "no observations"),
      exchangeFeed: domainHealth([], STRUCTURAL_SILENCE_MS, "no observations"),
      persistenceLagMs: null,
      findings: ["COLLECTOR_PRODUCED_NOTHING"],
      status: "INCOMPLETE",
    };
  }

  const firstObservedAt = observations[0]!.observedAt;
  const lastObservedAt = observations[observations.length - 1]!.observedAt;

  /*
   * Gaps are only meaningful inside the trading window.
   *
   * The collector legitimately goes quiet once the market shuts, and the streamer keeps a few
   * contracts subscribed past the bell, so raw same-date ticks contain long post-close silences.
   * Measured on 2026-08-24 those dominated the findings -- three gaps of 10-26 minutes, all after
   * 15:40 IST -- and reporting them would mark every ordinary session DEGRADED until the alert
   * became noise and stopped being read. Session-edge coverage is checked separately below.
   */
  const inSession = observations.filter((item) => (
    item.observedAt.getTime() >= expectedOpenAt.getTime()
    && item.observedAt.getTime() <= expectedCloseAt.getTime()
  ));

  const receipt = domainHealth(inSession.map((item) => item.observedAt), STRUCTURAL_SILENCE_MS, null);

  const withExchangeClock = inSession.filter((item) => item.exchangeFeedTime !== null);
  const exchangeFeed = domainHealth(
    withExchangeClock.map((item) => item.exchangeFeedTime!),
    STRUCTURAL_SILENCE_MS,
    // Partial coverage is worse than none for this purpose: gaps would be measured across the rows
    // that happen to carry a clock and would not mean what they appear to.
    inSession.length > 0 && withExchangeClock.length === inSession.length ? null
      : `only ${withExchangeClock.length}/${inSession.length} in-session rows carry an exchange clock`,
  );

  const lags = inSession.map((item) => item.persistedAt.getTime() - item.observedAt.getTime());

  // Structural checks. Each names a distinct failure so an alert says what broke, not just "bad".
  if (firstObservedAt.getTime() > expectedOpenAt.getTime() + SESSION_EDGE_TOLERANCE_MS) {
    findings.push("COLLECTOR_STARTED_LATE");
  }
  const sessionOver = now.getTime() >= expectedCloseAt.getTime();
  if (sessionOver && lastObservedAt.getTime() < expectedCloseAt.getTime() - SESSION_EDGE_TOLERANCE_MS) {
    findings.push("COLLECTOR_STOPPED_EARLY");
  }
  for (const gap of receipt.gaps) findings.push(`RECEIPT_SILENCE_${Math.round(gap.durationMs / 1000)}S`);
  if (exchangeFeed.available) {
    for (const gap of exchangeFeed.gaps) findings.push(`EXCHANGE_FEED_SILENCE_${Math.round(gap.durationMs / 1000)}S`);
  }
  if (regimes.length > 1) findings.push(`UNEXPECTED_REGIME_CHANGE:${regimes.join(",")}`);

  // A live session is INCOMPLETE unless something already failed -- a partial day is not yet a
  // healthy day, but a gap that has already happened is a finding now, not at the close.
  const status: CollectorHealthStatusValue = findings.length > 0
    ? "DEGRADED"
    : sessionOver ? "HEALTHY" : "INCOMPLETE";

  return {
    sessionDate,
    segment: COLLECTOR_HEALTH_SEGMENT,
    expectedOpenAt,
    expectedCloseAt,
    firstObservedAt,
    lastObservedAt,
    maxGapMs: receipt.maxGapMs,
    gaps: receipt.gaps,
    collectorRegimes: regimes,
    reconnectCount: receipt.gaps.length,
    receipt,
    exchangeFeed,
    persistenceLagMs: lags.length === 0 ? null : { median: median(lags), max: Math.max(...lags) },
    findings,
    status,
  };
}

/** One line for an alert or log, naming what broke rather than emitting a score. */
export function describeCollectorHealth(health: CollectorHealthStatus): string {
  if (health.status === "HEALTHY") {
    return `${health.sessionDate} HEALTHY — covered ${health.firstObservedAt?.toISOString()}..${health.lastObservedAt?.toISOString()}`;
  }
  return `${health.sessionDate} ${health.status} — ${health.findings.join("; ")}`;
}
