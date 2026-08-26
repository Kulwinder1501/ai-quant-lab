import type { ObservationSource } from "./contracts.js";

/**
 * The single place where an external identifier becomes a Pattern Intelligence identifier.
 *
 * ## Why this exists
 *
 * The module previously carried two spellings for the same things. `"NIFTY"` appeared in four places
 * against `"NIFTY50"` in one, and the timeframe union admitted both `"1h"` and `"60m"`. Neither
 * duplicate is a live value: `instruments.symbol` holds `NIFTY50` and there is no `NIFTY` row;
 * `candles.timeframe` holds `60m` and there is no `1h`. A join on either alias returns nothing.
 *
 * That is the dangerous shape of this bug — a silent empty result, not an error. A detection run keyed
 * on `"NIFTY"` would evaluate zero candles and report zero patterns, which is exactly what a quiet
 * market looks like.
 *
 * The V1.0.1 Implementation Errata (Section 4) settles it: the live identifiers are canonical inside
 * the module, and the aliases are accepted only at the boundary, through these functions. The unions
 * in `contracts.ts` no longer admit the aliases at all, so an alias cannot reach an observation — and
 * therefore cannot reach `observationHash`, where two spellings of one instrument would have produced
 * two different identities for the same pattern.
 */

/** Canonical underlyings. Matches `instruments.symbol` in the live database. */
export type CanonicalUnderlying = ObservationSource["underlying"];
/** Canonical timeframes. Matches `candles.timeframe` in the live database. */
export type CanonicalTimeframe = ObservationSource["timeframe"];

export class UnknownInstrumentIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownInstrumentIdentifierError";
  }
}

const underlyingAliases: Readonly<Record<string, CanonicalUnderlying>> = {
  NIFTY: "NIFTY50",
  NIFTY50: "NIFTY50",
  "NIFTY 50": "NIFTY50",
  BANKNIFTY: "BANKNIFTY",
  "NIFTY BANK": "BANKNIFTY",
};

const timeframeAliases: Readonly<Record<string, CanonicalTimeframe>> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "10m": "10m",
  "15m": "15m",
  "30m": "30m",
  "60m": "60m",
  "1h": "60m",
  "1d": "1d",
};

const timeframeDurations: Readonly<Record<CanonicalTimeframe, number>> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/**
 * The nominal wall-clock span of one bar.
 *
 * Used only as a *fallback* for `earliestExecutionAt` when the next bar is not in the series, and
 * deliberately so. Deriving execution timing from a duration is wrong across any session boundary:
 * the bar after a 15:29 close is not 1 minute later, it is the next trading morning, and for `1d`
 * it is the next trading day rather than 24 hours. Where the candle series actually contains the
 * following bar, its `openTime` is the ground truth and must be preferred over this.
 */
export function timeframeDurationMs(timeframe: CanonicalTimeframe): number {
  return timeframeDurations[timeframe];
}

/** Resolves an inbound underlying spelling to the canonical one, or refuses. */
export function normalizeUnderlying(value: string): CanonicalUnderlying {
  const canonical = underlyingAliases[value.trim().toUpperCase()];
  if (!canonical) {
    throw new UnknownInstrumentIdentifierError(
      `Underlying "${value}" has no canonical Pattern Intelligence spelling. Known: `
      + `${Object.keys(underlyingAliases).join(", ")}.`,
    );
  }
  return canonical;
}

/** Resolves an inbound timeframe spelling to the canonical one, or refuses. */
export function normalizeTimeframe(value: string): CanonicalTimeframe {
  const canonical = timeframeAliases[value.trim().toLowerCase()];
  if (!canonical) {
    throw new UnknownInstrumentIdentifierError(
      `Timeframe "${value}" has no canonical Pattern Intelligence spelling. Known: `
      + `${Object.keys(timeframeAliases).join(", ")}.`,
    );
  }
  return canonical;
}

/**
 * Derives `ObservationSource.priceScale` from the instrument's tick size.
 *
 * There is no `instruments.price_scale` column — `instruments` carries `tick_size` and nothing else
 * that could back this field, so a `priceScale` read straight from instrument metadata would have
 * read `undefined`. Errata Section 4 calls for a point-in-time integer scale resolved from instrument
 * metadata; this is that resolution, stated as a function so the derivation is inspectable rather
 * than assumed.
 *
 * The scale is the smallest power of ten that turns a tick-aligned price into an integer: tick 0.05
 * gives 100, tick 0.01 gives 100, tick 1 gives 1. It is deliberately a power of ten rather than
 * `1 / tickSize` — 1/0.05 is 20, which does not make 24_512.35 an integer.
 */
export function priceScaleFromTickSize(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new UnknownInstrumentIdentifierError(`Tick size must be finite and positive; got ${tickSize}.`);
  }
  let scale = 1;
  // Ten iterations bounds the loop well beyond any NSE tick size (the smallest in use is 0.01).
  for (let decimals = 0; decimals <= 10; decimals++) {
    const scaled = tickSize * scale;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return scale;
    scale *= 10;
  }
  throw new UnknownInstrumentIdentifierError(
    `Tick size ${tickSize} needs more than 10 decimal places to express as an integer scale.`,
  );
}
