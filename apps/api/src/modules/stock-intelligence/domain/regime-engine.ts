import type { CanonicalMarketBar } from "./adapters.js";
import { selectBarsAsOf } from "./pit-audit.js";
import {
  regimeBucket,
  type StockIntelligenceMacroRegime,
  type StockIntelligenceVolatilityRegime,
} from "./status.js";

const NIFTY_LOOKBACK_BARS = 252;

/**
 * India VIX level buckets. Distinct from the trading lab's `HIGH_VOL` / `LOW_VOL`
 * ratio gate on `regime_observations`.
 */
export const DEFAULT_VIX_REGIME_THRESHOLDS = {
  lowMax: 15,
  normalMax: 20,
  elevatedMax: 30,
} as const;

export type VixRegimeThresholds = typeof DEFAULT_VIX_REGIME_THRESHOLDS;

export const MACRO_REGIME_SOURCE = "nifty_price_proxy_v0.1";

export interface RegimeAssignment {
  readonly macro: StockIntelligenceMacroRegime;
  readonly volatility: StockIntelligenceVolatilityRegime;
  readonly bucket: ReturnType<typeof regimeBucket>;
  readonly macroSource: typeof MACRO_REGIME_SOURCE;
  readonly vixLevel: number;
  readonly niftyMomentum12m: number;
  readonly niftyDrawdown52w: number;
}

function closes(bars: readonly CanonicalMarketBar[], asOf: Date): number[] {
  return selectBarsAsOf(bars, asOf)
    .map((bar) => Number(bar.close))
    .filter((close) => Number.isFinite(close) && close > 0);
}

function momentum(values: readonly number[], lookback: number): number | null {
  if (values.length < lookback + 1) return null;
  const start = values[values.length - 1 - lookback]!;
  const end = values[values.length - 1]!;
  if (start <= 0) return null;
  return end / start - 1;
}

function drawdown(values: readonly number[], window: number): number | null {
  if (values.length < 2) return null;
  const slice = values.slice(Math.max(0, values.length - window));
  const peak = Math.max(...slice);
  const last = slice[slice.length - 1]!;
  if (peak <= 0) return null;
  return last / peak - 1;
}

export function classifyVolatilityRegime(
  vixLevel: number,
  thresholds: VixRegimeThresholds = DEFAULT_VIX_REGIME_THRESHOLDS,
): StockIntelligenceVolatilityRegime {
  if (vixLevel <= thresholds.lowMax) return "low";
  if (vixLevel <= thresholds.normalMax) return "normal";
  if (vixLevel <= thresholds.elevatedMax) return "elevated";
  return "crisis";
}

/**
 * Price-path proxy, not an RBI dating committee. Expansion vs recovery is
 * distinguished by whether the 52-week drawdown is still deep.
 */
export function classifyMacroRegimeFromNifty(
  momentum12m: number,
  drawdown52w: number,
): StockIntelligenceMacroRegime {
  if (momentum12m > 0 && drawdown52w > -0.15) return "expansion";
  if (momentum12m > 0) return "recovery";
  if (drawdown52w <= -0.20) return "recession";
  return "slowdown";
}

export function assignRegime(input: {
  asOf: Date;
  niftyBars: readonly CanonicalMarketBar[];
  vixBars: readonly CanonicalMarketBar[];
  thresholds?: VixRegimeThresholds;
}): RegimeAssignment | null {
  const niftyCloses = closes(input.niftyBars, input.asOf);
  const vixCloses = closes(input.vixBars, input.asOf);
  const vixLevel = vixCloses[vixCloses.length - 1];
  const niftyMomentum12m = momentum(niftyCloses, NIFTY_LOOKBACK_BARS);
  const niftyDrawdown52w = drawdown(niftyCloses, NIFTY_LOOKBACK_BARS);
  if (vixLevel === undefined || niftyMomentum12m === null || niftyDrawdown52w === null) {
    return null;
  }
  const macro = classifyMacroRegimeFromNifty(niftyMomentum12m, niftyDrawdown52w);
  const volatility = classifyVolatilityRegime(vixLevel, input.thresholds);
  return {
    macro,
    volatility,
    bucket: regimeBucket(macro, volatility),
    macroSource: MACRO_REGIME_SOURCE,
    vixLevel,
    niftyMomentum12m,
    niftyDrawdown52w,
  };
}
