import {
  assertSnapshotRef,
  snapshotRefFor,
  type SnapshotRef,
} from "../../platform/snapshot/snapshot-ref.js";
import {
  sealPitInstants,
  type BarLabelConvention,
  type PitInstants,
} from "../../platform/pit/pit-instants.js";

/**
 * §6's `MarketContextAdapter`: legacy bar/indicator context → `MarketSnapshot`.
 *
 * The ladder names `MarketSnapshot` once and never specifies it, so this file defines the target
 * contract as well as the translation. The contract is the more important half: three V1 habits are
 * made **structurally unrepresentable** here rather than merely discouraged, because §6's rule for
 * every adapter is that it must not reproduce V1 decision logic inside V2.2 — and the reliable way to
 * honour that is to leave nowhere for that logic to live.
 *
 * ## 1. There is no field for "the pattern"
 *
 * `patterns[0]` is on §6's QUARANTINE list: V1 treated the first detected pattern as *the* pattern.
 * `MarketSnapshot` therefore has no primary-pattern field, and no ordering guarantee is documented on
 * the array. A consumer that wants one pattern has to justify picking it, in its own code, where the
 * choice is visible — instead of inheriting an accident of detector ordering.
 *
 * Per-pattern `confidence` **is** carried: it is a detector output, not a composite. What is refused
 * is composing them, which is the other quarantined artifact.
 *
 * ## 2. Coverage is declared, never inferred from emptiness
 *
 * V1 encodes "not loaded" as `undefined` and "loaded, found nothing" as `[]`, and that distinction is
 * load-bearing: absence of observations is only information when the detector is known to have run.
 * It has already cost a real measurement — on 2026-08-24, 46% of scalp evaluations read a bar whose
 * pattern layer had not been computed, the pattern strategy's firing rate fell 93%, and the
 * eligibility check could not see why.
 *
 * An adapter that mapped `undefined → []` would erase exactly that, and it would look like tidying.
 * So `MarketSnapshot` carries an explicit `SnapshotCoverage` per optional layer, and this adapter
 * **refuses** a legacy context whose declared coverage contradicts its data rather than picking a
 * winner.
 *
 * ## 3. The bar's label convention travels with it
 *
 * `dataThrough` is not recoverable from an instant: Pattern Intelligence is `OPEN_LABELLED` and the
 * scalp harness is `CLOSE_LABELLED`, so the same timestamp means different bars in the two modules.
 * The convention is required on the snapshot for the same reason `sealPitInstants` requires it — a
 * consumer that guesses is off by one bar, silently, in whichever direction it guessed wrong.
 *
 * ## What is deliberately dropped
 *
 * `higherTimeframes` is **not** carried as data. Nothing in V1 populates it — no resolver exists and
 * no repository sets it — so every confluence term it feeds currently computes 0. Adapting it would
 * manufacture a field that always reads "no HTF context" when the truth is "never measured", and the
 * measured finding is that the counter-trend veto it fed does not replicate across instruments
 * anyway. It is represented as coverage only, fixed at `NOT_LOADED`, so a consumer cannot mistake
 * absence for a reading.
 *
 * ## Temporary by construction
 *
 * §6: *"Each adapter is temporary and is deleted once the real V2.2 subsystem replaces it."* Nothing
 * downstream should depend on the *legacy* shape reaching it — consumers take `MarketSnapshot`, so
 * when a native V2.2 producer exists this file is deleted and its callers do not change.
 */

/** Whether an optional layer was computed for this bar. `[]` under `LOADED` means genuinely none. */
export type SnapshotCoverage = "LOADED" | "NOT_LOADED";

export interface MarketSnapshotBar {
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly tickSize: number;
}

export interface SnapshotIndicator {
  readonly code: string;
  readonly algorithmVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface SnapshotPattern {
  readonly code: string;
  readonly algorithmVersion: string;
  readonly direction: string;
  /** The detector's own confidence. Composing these is quarantined; carrying one is not. */
  readonly confidence: number;
}

export interface SnapshotPriceActionEvent {
  readonly eventCode: string;
  readonly algorithmVersion: string;
  readonly direction: string;
  readonly level: number | null;
}

export interface MarketSnapshot {
  /** Content-addressed identity, so two decisions can be shown to have read the same market state. */
  readonly ref: SnapshotRef;
  readonly instants: Readonly<PitInstants>;
  readonly bar: MarketSnapshotBar;
  /** Which convention `bar` and `instants.dataThrough` are stamped in. */
  readonly labelConvention: BarLabelConvention;
  readonly indicators: readonly SnapshotIndicator[];
  /**
   * Every detected pattern. **No ordering is guaranteed and there is no primary.**
   *
   * Deliberate: `patterns[0]` as "the pattern" is quarantined, so a consumer must select and justify.
   */
  readonly patterns: readonly SnapshotPattern[];
  readonly patternCoverage: SnapshotCoverage;
  readonly priceActionEvents: readonly SnapshotPriceActionEvent[];
  readonly priceActionCoverage: SnapshotCoverage;
  /** Coverage only, and always `NOT_LOADED`: nothing populates the legacy field. */
  readonly higherTimeframeCoverage: SnapshotCoverage;
}

/**
 * The legacy shape, restated structurally.
 *
 * Declared here rather than imported from `strategy-engine`, because the quarantine guard forbids
 * `autonomous-v2` importing V1 — and an adapter that reached into V1 to be convenient would be the
 * first crack in the boundary it exists to protect. The caller, which may see both, builds this.
 */
export interface LegacyMarketContext {
  readonly candle: MarketSnapshotBar;
  readonly indicators: readonly SnapshotIndicator[];
  readonly patterns: readonly SnapshotPattern[];
  readonly priceActionEvents: readonly SnapshotPriceActionEvent[];
  /** `undefined` means the layer was not computed. `[]` means computed and empty. */
  readonly patternsComputed: boolean;
  readonly priceActionComputed: boolean;
}

export class MarketContextAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketContextAdapterError";
  }
}

