import { randomUUID } from "node:crypto";
import type {
  AnyDetectedPattern,
  DetectedPatternV2,
  ObservationSource,
  PatternCoverageRecorder,
  PatternDefinitionRef,
  PatternDefinitionRegistry,
  PatternFamily,
  PatternLifecycleEvent,
  PatternObservationLedger,
  SubtypeOf,
  SweepReclaimDetails,
} from "../domain/contracts.js";
import { BreakoutStateEngine } from "../domain/engines/breakout-state-engine.js";
import { CandleGeometryEngine } from "../domain/engines/candle-geometry-engine.js";
import { ClassicalReversalEngine } from "../domain/engines/classical-reversal-engine.js";
import { CompressionExpansionEngine } from "../domain/engines/compression-expansion-engine.js";
import { ContinuationStructureEngine } from "../domain/engines/continuation-structure-engine.js";
import { EffortResultEngine } from "../domain/engines/effort-result-engine.js";
import { GapStructureEngine } from "../domain/engines/gap-structure-engine.js";
import { LevelInteractionEngine } from "../domain/engines/level-interaction-engine.js";
import { MultiCandleEngine } from "../domain/engines/multi-candle-engine.js";
import { OpeningStructureEngine } from "../domain/engines/opening-structure-engine.js";
import { SweepReclaimEngine } from "../domain/engines/sweep-reclaim-engine.js";
import { SwingStructureEngine } from "../domain/engines/swing-structure-engine.js";
import { isStaleBar } from "../domain/bar-integrity.js";
import { timeframeDurationMs } from "../domain/instrument-identifiers.js";
import { lifecycleIdempotencyKey } from "../domain/lifecycle.js";
import {
  atrPeriod,
  calculateAtrSeries,
  calculateEmaSeries,
  calculatePatternContext,
  calculatePatternGeometry,
  minimumClosedBarsForEmission,
  type CandleLike,
} from "../domain/pattern-context-calculator.js";
import { definitionIdForFamily } from "../domain/pattern-definition-registry.js";
import { sessionSegmentOf } from "../domain/session-windows.js";
import { recordDetectedPattern } from "./record-detected-pattern.js";

export interface DetectPatternIntelligenceInput {
  candles: readonly CandleLike[];
  source: ObservationSource;
  referenceLevels?: { pdh?: number; pdl?: number; pdc?: number };
  engineVersion?: string;
  configVersion?: string;
  configHash?: string;
}

export interface DetectPatternIntelligenceResult {
  candlesEvaluated: number;
  patternsDetected: number;
  patternsRecorded: number;
  observations: readonly AnyDetectedPattern[];
  /**
   * Candidates dropped before emission because their detection bar could not support an
   * observation — ATR warmup incomplete, or the bar sat outside the observable session.
   *
   * Reported rather than silently discarded: a run that refuses 400 candidates and a run that found
   * 0 are different facts, and collapsing them would rebuild the ambiguity the coverage record
   * exists to remove.
   */
  candidatesRefusedBeforeWarmup: number;
  candidatesRefusedOutsideSession: number;
  /** Candidates anchored to a bar that republished the previous print, or reported nothing. See `isStaleBar`. */
  candidatesRefusedStaleBar: number;
  /** Candidates refused because no frozen PatternDefinition backs them — a registry misconfiguration. */
  candidatesRefusedUnregistered: number;
  /** The definition ids that were missing, so the misconfiguration is nameable rather than a count. */
  unregisteredDefinitionIds: readonly string[];
  /** Families skipped wholesale because this source cannot evaluate them (errata Section 1). */
  familiesBlockedByDataReadiness: readonly PatternFamily[];
}

export interface DetectPatternIntelligenceDependencies {
  definitions: PatternDefinitionRegistry;
  ledger: PatternObservationLedger;
  /**
   * Required, deliberately.
   *
   * Errata Section 7 has the orchestrator record coverage for *every* evaluated window, and an
   * optional dependency cannot deliver that: forgetting to pass it produced no marker and no error,
   * so the absence of a coverage row would mean either "never evaluated" or "evaluated by a caller
   * that omitted the recorder" — reintroducing exactly the ambiguity the record exists to remove.
   * A caller that genuinely wants no persistence can pass a no-op, but it has to say so.
   */
  coverage: PatternCoverageRecorder;
}

