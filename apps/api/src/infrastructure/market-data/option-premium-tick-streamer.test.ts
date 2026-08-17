import { describe, expect, it, vi } from "vitest";
import { OptionPremiumTickStreamer } from "./option-premium-tick-streamer.js";
import type { FyersLiveStreamer, Tick } from "./fyers-live-streamer.js";
import type { PostgresOptionChainRepository } from "../database/repositories/postgres-option-chain-repository.js";
import type { PostgresOptionPremiumTickRepository } from "../database/repositories/postgres-option-premium-tick-repository.js";

const OBSERVED_AT = new Date("2026-08-17T05:30:00.000Z");

/** A snapshot fresh enough to clear the staleness guard, with a two-strike grid around spot. */
function chainRepository() {
  return {
    latestSnapshot: vi.fn(async () => ({
      underlyingSymbol: "BANKNIFTY",
      observedAt: OBSERVED_AT,
      underlyingValue: 57_300,
      quotes: [
        { expiryDate: new Date("2026-08-25T10:00:00.000Z"), strikePrice: 57_200, optionType: "PE", providerSymbol: "SYM-57200PE" },
        { expiryDate: new Date("2026-08-25T10:00:00.000Z"), strikePrice: 57_200, optionType: "CE", providerSymbol: "SYM-57200CE" },
        { expiryDate: new Date("2026-08-25T10:00:00.000Z"), strikePrice: 57_300, optionType: "PE", providerSymbol: "SYM-57300PE" },
        { expiryDate: new Date("2026-08-25T10:00:00.000Z"), strikePrice: 57_300, optionType: "CE", providerSymbol: "SYM-57300CE" },
      ],
    })),
  } as unknown as PostgresOptionChainRepository;
}

function liveStreamer() {
  const listeners = new Map<string, ((tick: Tick) => void)[]>();
  return {
    on: (event: string, listener: (tick: Tick) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off: () => undefined,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emitTick: (tick: Tick) => {
      for (const listener of listeners.get("tick") ?? []) listener(tick);
    },
  };
}

function build(options: {
  onTicksWritten?: (result: { inserted: number; skipped: number }) => Promise<void> | void;
  inserted?: number;
}) {
  const socket = liveStreamer();
  const insertTicks = vi.fn(async (rows: unknown[]) => ({
    inserted: options.inserted ?? rows.length,
    skipped: rows.length - (options.inserted ?? rows.length),
  }));
  const streamer = new OptionPremiumTickStreamer({
    underlyingSymbols: ["BANKNIFTY"],
    streamer: socket as unknown as FyersLiveStreamer,
    chainRepository: chainRepository(),
    tickRepository: { insertTicks } as unknown as PostgresOptionPremiumTickRepository,
    now: () => OBSERVED_AT,
    onTicksWritten: options.onTicksWritten,
  });
  return { streamer, socket, insertTicks };
}

describe("OptionPremiumTickStreamer tick handler", () => {
  it("runs the handler after the rows are written, so it can read them", async () => {
    const order: string[] = [];
    const { streamer, socket, insertTicks } = build({
      onTicksWritten: () => { order.push("handler"); },
    });
    insertTicks.mockImplementation(async (rows: unknown[]) => {
      order.push("insert");
      return { inserted: rows.length, skipped: 0 };
    });

    await streamer.start();
    socket.emitTick({ symbol: "SYM-57300PE", ltp: 350, bid: 349, ask: 351, volume: 10 } as Tick);
    await streamer.flush();
    await streamer.stop();

    // The handler exists to evaluate barriers against the tick table, so it must not run first.
    expect(order).toEqual(["insert", "handler"]);
  });

  it("does not run the handler when the flush wrote nothing", async () => {
    const onTicksWritten = vi.fn();
    const { streamer } = build({ onTicksWritten });

    await streamer.start();
    // No tick arrived, so there is nothing to flush and nothing the handler does not know.
    await expect(streamer.flush()).resolves.toEqual({ inserted: 0, skipped: 0 });
    await streamer.stop();
    expect(onTicksWritten).not.toHaveBeenCalled();
  });

  it("does not run the handler when every row was a duplicate", async () => {
    const onTicksWritten = vi.fn();
    const { streamer, socket } = build({ onTicksWritten, inserted: 0 });

    await streamer.start();
    socket.emitTick({ symbol: "SYM-57300PE", ltp: 350, bid: 349, ask: 351, volume: 10 } as Tick);
    await streamer.flush();
    await streamer.stop();

    expect(onTicksWritten).not.toHaveBeenCalled();
  });

  it("keeps the tick series when the handler throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { streamer, socket } = build({
      onTicksWritten: () => { throw new Error("evaluation exploded"); },
    });

    await streamer.start();
    socket.emitTick({ symbol: "SYM-57300PE", ltp: 350, bid: 349, ask: 351, volume: 10 } as Tick);

    // The write already succeeded; a consumer's failure must not be reported as a failed flush,
    // or the caller would retry quotes that are already persisted.
    await expect(streamer.flush()).resolves.toMatchObject({ inserted: 1 });
    expect(String(error.mock.calls[0]?.[0])).toContain("evaluation exploded");
    await streamer.stop();
    error.mockRestore();
  });
});
