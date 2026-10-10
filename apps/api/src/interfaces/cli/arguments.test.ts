import { describe, expect, it } from "vitest";
import { parseInstrumentExchange } from "./arguments.js";
import { instrumentExchanges } from "../../modules/market-data/domain/instrument.js";

/**
 * Regression for the 2026-10-10 gold outage: `calculate-technical-indicators` had its own
 * exchange allow-list that did not include OANDA, so the scheduler's XAU_CANDLE_COLLECTION job
 * (which passes `--exchange OANDA`) failed with exit code 1 on every run and never reached the
 * DXY component collection that follows it.
 */
describe("parseInstrumentExchange", () => {
  it("accepts OANDA, which the scheduler passes for XAU_USD and DXY", () => {
    expect(parseInstrumentExchange("OANDA")).toBe("OANDA");
  });

  it("accepts every exchange the Instrument type supports, in any case", () => {
    for (const exchange of instrumentExchanges) {
      expect(parseInstrumentExchange(exchange)).toBe(exchange);
      expect(parseInstrumentExchange(exchange.toLowerCase())).toBe(exchange);
    }
  });

  it("still rejects an unknown exchange and names the valid ones", () => {
    expect(() => parseInstrumentExchange("NASDAQ")).toThrowError(/Unsupported --exchange "NASDAQ".*OANDA/);
  });
});
