/**
 * The provider's own Greeks for one contract, exactly as Fyers' `greeks=1` option-chain flag sends them.
 *
 * Observed, not derived: this repo's model Greeks are computed on read from the mid and the parity
 * forward (`chain-greeks.ts`); these are what the provider said, kept beside them so the two can be
 * compared. Units are the provider's and are kept: `impliedVolatilityPercent` is a PERCENT (15.30), where
 * the model's IV is a fraction (0.153), which is why the field name carries the unit.
 *
 * Measured 2026-10-23 (NIFTY50, BANKNIFTY, SBIN): one value per strike shared by call and put, put delta
 * exactly call delta minus one, gamma to four decimals only.
 */
export interface VendorGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatilityPercent: number | null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses the provider's `greeks` object, refusing each field that cannot be right.
 *
 * Field by field, and to null rather than to a throw. These values sit beside open interest and
 * quotes in a table whose purpose is to be the raw record; refusing the whole snapshot because one
 * auxiliary number is malformed would lose the observation that matters to protect the one that does
 * not. A value outside what the quantity can be is dropped (a delta of 7, a negative gamma or vega, a
 * zero or negative IV): storing it would put a parsing fault into the record under the provider's name.
 * Absent, not an object, or all-null yields `null` -- "the provider sent no Greeks" -- which is not the
 * same as an object of zeros.
 *
 * Theta is only required to be finite. It is negative for a long option, and a provider that reports it
 * per year or per lot would still be finite, so there is no range that separates a right theta from a
 * wrong one.
 */
export function parseVendorGreeks(raw: unknown): VendorGreeks | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const delta = finiteNumber(record.delta);
  const gamma = finiteNumber(record.gamma);
  const theta = finiteNumber(record.theta);
  const vega = finiteNumber(record.vega);
  const iv = finiteNumber(record.iv);

  const parsed: VendorGreeks = {
    delta: delta !== null && delta >= -1 && delta <= 1 ? delta : null,
    gamma: gamma !== null && gamma >= 0 ? gamma : null,
    theta,
    vega: vega !== null && vega >= 0 ? vega : null,
    impliedVolatilityPercent: iv !== null && iv > 0 ? iv : null,
  };

  const anything = Object.values(parsed).some((value) => value !== null);
  return anything ? parsed : null;
}

/** Whether a stored row carries any provider Greek, so a reader can tell "none" from "all null". */
export function hasVendorGreeks(greeks: VendorGreeks | null | undefined): greeks is VendorGreeks {
  return greeks !== null && greeks !== undefined && Object.values(greeks).some((value) => value !== null);
}
