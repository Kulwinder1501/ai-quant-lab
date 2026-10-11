export type VolatilityRegime = "HIGH_VOL" | "LOW_VOL";

export interface RegimeContext {
  regime: VolatilityRegime;
  /**
   * VIX close over the (current-bar-inclusive) VIX SMA(20), kept for continuity of stored
   * history. The regime is NOT `valueRatio > 1`: it is the close against the mean of the prior
   * 19 closes exceeding `highVolRatioThreshold` (1.10).
   */
  valueRatio: number;
}

/**
 * The regime is defined relative to volatility's own recent average rather than an
 * absolute level, because an absolute threshold silently means something different
 * in each era. These constants are part of that definition: changing the source
 * indicator, its version, or its period changes what a stored regime meant.
 */
export const regimeSourceInstrumentSymbol = "INDIAVIX";
export const regimeSourceIndicatorCode = "SMA";
export const regimeSourceIndicatorPeriod = 20;
export const regimeSourceIndicatorAlgorithmVersion = "ta-v1";

/** How far back a volatility reading may be and still describe the current bar. */
export const regimeStalenessBars = 5;

/**
 * The staleness window in milliseconds, or null when the timeframe is not one this
 * rule understands. Returning null keeps an unrecognised timeframe from silently
 * borrowing another timeframe's window; the regime is simply unknown instead.
 */
export function regimeStalenessMilliseconds(timeframe: string): number | null {
  const match = /^(\d+)(m|h|d)$/.exec(timeframe);
  if (!match) return null;
  const unitMilliseconds = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return Number(match[1]) * unitMilliseconds * regimeStalenessBars;
}

/**
 * Derives the volatility regime as a pure function, or null when the inputs cannot
 * support a verdict. Null means "unknown", which callers must distinguish from a
 * measured regime: reporting absent data as a definitive LOW_VOL would let a gap in
 * the VIX series masquerade as a calm market.
 */
export function deriveVolatilityRegime(vixClose: number, vixSma20: number): RegimeContext | null {
  if (!Number.isFinite(vixClose) || !Number.isFinite(vixSma20) || vixClose <= 0 || vixSma20 <= 0) {
    return null;
  }

  // The stored SMA(20) INCLUDES the current close, so `close / SMA20 > 1` is partly
  // self-referential and HIGH_VOL by that rule held about half of all days by construction.
  // The classification variable is the current close against the mean of the PRIOR 19 closes,
  // recovered exactly from the inclusive SMA: priorMean = (20 * SMA20 - close) / 19.
  const priorMean = priorMeanExcludingCurrent(vixClose, vixSma20);
  if (priorMean === null) return null;
  return {
    regime: vixClose / priorMean > highVolRatioThreshold ? "HIGH_VOL" : "LOW_VOL",
    // Kept as close / SMA20, the quantity every stored observation and downstream consumer
    // already carries, so persisted history keeps one meaning. It is NOT the classification
    // variable any more (see above); read `regime` for the verdict.
    valueRatio: vixClose / vixSma20,
  };
}

/**
 * HIGH_VOL needs the close to exceed the prior-19-day mean by more than 10%. Above 1 because a
 * threshold at the mean classifies roughly half of all days as HIGH_VOL whatever the market is
 * doing, which makes the label carry no information; 1.10 is a documented, deliberately
 * conservative band, not a fitted number.
 */
export const highVolRatioThreshold = 1.10;

/**
 * Mean of the 19 closes before the current one, from an SMA(20) that includes the current close.
 * Null when the inputs are inconsistent (a non-positive prior mean cannot come from positive
 * closes) so a corrupt reading is "unknown" rather than a verdict.
 */
export function priorMeanExcludingCurrent(close: number, sma20InclusiveOfCurrent: number): number | null {
  const period = regimeSourceIndicatorPeriod;
  const priorMean = (period * sma20InclusiveOfCurrent - close) / (period - 1);
  return Number.isFinite(priorMean) && priorMean > 0 ? priorMean : null;
}
