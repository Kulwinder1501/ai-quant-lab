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
    // The streamer names the expiry it wants, so it needs the calendar to know which. A single
    // listed expiry keeps these cases on one book, as before.
    latestExpiryCalendar: vi.fn(async () => ({
      underlyingSymbol: "BANKNIFTY",
      provider: "fyers",
      observedAt: OBSERVED_AT,
      expiries: [{ expiryDate: new Date("2026-08-25T10:00:00.000Z"), expiryKind: "MONTHLY" as const }],
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

/** A chain whose spot and observation time can be moved between refreshes. */
function movableChain(state: { spot: number; observedAt: Date }) {
  const strikes = [57_000, 57_100, 57_200, 57_300, 57_400, 57_500, 57_600];
  return {
    latestSnapshot: vi.fn(async () => ({
      underlyingSymbol: "BANKNIFTY",
      observedAt: state.observedAt,
      underlyingValue: state.spot,
      quotes: strikes.flatMap((strikePrice) => (["PE", "CE"] as const).map((optionType) => ({
        expiryDate: new Date("2026-08-25T10:00:00.000Z"),
        strikePrice,
        optionType,
        providerSymbol: `SYM-${strikePrice}${optionType}`,
      }))),
    })),
    latestExpiryCalendar: vi.fn(async () => ({
      underlyingSymbol: "BANKNIFTY",
      provider: "fyers",
      observedAt: state.observedAt,
      expiries: [{ expiryDate: new Date("2026-08-25T10:00:00.000Z"), expiryKind: "MONTHLY" as const }],
    })),
  } as unknown as PostgresOptionChainRepository;
}

function buildMovable(options: { contractRetentionMs?: number } = {}) {
  const state = { spot: 57_300, observedAt: OBSERVED_AT };
  const clock = { now: OBSERVED_AT };
  const socket = liveStreamer();
  const insertTicks = vi.fn(async (rows: unknown[]) => ({ inserted: rows.length, skipped: 0 }));
  const streamer = new OptionPremiumTickStreamer({
    underlyingSymbols: ["BANKNIFTY"],
    streamer: socket as unknown as FyersLiveStreamer,
    chainRepository: movableChain(state),
    tickRepository: { insertTicks } as unknown as PostgresOptionPremiumTickRepository,
    now: () => clock.now,
    ...options,
  });
  /** Move the wall clock and the snapshot together, so the band stays fresh as time passes. */
  const advance = (minutes: number): void => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
    state.observedAt = clock.now;
  };
  const subscribed = (): string[] => socket.subscribe.mock.calls.flatMap((call) => call[0] as string[]);
  const unsubscribed = (): string[] => socket.unsubscribe.mock.calls.flatMap((call) => call[0] as string[]);
  return { streamer, socket, insertTicks, state, advance, subscribed, unsubscribed };
}

describe("OptionPremiumTickStreamer contract retention", () => {
  it("keeps a contract subscribed after the ATM band has moved away from it", async () => {
    // The defect this prevents: a research strategy entering at 14:45 with a 30-minute hold lost
    // its exit quote at 15:12 because spot had walked the band off the strike it was holding.
    const { streamer, advance, state, unsubscribed } = buildMovable();
    await streamer.start();

    advance(10);
    state.spot = 57_600; // band moves to 57500/57600/57700; 57200-57400 are no longer wanted
    await streamer.refreshSubscriptions();

    expect(unsubscribed()).not.toContain("SYM-57300PE");
    await streamer.stop();
  });

  it("still persists quotes for a retained contract", async () => {
    // Retention has to reach `this.contracts`, not just the subscription set. `selectFlushableTicks`
    // writes nothing outside that list, so a retained subscription without a retained contract
    // would receive quotes and silently discard them -- the same gap one layer down.
    const { streamer, socket, insertTicks, advance, state } = buildMovable();
    await streamer.start();

    advance(10);
    state.spot = 57_600;
    await streamer.refreshSubscriptions();

    socket.emitTick({ symbol: "SYM-57300PE", ltp: 350, bid: 349, ask: 351, volume: 10 } as Tick);
    await streamer.flush();

    const written = insertTicks.mock.calls.flat().flat() as Array<{ providerSymbol: string }>;
    expect(written.map((row) => row.providerSymbol)).toContain("SYM-57300PE");
    await streamer.stop();
  });

  it("drops the contract once the retention window has passed", async () => {
    // Bounded, not a leak: retention buys one holding period, not the whole session.
    const { streamer, advance, state, unsubscribed } = buildMovable();
    await streamer.start();

    advance(10);
    state.spot = 57_600;
    await streamer.refreshSubscriptions();
    expect(unsubscribed()).not.toContain("SYM-57300PE");

    advance(36); // past the 35-minute default, counted from when it was last wanted
    await streamer.refreshSubscriptions();
    expect(unsubscribed()).toContain("SYM-57300PE");
    await streamer.stop();
  });

  it("refreshes the deadline when a contract re-enters the band", async () => {
    // Spot oscillating around a strike must not retire a contract that keeps coming back.
    const { streamer, advance, state, unsubscribed } = buildMovable();
    await streamer.start();

    advance(20);
    state.spot = 57_600;
    await streamer.refreshSubscriptions();

    advance(20);
    state.spot = 57_300; // back in the band, deadline restarts here
    await streamer.refreshSubscriptions();

    advance(20); // 40 minutes since it first left, but only 20 since it was last wanted
    await streamer.refreshSubscriptions();

    expect(unsubscribed()).not.toContain("SYM-57300PE");
    await streamer.stop();
  });

  it("reproduces the old drop-immediately behaviour at zero retention", async () => {
    // The control for the four tests above: with the window closed, a contract leaving the band is
    // unsubscribed on the same cycle, which is exactly what produced the 2026-08-18 exit gap. If
    // this ever passes *and* the retention tests pass, the knob is not connected to anything.
    const { streamer, advance, state, unsubscribed } = buildMovable({ contractRetentionMs: 0 });
    await streamer.start();

    advance(10);
    state.spot = 57_600;
    await streamer.refreshSubscriptions();

    expect(unsubscribed()).toContain("SYM-57300PE");
    await streamer.stop();
  });

  it("does not unsubscribe everything the moment the chain snapshot goes stale", async () => {
    // `selectAtmPremiumContracts` returns [] past its 40-minute staleness guard, which previously
    // dropped every option subscription at once. A stalled chain job should cost the band's
    // freshness, not the entire series.
    const { streamer, advance, state, unsubscribed } = buildMovable();
    await streamer.start();

    advance(10);
    state.observedAt = OBSERVED_AT; // the chain job stopped publishing; the clock did not stop
    await streamer.refreshSubscriptions();

    expect(unsubscribed()).toEqual([]);
    await streamer.stop();
  });
});

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