function assertCoverageAgrees(
  computed: boolean,
  rows: readonly unknown[],
  layer: string,
): SnapshotCoverage {
  /*
   * The contradiction worth refusing: rows present under `computed: false`. That means the caller
   * has data it says was never computed, so one of the two is wrong and neither is safe to prefer --
   * trusting the rows would admit data of unknown provenance, and trusting the flag would silently
   * discard real detections.
   *
   * The reverse (`computed: true`, no rows) is legitimate and is the whole point of the distinction:
   * the detector ran and found nothing.
   */
  if (!computed && rows.length > 0) {
    throw new MarketContextAdapterError(
      `${layer}: ${rows.length} row(s) supplied but the layer is declared not computed. Coverage is `
      + "declared, never inferred from emptiness -- so this contradiction is refused rather than "
      + "resolved in either direction.",
    );
  }
  return computed ? "LOADED" : "NOT_LOADED";
}

/**
 * Translates a legacy context into a sealed `MarketSnapshot`.
 *
 * The `ref` is derived from the snapshot's own content, so it cannot be stamped with an identity that
 * does not match what it holds — the failure `assertSnapshotRef` exists to catch, closed here by
 * construction rather than by validation.
 */
export function marketSnapshotFromLegacyContext(input: {
  readonly context: LegacyMarketContext;
  readonly instants: PitInstants;
  readonly labelConvention: BarLabelConvention;
}): MarketSnapshot {
  const { context, labelConvention } = input;
  const { candle } = context;

  if (candle.closeTime.getTime() <= candle.openTime.getTime()) {
    throw new MarketContextAdapterError(
      `Bar ${candle.instrumentId}/${candle.timeframe} closes at or before it opens, so it spans no `
      + "time and cannot have been observed.",
    );
  }
  if (input.instants.dataThroughConvention !== labelConvention) {
    /*
     * Both are recorded because neither is recoverable from the other, and they must agree: a
     * snapshot whose bar is close-labelled while its `dataThrough` is open-labelled describes two
     * different bars, and every forward measurement taken from it is off by one span.
     */
    throw new MarketContextAdapterError(
      `Label convention mismatch: the bar is ${labelConvention} but dataThrough is stamped `
      + `${input.instants.dataThroughConvention}. These describe different bars.`,
    );
  }

  const patternCoverage = assertCoverageAgrees(context.patternsComputed, context.patterns, "patterns");
  const priceActionCoverage = assertCoverageAgrees(
    context.priceActionComputed, context.priceActionEvents, "priceActionEvents",
  );

  const content = {
    bar: {
      ...candle,
      openTime: candle.openTime.toISOString(),
      closeTime: candle.closeTime.toISOString(),
    },
    labelConvention,
    indicators: context.indicators,
    patterns: context.patterns,
    patternCoverage,
    priceActionEvents: context.priceActionEvents,
    priceActionCoverage,
    // Fixed, so it participates in the identity: a snapshot built when HTF context exists will hash
    // differently from one built now, rather than silently comparing equal.
    higherTimeframeCoverage: "NOT_LOADED" as const,
    instants: {
      eventAt: input.instants.eventAt.toISOString(),
      knownAt: input.instants.knownAt.toISOString(),
      dataThrough: input.instants.dataThrough.toISOString(),
      dataThroughConvention: input.instants.dataThroughConvention,
      earliestExecutionAt: input.instants.earliestExecutionAt.toISOString(),
      referenceAt: input.instants.referenceAt.toISOString(),
    },
  };

  const ref = snapshotRefFor(content);
  assertSnapshotRef(ref);

  return Object.freeze({
    ref,
    instants: sealPitInstants(input.instants),
    bar: Object.freeze({ ...candle }),
    labelConvention,
    indicators: Object.freeze([...context.indicators]),
    patterns: Object.freeze([...context.patterns]),
    patternCoverage,
    priceActionEvents: Object.freeze([...context.priceActionEvents]),
    priceActionCoverage,
    higherTimeframeCoverage: "NOT_LOADED",
  });
}
