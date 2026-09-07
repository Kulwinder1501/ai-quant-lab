/**
 * Alert thresholds as a versioned artifact, not as architecture constants.
 *
 * A threshold is an operational judgement that will be retuned as the deployment changes, and a
 * number normal for one strategy is catastrophic for another. Freezing one into a module means every
 * later tuning silently re-scopes what "healthy" meant for every prior observation.
 *
 * This system already has the counter-example. `STRUCTURAL_SILENCE_MS` in `collector-health.ts` is a
 * hard-coded 300 s, and it earns that by being *derived* rather than chosen — it is the streamer's own
 * reconnect backoff cap, so silence beyond it means recovery is not happening. Its comment says so
 * explicitly: "deliberately not a tunable quality bar, and nothing in the research path reads it."
 * That is the exception the rule needs. Anything tunable belongs here, with a version.
 *
 * The version travels with the promoted strategy so thresholds and artifact stay in step: a policy
 * bump is visible in the promotion record rather than arriving as a silent change of meaning.
 */

export type ObservabilitySeverity = "INFO" | "WARN" | "CRITICAL";

export interface ObservabilityThreshold {
  readonly metric: string;
  /**
   * The value the metric is compared against, in the metric's own units.
   *
   * Null means "declared, deliberately unset" — the metric is watched and reported but nothing alerts
   * yet. That is a legitimate state for a metric whose normal range is still being learned, and it is
   * not the same as omitting the metric, which would mean nobody thought about it.
   */
  readonly threshold: number | null;
  readonly comparison: "ABOVE" | "BELOW" | "EQUALS";
  readonly evaluationWindow: string;
  readonly severity: ObservabilitySeverity;
}

export interface ObservabilityPolicy {
  readonly policyVersion: string;
  readonly thresholds: readonly ObservabilityThreshold[];
}

export type ThresholdVerdict = "OK" | "BREACHED" | "NOT_EVALUATED";

/**
 * `OBS_POLICY_V1`.
 *
 * Thresholds are null where the normal range has not been measured. Guessing a number and alerting on
 * it produces exactly the failure that makes monitoring worthless: an alert that fires often enough to
 * be ignored, after which a real one is invisible too. Two entries do carry values, and both are
 * derived rather than picked.
 */
export const OBS_POLICY_V1: ObservabilityPolicy = {
  policyVersion: "OBS_POLICY_V1",
  thresholds: [
    {
      metric: "data_ready_gate.defer_rate",
      threshold: null,
      comparison: "ABOVE",
      evaluationWindow: "1 session",
      severity: "WARN",
    },
    {
      metric: "risk_engine.rejection_rate",
      threshold: null,
      comparison: "ABOVE",
      evaluationWindow: "1 session",
      severity: "WARN",
    },
    {
      metric: "snapshot_registry.resolution_latency_p95_ms",
      threshold: null,
      comparison: "ABOVE",
      evaluationWindow: "1 hour",
      severity: "WARN",
    },
    {
      /*
       * Derived, not chosen: zero fills during market hours means the pipeline is down, whatever the
       * strategy. This is the one execution metric whose correct threshold is not strategy-dependent.
       */
      metric: "execution.fill_rate",
      threshold: 0,
      comparison: "EQUALS",
      evaluationWindow: "market hours",
      severity: "CRITICAL",
    },
    {
      /*
       * Derived from the tape, not tuned. The index feed freezes from the 15:16 bar to the close, so
       * roughly 13 frozen decisions per instrument per session is the expected floor. Materially more
       * means the feed stalled intraday, which is a different and more serious condition.
       */
      metric: "tape_liveness.frozen_decisions_per_session",
      threshold: 13,
      comparison: "ABOVE",
      evaluationWindow: "1 session per instrument",
      severity: "WARN",
    },
  ],
};

export function findThreshold(
  policy: ObservabilityPolicy,
  metric: string,
): ObservabilityThreshold | null {
  return policy.thresholds.find((entry) => entry.metric === metric) ?? null;
}

/**
 * Evaluates an observed value.
 *
 * An undeclared metric **throws** rather than passing. Silently returning `OK` for a metric nobody
 * declared is how a dashboard shows green for something it is not watching, which is worse than no
 * dashboard: it is a green light with nothing behind it.
 *
 * A declared metric with a null threshold returns `NOT_EVALUATED`, which is a third answer and not a
 * pass. Collapsing it into `OK` would make "we have not set a bar yet" indistinguishable from "this is
 * within bounds" — the same conflation that let an earlier collector outage read as a healthy quiet
 * period.
 */
export function evaluateThreshold(input: {
  readonly policy: ObservabilityPolicy;
  readonly metric: string;
  readonly observed: number;
}): ThresholdVerdict {
  const declared = findThreshold(input.policy, input.metric);
  if (declared === null) {
    throw new Error(
      `Metric "${input.metric}" is not declared in ${input.policy.policyVersion}. An undeclared `
      + "metric cannot be reported as healthy, because nothing has said what healthy means.",
    );
  }
  if (declared.threshold === null) return "NOT_EVALUATED";
  if (!Number.isFinite(input.observed)) {
    throw new Error(`Observed value for "${input.metric}" must be finite; received ${input.observed}.`);
  }
  const breached = declared.comparison === "ABOVE"
    ? input.observed > declared.threshold
    : declared.comparison === "BELOW"
      ? input.observed < declared.threshold
      : input.observed === declared.threshold;
  return breached ? "BREACHED" : "OK";
}
