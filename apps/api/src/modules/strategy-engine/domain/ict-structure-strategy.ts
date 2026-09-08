import type {
  EnsureStrategyVersionInput,
  ProposedTradeIdea,
  StrategyMarketContext,
  TradeIdeaEvidence,
} from "./strategy.js";
import type { StrategyEvaluator } from "./strategy-registry.js";
import { ICT_STRUCTURE_STRATEGY_KEY } from "../../technical-analysis/domain/ict/config.js";
import type { OrderBlockKind } from "../../technical-analysis/domain/ict/zones.js";
import { istMinuteOfDay } from "../../platform/calendar/trading-session.js";

/**
 * Which point of interest wins when several are available on the same bar.
 *
 * `SWEEP_FIRST` is the incumbent and reaches an order block almost never: measured over
 * 2025-01-01..2026-09-05 on BANKNIFTY 15m, 1,045 of 1,222 entries came from a fair value gap and
 * 141 from a session sweep, leaving 36 from a block of any kind. `BLOCK_FIRST` puts the block ahead
 * of the gap, which is the order the doctrine states.
 */
export type IctPoiPreference = "SWEEP_FIRST" | "BLOCK_FIRST";

/**
 * Killzone windows as IST minutes-of-day, half-open [from, to).
 *
 * Fixed in docs/2026-09-08-ict-entry-model-falsification-program.md BEFORE measurement, so they are
 * not tunable here. The first two are contiguous by construction; together the three admit 225 of a
 * 375-minute session and exclude 150 (40%).
 */
const KILLZONE_WINDOWS: readonly { readonly name: string; readonly from: number; readonly to: number }[] = [
  { name: "OPEN_DRIVE", from: 9 * 60 + 15, to: 10 * 60 + 15 },
  { name: "LATE_MORNING", from: 10 * 60 + 15, to: 11 * 60 + 30 },
  { name: "AFTERNOON", from: 13 * 60, to: 14 * 60 + 30 },
];

function killzoneAt(instant: Date): string | null {
  const minute = istMinuteOfDay(instant);
  for (const w of KILLZONE_WINDOWS) {
    if (minute >= w.from && minute < w.to) return w.name;
  }
  return null;
}

/**
 * Whether price sits in the 62-79% retracement of the dealing range -- the optimal trade entry.
 *
 * For a long that is the DEEP end of discount: 62-79% back off the range high is 21-38% up from the
 * range low. Mirrored for a short.
 *
 * Registered as `entryPlacement` and implemented as a FILTER, not as placement. See the amendment in
 * the program document: the backtester enters at the next candle's open and cannot rest a limit
 * order at a level, so "enter AT the OTE" is not expressible. This asks instead whether the signal
 * bar is already inside the band, which is a strictly weaker claim.
 */
function isWithinOte(price: number, rangeLow: number, rangeHigh: number, isBullish: boolean): boolean {
  const span = rangeHigh - rangeLow;
  if (span <= 0) return false;
  const near = isBullish ? rangeLow + span * 0.21 : rangeLow + span * 0.62;
  const far = isBullish ? rangeLow + span * 0.38 : rangeLow + span * 0.79;
  return price >= near && price <= far;
}

export interface IctStructureStrategyConfiguration {
  minimumRiskReward: number;
  minConfidence: number;
  expiryCandles: number;
  requirePoiReaction: boolean;
  /** Entry-model arm 1. Defaults to the incumbent order, so an unconfigured run is unchanged. */
  poiPreference: IctPoiPreference;
  /** Entry-model arm 2. Restricts entries to the pre-registered killzone windows. */
  requireKillzone: boolean;
  /** Entry-model arm 3. Requires the signal bar to sit inside the 62-79% retracement. */
  requireOte: boolean;
}

export const defaultIctStructureStrategyConfiguration: IctStructureStrategyConfiguration = {
  minimumRiskReward: 1.2,
  minConfidence: 0.7,
  expiryCandles: 3,
  requirePoiReaction: true,
  /*
   * All three entry-model arms default OFF, so every arm is exactly one configuration key away from
   * its own control and a paired same-bar delta is available for Gate 4.
   */
  poiPreference: "SWEEP_FIRST",
  requireKillzone: false,
  requireOte: false,
};

