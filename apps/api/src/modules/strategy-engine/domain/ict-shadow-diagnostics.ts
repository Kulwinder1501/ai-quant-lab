import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";
import { computeSwingHierarchyFeature, resolveProtectedLevelStatusAt, type ProtectedLevelStatus, type ProtectedSide } from "../../technical-analysis/domain/ict/swing-hierarchy.js";
import { instrumentProfileForSymbol, NSE_IST_PROFILE, sessionDateKey } from "../../platform/calendar/instrument-profile.js";

/**
 * G2's failure taxonomy, computed from an already-produced `IctStateCompositeSnapshot` rather than
 * re-derived or guessed at. Every field here reads state the engine already computes on every bar
 * (`swingHierarchy`, `liquidity.primaryTarget`, `drawOnLiquidityState`) -- nothing new is detected,
 * this only makes what `ict-structure-strategy.ts` already looks at internally visible to a
 * persisted audit row, which is the actual gap G2 exists to close. See
 * `gold-shadow-audit-availability.ts` for why a real data source was missing before this.
 */
export interface IctShadowDiagnostics {
  /** PIT-safe fail-closed status, same function the strategy's own gate calls. */
  readonly protectedStatusAtCutoff: ProtectedLevelStatus;
  readonly protectedLevelBreached: boolean;
  readonly protectedSide: ProtectedSide | null;
  /**
   * Whether an ITH/ITL protected level exists at all for the current trend -- `false` on a NEUTRAL
   * trend or before the first Intermediate Term point has formed, which is a real, common state
   * early in a series and not itself a defect.
   */
  readonly swingHierarchyPresent: boolean;
  /**
   * Whether `liquidity.primaryTarget` (what the strategy actually prices stop/target against) and
   * `drawOnLiquidityState.selectedPool` (the shadow-only, independently-recomputed 8-step DOL
   * selection -- see `liquidity.ts`'s `computeDrawOnLiquidity` and its docstring on
   * `IctStateCompositeSnapshot`) disagree on which pool is the live objective. `null` when either
   * side has no candidate at all, since "stale relative to X" presupposes X exists.
   */
  readonly staleMacroTarget: boolean | null;
  readonly primaryTargetPrice: number | null;
  readonly primaryTargetKind: string | null;
  readonly drawOnLiquidityPrice: number | null;
  readonly drawOnLiquidityKind: string | null;
  /**
   * Whether this bar's instant buckets into a different session date under `NSE_IST_PROFILE` than
   * under the profile actually appropriate for `symbol` (see `instrument-profile.ts`). This is a
   * fact about the bar, not a claim that the wrong profile was used to compute `ict` -- the engine
   * call site (`PostgresStrategyMarketContextRepository.computeAndPersistIctSnapshot`) has resolved
   * the correct profile per-instrument since fix G1 (2026-10-05). It exists so a G2 audit can
   * identify which historical rows, if any, were computed *before* that fix landed and are
   * therefore the ones a session-date defect could actually have touched.
   *
   * `null` when the caller did not supply a `symbol` -- this check needs the instrument's real
   * ticker, which `IctStateCompositeSnapshot` itself does not carry, and "not checked" must stay
   * distinguishable from "checked and found no mismatch".
   */
  readonly sessionDateMismatch: boolean | null;
}

/**
 * Pure, side-effect-free: reads only the composite snapshot already attached to a
 * `StrategyMarketContext` plus the evaluating bar's own open time and (optionally) instrument
 * symbol. Shared between `generate-trade-ideas.ts` (which records a `shadow_decisions` row per
 * `ict-structure-v1` evaluation) and anything that later wants to recompute the same taxonomy from
 * a stored snapshot without re-running the engine.
 */
export function computeIctShadowDiagnostics(
  ict: IctStateCompositeSnapshot,
  candleClose: number,
  barOpenTime: Date,
  symbol?: string,
): IctShadowDiagnostics {
  const feature = computeSwingHierarchyFeature(ict.swingHierarchy, ict.structure.trend, candleClose);
  const protectedStatusAtCutoff = resolveProtectedLevelStatusAt(ict.swingHierarchy, ict.structure.trend, candleClose);

  const primaryTarget = ict.liquidity.primaryTarget;
  const drawOnLiquidityPool = ict.drawOnLiquidityState.selectedPool;
  const staleMacroTarget = primaryTarget !== null && drawOnLiquidityPool !== null
    ? primaryTarget.id !== drawOnLiquidityPool.id
    : null;

  let sessionDateMismatch: boolean | null = null;
  if (symbol) {
    const correctProfile = instrumentProfileForSymbol(symbol);
    sessionDateMismatch = sessionDateKey(correctProfile, barOpenTime) !== sessionDateKey(NSE_IST_PROFILE, barOpenTime);
  }

  return {
    protectedStatusAtCutoff,
    protectedLevelBreached: feature.protectedLevelBreached,
    protectedSide: feature.protectedSide,
    swingHierarchyPresent: feature.protectedSide !== null,
    staleMacroTarget,
    primaryTargetPrice: primaryTarget?.price ?? null,
    primaryTargetKind: primaryTarget?.kind ?? null,
    drawOnLiquidityPrice: drawOnLiquidityPool?.price ?? null,
    drawOnLiquidityKind: drawOnLiquidityPool?.kind ?? null,
    sessionDateMismatch,
  };
}
