import { describe, expect, it } from "vitest";
import {
  resolveSubscriptionDelta,
  selectFlushableTicks,
  type BufferedTick,
} from "./stream-option-premium-ticks.js";
import type { AtmPremiumContract } from "../domain/atm-premium-contracts.js";

const NOW = new Date("2026-08-17T05:30:00.000Z");

const contract: AtmPremiumContract = {
  underlyingSymbol: "NIFTY50",
  expiryDate: "2026-08-25",
  strikePrice: 24_300,
  optionType: "PE",
  providerSymbol: "NSE:NIFTY26082524300PE",
};

function buffered(overrides: Partial<BufferedTick> = {}): Map<string, BufferedTick> {
  return new Map([[contract.providerSymbol.toUpperCase(), {
    bid: 61.2,
    ask: 61.8,
    lastPrice: 61.5,
    volume: 12_000,
    observedAt: NOW,
    ...overrides,
  }]]);
}

function input(overrides: Partial<Parameters<typeof selectFlushableTicks>[0]> = {}) {
  return {
    contracts: [contract],
    buffered: buffered(),
    lastFlushedAt: new Map<string, number>(),
    underlyingValues: new Map([["NIFTY50", 24_312.5]]),
    provider: "fyers-api-v3",
    now: NOW,
    maximumTickAgeMs: 15_000,
    ...overrides,
  };
}

describe("selectFlushableTicks", () => {
  it("writes a fresh quote with its contract identity and the underlying spot", () => {
    const [row, ...rest] = selectFlushableTicks(input());

    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      underlyingSymbol: "NIFTY50",
      strikePrice: 24_300,
      optionType: "PE",
      providerSymbol: "NSE:NIFTY26082524300PE",
      bid: 61.2,
      ask: 61.8,
      underlyingValue: 24_312.5,
    });
    expect(row?.observedAt).toEqual(NOW);
  });

  it("drops a quote older than the staleness window rather than rewriting it", () => {
    // The failure mode a stream has and a poller does not: the socket goes quiet instead of
    // erroring, so the last quote it delivered would be rewritten forever and read as current.
    // `evaluate-open-paper-trades` resolves stops against this series.
    const stale = buffered({ observedAt: new Date(NOW.getTime() - 20_000) });

    expect(selectFlushableTicks(input({ buffered: stale }))).toEqual([]);
  });

  it("writes each quote once, so a contract that has not traded adds no rows", () => {
    const alreadyWritten = new Map([[contract.providerSymbol.toUpperCase(), NOW.getTime()]]);

    expect(selectFlushableTicks(input({ lastFlushedAt: alreadyWritten }))).toEqual([]);
  });

  it("writes again once a newer quote arrives for the same contract", () => {
    const later = buffered({ observedAt: new Date(NOW.getTime() + 4_000) });
    const alreadyWritten = new Map([[contract.providerSymbol.toUpperCase(), NOW.getTime()]]);

    const rows = selectFlushableTicks(input({
      buffered: later,
      lastFlushedAt: alreadyWritten,
      now: new Date(NOW.getTime() + 5_000),
    }));

    expect(rows).toHaveLength(1);
  });

  it("ignores quotes for contracts that are not subscribed", () => {
    // The socket keeps delivering briefly after an unsubscribe, and a strike the band has left
    // is not one this series should carry.
    expect(selectFlushableTicks(input({ contracts: [] }))).toEqual([]);
  });

  it("records a null underlying when no spot has been seen yet", () => {
    const [row] = selectFlushableTicks(input({ underlyingValues: new Map() }));

    expect(row?.underlyingValue).toBeNull();
  });
});

describe("resolveSubscriptionDelta", () => {
  it("only moves what changed, so a contract still wanted is never interrupted", () => {
    // Re-subscribing the whole set would blink the contracts that never stopped being wanted --
    // including one an open position is being resolved against.
    const delta = resolveSubscriptionDelta(
      new Set(["NSE:A", "NSE:B"]),
      ["NSE:B", "NSE:C"],
    );

    expect(delta.subscribe).toEqual(["NSE:C"]);
    expect(delta.unsubscribe).toEqual(["NSE:A"]);
  });

  it("compares case-insensitively, matching how the tick buffer is keyed", () => {
    const delta = resolveSubscriptionDelta(new Set(["NSE:A"]), ["nse:a"]);

    expect(delta.subscribe).toEqual([]);
    expect(delta.unsubscribe).toEqual([]);
  });
});
