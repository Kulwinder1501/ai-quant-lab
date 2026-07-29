export type VolatilityRegime = "HIGH_VOL" | "LOW_VOL";

export interface RegimeContext {
  regime: VolatilityRegime;
  /** The ratio of VIX close to VIX SMA(20). Values above 1.0 indicate HIGH_VOL. */
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

  const valueRatio = vixClose / vixSma20;
  return {
    regime: valueRatio > 1.0 ? "HIGH_VOL" : "LOW_VOL",
    valueRatio,
  };
}