export class DetectPatternIntelligence {
  private readonly sweepEngine = new SweepReclaimEngine();
  private readonly breakoutEngine = new BreakoutStateEngine();
  private readonly compressionEngine = new CompressionExpansionEngine();
  private readonly openingEngine = new OpeningStructureEngine();
  private readonly gapEngine = new GapStructureEngine();
  private readonly levelEngine = new LevelInteractionEngine();
  private readonly swingEngine = new SwingStructureEngine();
  private readonly effortEngine = new EffortResultEngine();
  private readonly candleEngine = new CandleGeometryEngine();
  private readonly multiCandleEngine = new MultiCandleEngine();
  private readonly reversalEngine = new ClassicalReversalEngine();
  private readonly continuationEngine = new ContinuationStructureEngine();

  constructor(private readonly dependencies: DetectPatternIntelligenceDependencies) {}

  async execute(input: DetectPatternIntelligenceInput): Promise<DetectPatternIntelligenceResult> {
    const { candles, source } = input;
    if (candles.length === 0) {
      return {
        candlesEvaluated: 0,
        patternsDetected: 0,
        patternsRecorded: 0,
        observations: [],
        candidatesRefusedBeforeWarmup: 0,
        candidatesRefusedOutsideSession: 0,
        candidatesRefusedStaleBar: 0,
        candidatesRefusedUnregistered: 0,
        unregisteredDefinitionIds: [],
        familiesBlockedByDataReadiness: [],
      };
    }

    let candidatesRefusedBeforeWarmup = 0;
    let candidatesRefusedOutsideSession = 0;
    let candidatesRefusedStaleBar = 0;
    let candidatesRefusedUnregistered = 0;
    const unregisteredDefinitionIds = new Set<string>();
    const familiesBlockedByDataReadiness: PatternFamily[] = [];

    const atrSeries = calculateAtrSeries(candles, atrPeriod);
    const closePrices = candles.map((c) => c.close);
    const ema20Series = calculateEmaSeries(closePrices, 20);

    const engineVersion = input.engineVersion ?? "pi-v1.0.1";
    const configVersion = input.configVersion ?? "1.0.0";
    const configHash = input.configHash ?? "0".repeat(64);

    // Nominal bar spacing, for the contiguity half of the frozen-tape test in `isStaleBar`. Hoisted
    // because it is a constant of the whole run, not of a candidate.
    const barIntervalMs = timeframeDurationMs(source.timeframe);

    const detectedObservations: { observation: AnyDetectedPattern; initialEvent: PatternLifecycleEvent }[] = [];

    // Helper to construct, validate, and queue an observation
    const queueCandidate = <F extends keyof import("../domain/contracts.js").PatternDetailsMap>(
      family: F,
      subtype: import("../domain/contracts.js").PatternDetailsMap[F]["subtype"],
      orientation: import("../domain/contracts.js").PatternOrientation,
      startIndex: number,
      detectedIndex: number,
      patternHigh: number,
      patternLow: number,
      details: import("../domain/contracts.js").PatternDetailsMap[F],
      definitionRef: PatternDefinitionRef,
    ) => {
      const startCandle = candles[startIndex]!;
      const detectedCandle = candles[detectedIndex]!;
      const durationBars = detectedIndex - startIndex + 1;

      /*
       * The strict non-emission rule (errata Section 3).
       *
       * The line this replaces was `atrSeries[detectedIndex] ?? (patternHigh - patternLow)`, which
       * substituted the pattern's own range for an unavailable ATR. That did not produce a missing
       * value or even a zero — it produced `rangeAtr` of exactly 1.0, a wholly plausible "one ATR
       * wide" reading that no downstream consumer could distinguish from a measurement, frozen into
       * observationHash. Refusing to emit is the only option that leaves no fabricated number behind.
       */
      const currentAtr = atrSeries[detectedIndex];
      if (detectedIndex + 1 < minimumClosedBarsForEmission || currentAtr === null || currentAtr === undefined || !(currentAtr > 0)) {
        candidatesRefusedBeforeWarmup++;
        return;
      }

      // A bar outside the observable session has no defined segment. Previously anything at or after
      // 14:00 IST — including a 22:00 bar from a bad backfill — was silently labelled CLOSING.
      if (sessionSegmentOf(detectedCandle.openTime, source.instrumentType) === null) {
        candidatesRefusedOutsideSession++;
        return;
      }

      /*
       * A bar that republished the previous print, or reported nothing at all, is not an observation.
       *
       * The index feed freezes for 15:16-15:29 IST daily from 2026-08-03, emitting bars whose OHLC
       * are one repeated constant. The volume guard nulls the volume statistics on those, but the
       * structural families kept emitting — chiefly COMPRESSION_EXPANSION, because a flat bar is
       * trivially an inside bar, so a run of them manufactures inside-bar chains out of a stalled
       * feed.
       *
       * The predecessor is threaded in because the freeze no longer carries zero volume: the feed now
       * stamps constituent volume on the pinned price, so only value repetition can detect it. See
       * `bar-integrity.ts`.
       */
      if (isStaleBar(detectedCandle, {
        previous: candles[detectedIndex - 1] ?? null,
        intervalMs: barIntervalMs,
      })) {
        candidatesRefusedStaleBar++;
        return;
      }

      const geometry = calculatePatternGeometry({
        durationBars,
        patternHigh,
        patternLow,
        atrAtDetected: currentAtr,
      });

      const context = calculatePatternContext(candles, detectedIndex, atrSeries, ema20Series, source.instrumentType);

      const observationId = randomUUID();
      const detectedAt = detectedCandle.openTime;
      const dataThrough = detectedCandle.openTime;
      const knownAt = new Date(Math.max(detectedAt.getTime(), source.dataVintageAt.getTime()));

      /*
       * The first bar open at which this observation could actually be acted on.
       *
       * The previous derivation added the *previous* bar's duration to the detection time, which
       * breaks in two ways. Across a session boundary the gap between consecutive bars is the
       * overnight close, so a pattern detected on the first bar of a session was stamped executable
       * roughly eighteen hours after the fact — and on a multi-day series that is every session, not
       * an edge case. It also ignored `knownAt`: when the data vintage lands after the following bar
       * opens, that bar was already unexecutable.
       *
       * Scanning forward for the first bar that opens strictly after `knownAt` answers both. The
       * candle series is ground truth about when the next bar actually opened, including across a
       * weekend or a holiday, which no duration arithmetic can reproduce. The duration fallback
       * applies only when the following bar is not in the supplied window.
       */
      let earliestExecutionAt: Date | null = null;
      for (let j = detectedIndex + 1; j < candles.length; j++) {
        const openTime = candles[j]!.openTime;
        if (openTime.getTime() > knownAt.getTime()) { earliestExecutionAt = openTime; break; }
      }
      if (earliestExecutionAt === null) {
        earliestExecutionAt = new Date(knownAt.getTime() + timeframeDurationMs(source.timeframe));
      }

      /*
       * Typed at the specific family rather than the union.
       *
       * Assigning this literal straight to `AnyDetectedPattern` does not typecheck: with a generic
       * `F`, TypeScript cannot prove the literal matches any single member of the union, so it
       * reports a mismatch against an arbitrary one (`MULTI_CANDLE`). Building at `DetectedPatternV2<F>`
       * keeps `details` and `patternSubtype` genuinely checked against the family — the previous
       * `as any` on both silently disabled exactly the check that would have caught a details/family
       * mismatch — and the widening to the union happens once, at the push.
       */
      const rawObservation: DetectedPatternV2<F> = {
        identity: {
          observationId,
          patternFamily: family,
          patternSubtype: subtype as SubtypeOf<F>,
          orientation,
        },
        source,
        definitionRef,
        timing: {
          startAt: startCandle.openTime,
          dataThrough,
          detectedAt,
          knownAt,
          earliestExecutionAt,
        },
        geometry,
        context,
        details,
        provenance: {
          engineVersion,
          configVersion,
          configHash,
          dataSource: source.dataVintageId.split(":")[0] ?? "market-feed",
          dataSchemaVersion: "1.0",
          observationHash: "",
        },
      };

      const eventId = randomUUID();
      const initialEvent: PatternLifecycleEvent = {
        eventId,
        eventSchemaVersion: "1.0",
        observationId,
        eventType: "DETECTED",
        dataThrough,
        eventTime: detectedAt,
        knownAt,
        sequenceNumber: 1,
        idempotencyKey: lifecycleIdempotencyKey(observationId, "DETECTED", dataThrough),
        cause: null,
      };

      detectedObservations.push({ observation: rawObservation as AnyDetectedPattern, initialEvent });
    };

    /*
     * One definition per family, not per subtype.
     *
     * These ids were previously minted from the subtype (`sweep-reclaim-spring`, `candle-hammer`,
     * ...), which meant ~150 synthetic ids for 12 detectors and no record any registry actually held.
     * `PatternDefinition.family` is a PatternFamily and the Implementation Gate speaks of definitions
     * "for each family", so the family id is the real key and per-subtype thresholds live inside the
     * frozen record's parameters. The subtype is already carried on identity.patternSubtype.
     */
    const defRefFor = (family: PatternFamily): PatternDefinitionRef => ({
      definitionId: definitionIdForFamily(family) ?? `pattern-intelligence.unregistered-${family.toLowerCase()}`,
      definitionVersion: "1.0.0",
      // Filled from the frozen record at persist time; a mismatch is rejected by recordDetectedPattern.
      definitionHash: "",
    });

    // 1. Sweep Reclaim
    const sweepCandidates = this.sweepEngine.detect(candles, input.referenceLevels);
    for (const sc of sweepCandidates) {
      const defRef = defRefFor("SWEEP_RECLAIM");
      const details: SweepReclaimDetails = {
        kind: "SWEEP_RECLAIM",
        subtype: sc.subtype,
        wyckoffEquivalent: sc.wyckoffEquivalent,
        referenceLevel: sc.referenceLevel,
        penetrationExcursionBps: sc.penetrationExcursionBps,
        reclaimDistanceBps: sc.reclaimDistanceBps,
        rejectionWickBps: sc.rejectionWickBps,
      };
      queueCandidate("SWEEP_RECLAIM", sc.subtype, sc.orientation, sc.startIndex, sc.detectedIndex, sc.patternHigh, sc.patternLow, details, defRef);
    }

    // 2. Breakout State
    const breakoutCandidates = this.breakoutEngine.detect(candles);
    for (const bc of breakoutCandidates) {
      const defRef = defRefFor("BREAKOUT_STATE");
      queueCandidate("BREAKOUT_STATE", bc.subtype, bc.orientation, bc.startIndex, bc.detectedIndex, bc.patternHigh, bc.patternLow, {
        kind: "BREAKOUT_STATE",
        subtype: bc.subtype,
        breakoutLevel: bc.breakoutLevel,
        breakoutDistanceBps: bc.breakoutDistanceBps,
      }, defRef);
    }

    // 3. Compression / Expansion
    const compCandidates = this.compressionEngine.detect(candles);
    for (const cc of compCandidates) {
      const defRef = defRefFor("COMPRESSION_EXPANSION");
      queueCandidate("COMPRESSION_EXPANSION", cc.subtype, cc.orientation, cc.startIndex, cc.detectedIndex, cc.patternHigh, cc.patternLow, {
        kind: "COMPRESSION_EXPANSION",
        subtype: cc.subtype,
        compressionRatio: cc.compressionRatio,
        vcpContractionCount: cc.vcpContractionCount,
      }, defRef);
    }

    // 4. Opening Structure
    const openingCandidates = this.openingEngine.detect(candles);
    for (const oc of openingCandidates) {
      const defRef = defRefFor("OPENING_STRUCTURE");
      queueCandidate("OPENING_STRUCTURE", oc.subtype, oc.orientation, oc.startIndex, oc.detectedIndex, oc.patternHigh, oc.patternLow, {
        kind: "OPENING_STRUCTURE",
        subtype: oc.subtype,
        openingRangeHigh: oc.openingRangeHigh,
        openingRangeLow: oc.openingRangeLow,
        openingRangeBps: oc.openingRangeBps,
      }, defRef);
    }

    // 5. Gap Structure
    if (input.referenceLevels?.pdh !== undefined && input.referenceLevels?.pdl !== undefined && input.referenceLevels?.pdc !== undefined) {
      const gapCandidates = this.gapEngine.detect(candles, atrSeries, {
        pdh: input.referenceLevels.pdh,
        pdl: input.referenceLevels.pdl,
        pdc: input.referenceLevels.pdc,
      });
      for (const gc of gapCandidates) {
        const defRef = defRefFor("GAP_STRUCTURE");
        queueCandidate("GAP_STRUCTURE", gc.subtype, gc.orientation, gc.startIndex, gc.detectedIndex, gc.patternHigh, gc.patternLow, {
          kind: "GAP_STRUCTURE",
          subtype: gc.subtype,
          gapBps: gc.gapBps,
          gapVsAtr: gc.gapVsAtr,
          gapDirectionVsPriorRange: gc.gapDirectionVsPriorRange,
          priorDayHigh: gc.priorDayHigh,
          priorDayLow: gc.priorDayLow,
        }, defRef);
      }
    }

    // 6. Level Interaction
    if (input.referenceLevels) {
      const levels = [];
      if (input.referenceLevels.pdh) levels.push({ type: "PDH" as const, value: input.referenceLevels.pdh });
      if (input.referenceLevels.pdl) levels.push({ type: "PDL" as const, value: input.referenceLevels.pdl });
      if (input.referenceLevels.pdc) levels.push({ type: "PRIOR_CLOSE" as const, value: input.referenceLevels.pdc });

      const levelCandidates = this.levelEngine.detect(candles, levels);
      for (const lc of levelCandidates) {
        const defRef = defRefFor("LEVEL_INTERACTION");
        queueCandidate("LEVEL_INTERACTION", lc.subtype, lc.orientation, lc.startIndex, lc.detectedIndex, lc.patternHigh, lc.patternLow, {
          kind: "LEVEL_INTERACTION",
          subtype: lc.subtype,
          levelType: lc.levelType,
          levelValue: lc.levelValue,
          distanceBps: lc.distanceBps,
        }, defRef);
      }
    }

    // 7. Swing Structure
    const swingCandidates = this.swingEngine.detect(candles);
    for (const sc of swingCandidates) {
      const defRef = defRefFor("SWING_STRUCTURE");
      queueCandidate("SWING_STRUCTURE", sc.subtype, sc.orientation, sc.startIndex, sc.detectedIndex, sc.patternHigh, sc.patternLow, {
        kind: "SWING_STRUCTURE",
        subtype: sc.subtype,
        swingLevel: sc.swingLevel,
        priorSwingLevel: sc.priorSwingLevel,
      }, defRef);
    }

    /*
     * 8. Effort Result — gated by data readiness, not merely by whether the engine runs.
     *
     * Errata Section 1 marks EFFORT_RESULT **BLOCKED (PARTIAL)**: it needs exchange-traded volume
     * semantics rather than a cash tick-volume proxy. An index carries no traded volume of its own —
     * the figure stamped on a NIFTY50 or BANKNIFTY bar is an aggregate of constituent cash activity
     * (correlation 0.877 with summed constituent volume, and no expiry-day spike). Wyckoff
     * effort/result reads a climax as absorption by a counterparty at a price level; a constituent
     * aggregate cannot mean that.
     *
     * Leaving the engine wired and unconditional would have written observations for a family the
     * frozen taxonomy says cannot be evaluated yet, which is precisely the kind of contradiction the
     * definition registry exists to prevent. FUTIDX has genuine traded volume, so the family is
     * evaluable there and stays enabled.
     */
    const effortCandidates = source.instrumentType === "FUTIDX" ? this.effortEngine.detect(candles) : [];
    if (source.instrumentType !== "FUTIDX") familiesBlockedByDataReadiness.push("EFFORT_RESULT");
    for (const ec of effortCandidates) {
      const defRef = defRefFor("EFFORT_RESULT");
      queueCandidate("EFFORT_RESULT", ec.subtype, ec.orientation, ec.startIndex, ec.detectedIndex, ec.patternHigh, ec.patternLow, {
        kind: "EFFORT_RESULT",
        subtype: ec.subtype,
        climaxVolumeMultiplier: ec.climaxVolumeMultiplier,
        absorptionWickRatio: ec.absorptionWickRatio,
      }, defRef);
    }

    // 9. Candle Geometry (Tier C)
    const candleCandidates = this.candleEngine.detect(candles);
    for (const cgc of candleCandidates) {
      const defRef = defRefFor("CANDLE_GEOMETRY");
      queueCandidate("CANDLE_GEOMETRY", cgc.subtype, cgc.orientation, cgc.startIndex, cgc.detectedIndex, cgc.patternHigh, cgc.patternLow, {
        kind: "CANDLE_GEOMETRY",
        subtype: cgc.subtype,
      }, defRef);
    }

    // 10. Multi Candle (Tier C)
    const multiCandidates = this.multiCandleEngine.detect(candles);
    for (const mc of multiCandidates) {
      const defRef = defRefFor("MULTI_CANDLE");
      queueCandidate("MULTI_CANDLE", mc.subtype, mc.orientation, mc.startIndex, mc.detectedIndex, mc.patternHigh, mc.patternLow, {
        kind: "MULTI_CANDLE",
        subtype: mc.subtype,
      }, defRef);
    }

    // 11. Classical Reversal (Tier C)
    const reversalCandidates = this.reversalEngine.detect(candles);
    for (const rc of reversalCandidates) {
      const defRef = defRefFor("CLASSICAL_REVERSAL");
      queueCandidate("CLASSICAL_REVERSAL", rc.subtype, rc.orientation, rc.startIndex, rc.detectedIndex, rc.patternHigh, rc.patternLow, {
        kind: "CLASSICAL_REVERSAL",
        subtype: rc.subtype,
        necklineLevel: rc.necklineLevel,
      }, defRef);
    }

    // 12. Continuation Structure (Tier B)
    const contCandidates = this.continuationEngine.detect(candles);
    for (const cc of contCandidates) {
      const defRef = defRefFor("CONTINUATION_STRUCTURE");
      queueCandidate("CONTINUATION_STRUCTURE", cc.subtype, cc.orientation, cc.startIndex, cc.detectedIndex, cc.patternHigh, cc.patternLow, {
        kind: "CONTINUATION_STRUCTURE",
        subtype: cc.subtype,
      }, defRef);
    }

    // Persist all queued observations atomically with their sequence-1 DETECTED event
    const recordedObservations: AnyDetectedPattern[] = [];

    for (const item of detectedObservations) {
      const definition = await this.dependencies.definitions.findFrozen({
        definitionId: item.observation.definitionRef.definitionId,
        definitionVersion: item.observation.definitionRef.definitionVersion,
      });

      /*
       * An unregistered definition is the Implementation Gate doing its job — but it must be
       * counted, not silently swallowed.
       *
       * This branch previously dropped the candidate with no record of it. That makes a registry
       * misconfiguration — a renamed id, an unregistered family, a version bump applied to the
       * engine but not the record — indistinguishable from a genuinely quiet market, which is the
       * same ambiguity-of-absence failure the coverage marker exists to close. Refusing to persist
       * is correct; refusing silently is not.
       */
      if (!definition) {
        candidatesRefusedUnregistered++;
        unregisteredDefinitionIds.add(item.observation.definitionRef.definitionId);
        continue;
      }

      item.observation.definitionRef.definitionHash = definition.definitionHash;
      recordedObservations.push(await recordDetectedPattern(item, this.dependencies));
    }

    /*
     * The coverage marker is written after the pass, unconditionally — including when nothing was
     * found and when everything was refused.
     *
     * That is the entire point: a window with zero observations and a window never evaluated are
     * otherwise identical to every downstream reader. Writing only on a non-empty result would
     * reproduce the defect the record exists to close.
     *
     * It is deliberately not inside the ledger transaction. Coverage asserts "the detectors ran
     * here", which stays true regardless of how many observations the pass produced, and binding it
     * to an observation write would make it unwritable for precisely the empty window that most needs
     * it. A failure to record coverage is therefore allowed to surface rather than roll back
     * observations that were legitimately persisted.
     */
    await this.dependencies.coverage.recordCoverage({
      coverageId: randomUUID(),
      source,
      fromTime: candles[0]!.openTime,
      toTime: candles[candles.length - 1]!.openTime,
      candlesEvaluated: candles.length,
      patternsFound: recordedObservations.length,
      recordedAt: source.dataVintageAt,
      engineVersion,
    });

    return {
      candlesEvaluated: candles.length,
      patternsDetected: detectedObservations.length,
      patternsRecorded: recordedObservations.length,
      observations: recordedObservations,
      candidatesRefusedBeforeWarmup,
      candidatesRefusedOutsideSession,
      candidatesRefusedStaleBar,
      candidatesRefusedUnregistered,
      unregisteredDefinitionIds: [...unregisteredDefinitionIds],
      familiesBlockedByDataReadiness,
    };
  }
}
