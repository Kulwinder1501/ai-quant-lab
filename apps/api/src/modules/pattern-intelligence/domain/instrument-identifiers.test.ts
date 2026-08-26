import { describe, expect, it } from "vitest";
import {
  normalizeTimeframe,
  normalizeUnderlying,
  priceScaleFromTickSize,
  UnknownInstrumentIdentifierError,
} from "./instrument-identifiers.js";

describe("instrument identifiers", () => {
  it("maps the NIFTY alias onto the live NIFTY50 symbol", () => {
    // instruments.symbol holds NIFTY50; there is no NIFTY row, so a join keyed on the alias returns
    // nothing -- silently, which reads exactly like a quiet market.
    expect(normalizeUnderlying("NIFTY")).toBe("NIFTY50");
    expect(normalizeUnderlying("NIFTY50")).toBe("NIFTY50");
    expect(normalizeUnderlying("nifty")).toBe("NIFTY50");
    expect(normalizeUnderlying(" NIFTY 50 ")).toBe("NIFTY50");
    expect(normalizeUnderlying("BANKNIFTY")).toBe("BANKNIFTY");
    expect(normalizeUnderlying("NIFTY BANK")).toBe("BANKNIFTY");
  });

  it("maps the 1h alias onto the live 60m timeframe", () => {
    // candles.timeframe holds 60m; there is no 1h.
    expect(normalizeTimeframe("1h")).toBe("60m");
    expect(normalizeTimeframe("60m")).toBe("60m");
    expect(normalizeTimeframe("15M")).toBe("15m");
    expect(normalizeTimeframe("1d")).toBe("1d");
  });

  it("refuses an identifier it cannot resolve rather than passing it through", () => {
    expect(() => normalizeUnderlying("FINNIFTY")).toThrow(UnknownInstrumentIdentifierError);
    expect(() => normalizeUnderlying("INDIAVIX")).toThrow(UnknownInstrumentIdentifierError);
    expect(() => normalizeTimeframe("4h")).toThrow(UnknownInstrumentIdentifierError);
    expect(() => normalizeTimeframe("3d")).toThrow(UnknownInstrumentIdentifierError);
  });

  it("derives priceScale from tick_size, since there is no price_scale column", () => {
    expect(priceScaleFromTickSize(0.05)).toBe(100);
    expect(priceScaleFromTickSize(0.01)).toBe(100);
    expect(priceScaleFromTickSize(0.1)).toBe(10);
    expect(priceScaleFromTickSize(1)).toBe(1);
    // A power of ten, not 1/tickSize: 1/0.05 is 20, which does not make 24_512.35 an integer.
    expect(priceScaleFromTickSize(0.05)).not.toBe(20);
  });

  it("refuses a tick size that cannot back a scale", () => {
    expect(() => priceScaleFromTickSize(0)).toThrow(UnknownInstrumentIdentifierError);
    expect(() => priceScaleFromTickSize(-0.05)).toThrow(UnknownInstrumentIdentifierError);
    expect(() => priceScaleFromTickSize(Number.NaN)).toThrow(UnknownInstrumentIdentifierError);
  });
});