/**
 * What version 2 was REGISTERED with, pinned as its own literal.
 *
 * A stored version's configuration is immutable, and a partial unique index allows one active
 * version per strategy -- so widening the default object made `ensure` refuse, and bumping to v3
 * would have needed v2 deactivated, a write to a row live paper trading may reference. Neither is
 * necessary: `evaluate` merges the stored configuration over the CODE defaults, so keys added later
 * are supplied by the defaults and the stored record keeps saying exactly what v2 was created with.
 *
 * Do not "tidy" this back into a reference to `defaultIctStructureStrategyConfiguration`. The two
 * are meant to drift: one is a historical record, the other is current code.
 */
const registeredV2Configuration = {
  minimumRiskReward: 1.2,
  minConfidence: 0.7,
  expiryCandles: 3,
  requirePoiReaction: true,
};

export const ictStructureStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: ICT_STRUCTURE_STRATEGY_KEY,
  name: "ICT Structural Alignment (V1)",
  description: "Four-pillar structural strategy strictly trading in alignment with the higher-timeframe trend.",
  version: 2,
  configuration: registeredV2Configuration as unknown as Record<string, unknown>,
};
export class IctStructureStrategy implements StrategyEvaluator {
  evaluate(context: StrategyMarketContext, strategyConfiguration: Record<string, unknown> = {}): ProposedTradeIdea[] {
    const config: IctStructureStrategyConfiguration = {
      ...defaultIctStructureStrategyConfiguration,
      ...strategyConfiguration,
    };

    const ict = context.ictSnapshot;
    if (!ict) return [];

    const { structure, zones, sessionLevels, bias, liquidity, coverage } = ict;

    // Pillar Gate 1: every coverage input must be COMPLETE. Both UNKNOWN
    // (evidence absent/ambiguous) and NOT_COVERED (engine never ran) fail
    // closed — missing or ambiguous state is never treated as permission.
    if (
      coverage.structure !== "COMPLETE" ||
      coverage.bias !== "COMPLETE" ||
      coverage.zones !== "COMPLETE" ||
      coverage.sessionLevels !== "COMPLETE" ||
      coverage.liquidity !== "COMPLETE" ||
      coverage.htf !== "COMPLETE"
    ) {
      return [];
    }

    // Pillar Gate 2: Directional Alignment (bias + structure agree)
    const isBullish = bias.bias === "BULLISH" && structure.trend === "BULLISH";
    const isBearish = bias.bias === "BEARISH" && structure.trend === "BEARISH";
    if (!isBullish && !isBearish) return [];

    /*
     * There is no separate fractal-alignment gate any more, and its removal is the point.
     *
     * It compared `ict.htfBias` against `bias.bias`. Now that bias is SOURCED from the
     * higher-timeframe read (see bias.ts), those two are the same value, so the comparison could
     * only ever pass -- swapping a circular gate for a tautological one. Gate 2 above is the real
     * alignment test: the higher-timeframe narrative against the execution-timeframe structure.
     *
     * The fractal pillar is still *required*: `coverage.htf` must be COMPLETE in Gate 1, so a bar
     * with no higher-timeframe evidence produces nothing. What is gone is the redundant equality
     * check, not the requirement.
     *
     * The dead `higherTimeframeContexts["15m"]` branch went with it. Nothing in production ever
     * populated that key -- the research harness attaches "5m" and only to the 1m reference context.
     *
     * What remains below is a CONSISTENCY guard, not a pillar. Since bias is sourced from the
     * higher-timeframe read and a sweep may now only confirm it, a snapshot whose bias contradicts
     * its own `htfBias` is malformed and cannot be produced by the engine. Refusing it keeps the
     * fail-closed invariant against a hand-built or future-constructed snapshot rather than trusting
     * that the two can never disagree.
     */
    if (ict.htfBias && ict.htfBias !== bias.bias) return [];

    // Pillar Gate 3: Liquidity Status
    if (isBullish && liquidity.alignmentStatus !== "ALIGNED_LONG") return [];
    if (isBearish && liquidity.alignmentStatus !== "ALIGNED_SHORT") return [];

    const targetPool = liquidity.primaryTarget;
    if (!targetPool) return [];

    // POI interaction check (mitigation of OB, FVG, or session sweep)
    const currentPrice = context.candle.close;
    let poiEvidence: string | null = null;

    /*
     * The POI test used to accept ANY zone in state TOUCHED and ANY FVG with fillPercentage > 0,
     * with no check that the zone even faced the right way. It therefore never rejected anything:
     * measured over 45 days it passed every single pillar-aligned bar on both indices (`noPoi: 0`),
     * so `requirePoiReaction` was free.
     *
     * The discriminators were already being computed and thrown away. `OrderBlock` carries
     * `meanThreshold`, `isExtreme` and `isIdmAdjacent`; `FairValueGap` carries `midpoint`, the
     * consequent encroachment. Lecture 7 is explicit that the entry is taken AT the mean threshold
     * ("ये ऑर्डर ब्लॉक का मैं मीन थ्रेसहोल्ड लेता हूं"), not on first contact with the edge.
     *
     * Three requirements now, each straight from the source:
     *   1. the zone must face the trade -- a BULLISH zone for a long. A touched bearish order block
     *      is evidence against a long, and it used to count for one.
     *   2. an order block must be traded INTO its mean threshold, not merely touched.
     *   3. a fair value gap must be traded into its midpoint (CE), not merely broken by any amount.
     *
     * `isExtreme` and `isIdmAdjacent` are recorded rather than gated on. Lecture 7 pairs the extreme
     * order block with the long targets, which is the pairing this strategy now takes after the
     * liquidity-objective fix -- but that is a hypothesis to measure, so it travels as evidence
     * instead of silently narrowing the population.
     */
    const wantedZone: "BULLISH" | "BEARISH" = isBullish ? "BULLISH" : "BEARISH";
    const barLow = context.candle.low;
    const barHigh = context.candle.high;
    const reached = (level: number): boolean =>
      isBullish ? barLow <= level : barHigh >= level;

    /*
     * Entry-model arm 2: killzone.
     *
     * Placed AFTER the pillar gates and BEFORE the point-of-interest search, deliberately. A time
     * window is a property of the bar, not of the setup, so putting it here means the arm and its
     * control see the same candidate bars and differ only in which of them are admitted -- the
     * paired comparison Gate 4 asks for. Sited any later and it would be filtering an already
     * filtered population.
     */
    const killzone = killzoneAt(context.candle.openTime);
    if (config.requireKillzone && killzone === null) return [];

    /*
     * Entry-model arm 3: optimal trade entry.
     *
     * Needs the dealing range, and refuses when there is none rather than passing: an OTE band
     * without a range is not a wide band, it is an unanswered question.
     */
    let oteOk = true;
    if (config.requireOte) {
      const range = bias.dealingRange;
      oteOk = range !== null && isWithinOte(currentPrice, range.rangeLow, range.rangeHigh, isBullish);
      if (!oteOk) return [];
    }

    let poiExtreme = false;
    let poiIdmAdjacent = false;
    /*
     * Which lecture-7 block type supplied the entry, recorded but NOT gated on.
     *
     * The taxonomy claims these are different setups -- a mitigation block continues, a breaker
     * reverses -- so the label has to be measurable per trade before any of that can be tested. It
     * stays a covariate until it separates outcomes.
     */
    let poiKind: OrderBlockKind | "FVG" | "SESSION_SWEEP" | null = null;

    if (config.requirePoiReaction) {
      /*
       * Entry-model arm 1: which point of interest wins.
       *
       * Both candidates are resolved before either is chosen, so the ordering is the only thing the
       * arm changes. Resolving them is side-effect free, so `SWEEP_FIRST` remains byte-identical to
       * the incumbent short-circuit.
       */
      const sweptSessionLevel = sessionLevels.lastSweepEvent?.eventType === "SWEEP"
        ? sessionLevels.lastSweepEvent.levelType
        : null;
      /*
       * Matching on `type` is now correct for both zone kinds: a failed block and an inverted gap
       * each re-enter the ledger as a NEW zone carrying the flipped type, dated to the bar the
       * inversion happened on. Reading the mutable `state` to work the side out here would read the
       * future, because the ledger hands out live zone objects and the backtest builds every
       * snapshot before replaying any of it.
       */
      const ob = zones.activeObs.find((o) => o.type === wantedZone && reached(o.meanThreshold));
      const fvg = zones.activeFvgs.find((f) => f.type === wantedZone && reached(f.midpoint));

      const takeBlock = (): boolean => {
        if (!ob) return false;
        poiEvidence = `Order Block ${ob.id} traded into its mean threshold ${ob.meanThreshold}`;
        poiExtreme = ob.isExtreme;
        poiIdmAdjacent = ob.isIdmAdjacent;
        poiKind = ob.kind;
        return true;
      };
      const takeGap = (): boolean => {
        if (!fvg) return false;
        poiEvidence = `Fair Value Gap ${fvg.id} traded into its consequent encroachment ${fvg.midpoint}`;
        poiKind = "FVG";
        return true;
      };
      const takeSweep = (): boolean => {
        if (sweptSessionLevel === null) return false;
        poiEvidence = `Session ${sweptSessionLevel} swept and reclaimed`;
        poiKind = "SESSION_SWEEP";
        return true;
      };

      const order = config.poiPreference === "BLOCK_FIRST"
        ? [takeBlock, takeGap, takeSweep]
        : [takeSweep, takeBlock, takeGap];
      for (const take of order) {
        if (take()) break;
      }

      if (!poiEvidence) {
        return [];
      }
    }

    // Trade Geometry
    const entryPrice = currentPrice;
    let stopLoss: number;
    let targetPrice: number;
    let side: "LONG" | "SHORT";

    if (isBullish) {
      side = "LONG";
      const rawStop = liquidity.invalidationLevel ?? (entryPrice * 0.995);
      stopLoss = rawStop * 0.9995; // 0.05% volatility buffer
      targetPrice = targetPool.price;

      if (stopLoss >= entryPrice || targetPrice <= entryPrice) return [];
      const risk = entryPrice - stopLoss;
      const reward = targetPrice - entryPrice;
      const riskReward = Number((reward / risk).toFixed(2));
      if (riskReward < config.minimumRiskReward) return [];

      const evidence: TradeIdeaEvidence[] = [
        {
          sourceType: "STRATEGY",
          sourceReference: "PILLAR_STACK",
          label: "Four-Pillar ICT Long Alignment",
          contribution: 0.4,
          details: {
            bias: bias.bias,
            structureTrend: structure.trend,
            dealingRangeEq: bias.dealingRange?.equilibrium,
            template: bias.dailyTemplate,
          },
        },
        {
          sourceType: "STRATEGY",
          sourceReference: "LIQUIDITY_TARGET",
          label: `Targeting ERL ${targetPool.kind}`,
          contribution: 0.35,
          details: {
            targetPrice: targetPool.price,
            intermediateTarget: liquidity.intermediateTarget,
          },
        },
      ];

      if (poiEvidence) {
        evidence.push({
          sourceType: "STRATEGY",
          sourceReference: "POI_CONFIRMATION",
          label: poiEvidence,
          contribution: 0.25,
          // Recorded, not gated on: lecture 7 pairs the EXTREME order block with the long
          // targets this strategy now takes, so these two flags are the covariates that
          // hypothesis needs before anyone narrows the population on it.
          details: { poiEvidence, poiExtreme, poiIdmAdjacent, poiKind, killzone },
        });
      }

      const expiresAt = new Date(
        context.candle.closeTime.getTime() + config.expiryCandles * 5 * 60_000
      );

      return [
        {
          side,
          entryPrice,
          stopLoss,
          targetPrice,
          riskReward,
          confidence: Math.max(config.minConfidence, 0.75),
          reasoning: [
            `Four-Pillar ICT LONG alignment: ${bias.bias} bias, ${structure.trend} trend, ${bias.dailyTemplate} template.`,
            `Targeting ERL ${targetPool.kind} at ${targetPrice.toFixed(2)}, invalidation beyond ${stopLoss.toFixed(2)}.`,
            poiEvidence ? `POI confirmation: ${poiEvidence}.` : "POI reaction verified.",
            `Risk-Reward ratio: ${riskReward.toFixed(2)}R.`,
          ],
          evidence: {
            strategy: ICT_STRUCTURE_STRATEGY_KEY,
            engineVersion: ict.engineVersion,
            configHash: ict.configHash,
            bias: bias.bias,
            structureTrend: structure.trend,
            targetPoolKind: targetPool.kind,
            targetPrice,
            stopLoss,
            poiEvidence,
          },
          expiresAt,
          evidenceItems: evidence,
        },
      ];
    } else {
      side = "SHORT";
      const rawStop = liquidity.invalidationLevel ?? (entryPrice * 1.005);
      stopLoss = rawStop * 1.0005; // 0.05% volatility buffer
      targetPrice = targetPool.price;

      if (stopLoss <= entryPrice || targetPrice >= entryPrice) return [];
      const risk = stopLoss - entryPrice;
      const reward = entryPrice - targetPrice;
      const riskReward = Number((reward / risk).toFixed(2));
      if (riskReward < config.minimumRiskReward) return [];

      const evidence: TradeIdeaEvidence[] = [
        {
          sourceType: "STRATEGY",
          sourceReference: "PILLAR_STACK",
          label: "Four-Pillar ICT Short Alignment",
          contribution: 0.4,
          details: {
            bias: bias.bias,
            structureTrend: structure.trend,
            dealingRangeEq: bias.dealingRange?.equilibrium,
            template: bias.dailyTemplate,
          },
        },
        {
          sourceType: "STRATEGY",
          sourceReference: "LIQUIDITY_TARGET",
          label: `Targeting ERL ${targetPool.kind}`,
          contribution: 0.35,
          details: {
            targetPrice: targetPool.price,
            intermediateTarget: liquidity.intermediateTarget,
          },
        },
      ];

      if (poiEvidence) {
        evidence.push({
          sourceType: "STRATEGY",
          sourceReference: "POI_CONFIRMATION",
          label: poiEvidence,
          contribution: 0.25,
          // Recorded, not gated on: lecture 7 pairs the EXTREME order block with the long
          // targets this strategy now takes, so these two flags are the covariates that
          // hypothesis needs before anyone narrows the population on it.
          details: { poiEvidence, poiExtreme, poiIdmAdjacent, poiKind, killzone },
        });
      }

      const expiresAt = new Date(
        context.candle.closeTime.getTime() + config.expiryCandles * 5 * 60_000
      );

      return [
        {
          side,
          entryPrice,
          stopLoss,
          targetPrice,
          riskReward,
          confidence: Math.max(config.minConfidence, 0.75),
          reasoning: [
            `Four-Pillar ICT SHORT alignment: ${bias.bias} bias, ${structure.trend} trend, ${bias.dailyTemplate} template.`,
            `Targeting ERL ${targetPool.kind} at ${targetPrice.toFixed(2)}, invalidation beyond ${stopLoss.toFixed(2)}.`,
            poiEvidence ? `POI confirmation: ${poiEvidence}.` : "POI reaction verified.",
            `Risk-Reward ratio: ${riskReward.toFixed(2)}R.`,
          ],
          evidence: {
            strategy: ICT_STRUCTURE_STRATEGY_KEY,
            engineVersion: ict.engineVersion,
            configHash: ict.configHash,
            bias: bias.bias,
            structureTrend: structure.trend,
            targetPoolKind: targetPool.kind,
            targetPrice,
            stopLoss,
            poiEvidence,
          },
          expiresAt,
          evidenceItems: evidence,
        },
      ];
    }
  }
}
