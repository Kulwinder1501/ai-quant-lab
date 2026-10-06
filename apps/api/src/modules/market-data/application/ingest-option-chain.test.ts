import { describe, expect, it } from "vitest";
import { IngestOptionChain, MINIMUM_TRADABLE_DAYS_TO_EXPIRY } from "./ingest-option-chain.js";
import { MINIMUM_DAYS_TO_EXPIRY } from "../../paper-trading/application/prepare-option-entry.js";
import type { OptionChainSnapshot } from "../domain/option-chain.js";

const FRONT = "2026-08-25";
const ROLLED = "2026-09-29";

function snapshot(expiry: string, token: string | null): OptionChainSnapshot {
  const expiryDate = new Date(`${expiry}T10:00:00.000Z`);
  const quote = (strike: number, optionType: "CE" | "PE") => ({
    expiryDate,
    expiryKind: "MONTHLY" as const,
    strikePrice: strike,
    optionType,
    providerSymbol: `NSE:BANKNIFTY-${expiry}-${strike}${optionType}`,
    providerToken: null,
    lastPrice: 120,
    bid: 119,
    ask: 121,
    volume: 1_000,
    openInterest: 5_000,
    previousOpenInterest: 4_900,
    openInterestChange: 100,
  });
  return {
    underlyingSymbol: "BANKNIFTY",
    provider: "fyers",
    observedAt: new Date("2026-08-24T04:00:00.000Z"),
    underlyingValue: 57_500,
    quotes: [quote(57_400, "CE"), quote(57_400, "PE"), quote(57_500, "CE"), quote(57_500, "PE")],
    listedExpiries: [
      { expiryDate: new Date(`${FRONT}T10:00:00.000Z`), expiryKind: "MONTHLY", providerExpiryToken: "1756108800" },
      { expiryDate: new Date(`${ROLLED}T10:00:00.000Z`), expiryKind: "MONTHLY", providerExpiryToken: "1759132800" },
    ],
    ...(token === null ? {} : {}),
  };
}

function harness(options: { failRolled?: boolean } = {}) {
  const requested: Array<string | null | undefined> = [];
  const saved: string[] = [];
  const source = {
    async fetchChain(input: { underlyingSymbol: string; strikeCount?: number; expiryToken?: string | null }) {
      requested.push(input.expiryToken);
      if (input.expiryToken && options.failRolled) throw new Error("provider refused the rolled expiry");
      return snapshot(input.expiryToken ? ROLLED : FRONT, input.expiryToken ?? null);
    },
  };
  const store = {
    async saveSnapshot(value: OptionChainSnapshot) {
      saved.push(value.quotes[0]!.expiryDate.toISOString().slice(0, 10));
      return { inserted: value.quotes.length, skipped: 0 };
    },
    async saveExpiryCalendar() { return { inserted: 2 }; },
  };
  return { ingest: new IngestOptionChain(source, store), requested, saved };
}

describe("IngestOptionChain tradable-expiry coverage", () => {
  it("stores the rolled expiry when the front one is inside the trading floor", async () => {
    // 2026-08-24: front expiry 1.25 days out. The bot rolls to September, so the feed must too.
    const { ingest, requested, saved } = harness();
    const result = await ingest.execute({
      underlyingSymbols: ["BANKNIFTY"], now: new Date("2026-08-24T04:00:00.000Z"),
    });

    expect(saved).toEqual([FRONT, ROLLED]);
    expect(requested).toEqual([undefined, "1759132800"]);
    expect(result.tradableExpiries).toEqual([
      { underlyingSymbol: "BANKNIFTY", expiryDate: ROLLED, contracts: 4, inserted: 4 },
    ]);
  });

  it("fetches the front expiry first, so D2's nearest-expiry book is never displaced", async () => {
    const { ingest, saved } = harness();
    await ingest.execute({ underlyingSymbols: ["BANKNIFTY"], now: new Date("2026-08-24T04:00:00.000Z") });

    expect(saved[0]).toBe(FRONT);
  });

  it("does not make a second request when the front expiry is itself tradable", async () => {
    // 2026-08-21: 4 days out. One book is the whole answer, and the extra provider call would be
    // waste against a rate limit that has already been exhausted once.
    const { ingest, requested } = harness();
    const result = await ingest.execute({
      underlyingSymbols: ["BANKNIFTY"], now: new Date("2026-08-21T04:00:00.000Z"),
    });

    expect(requested).toEqual([undefined]);
    expect(result.tradableExpiries).toEqual([]);
  });

  it("keeps the front expiry when the rolled fetch fails, and reports the failure", async () => {
    // The primary observation must survive losing the secondary one.
    const { ingest, saved } = harness({ failRolled: true });
    const result = await ingest.execute({
      underlyingSymbols: ["BANKNIFTY"], now: new Date("2026-08-24T04:00:00.000Z"),
    });

    expect(saved).toEqual([FRONT]);
    expect(result.chains).toHaveLength(1);
    expect(result.tradableExpiries).toEqual([]);
    expect(result.failures[0]?.underlyingSymbol).toContain("tradable expiry");
  });

  it("records a failure, without attempting a fetch, when the provider lists the tradable expiry but gives it no token", async () => {
    // The 2026-08-24 failure mode recurring upstream of the try/catch: the provider's own header
    // says the rolled expiry exists, but does not hand back a token that could fetch its book.
    const requested: Array<string | null | undefined> = [];
    const saved: string[] = [];
    const source = {
      async fetchChain(input: { underlyingSymbol: string; strikeCount?: number; expiryToken?: string | null }) {
        requested.push(input.expiryToken);
        return {
          ...snapshot(FRONT, null),
          listedExpiries: [
            { expiryDate: new Date(`${FRONT}T10:00:00.000Z`), expiryKind: "MONTHLY" as const, providerExpiryToken: "1756108800" },
            // No token for the rolled expiry, even though the provider still lists it.
            { expiryDate: new Date(`${ROLLED}T10:00:00.000Z`), expiryKind: "MONTHLY" as const, providerExpiryToken: null },
          ],
        };
      },
    };
    const store = {
      async saveSnapshot(value: OptionChainSnapshot) {
        saved.push(value.quotes[0]!.expiryDate.toISOString().slice(0, 10));
        return { inserted: value.quotes.length, skipped: 0 };
      },
      async saveExpiryCalendar() { return { inserted: 2 }; },
    };

    const result = await new IngestOptionChain(source, store).execute({
      underlyingSymbols: ["BANKNIFTY"], now: new Date("2026-08-24T04:00:00.000Z"),
    });

    // Only the front expiry was ever requested -- no attempt was made with a null token.
    expect(requested).toEqual([undefined]);
    expect(saved).toEqual([FRONT]);
    expect(result.tradableExpiries).toEqual([]);
    // The front observation itself is untouched.
    expect(result.chains).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.underlyingSymbol).toContain("tradable expiry");
    expect(result.failures[0]?.reason).toContain("no");
    expect(result.failures[0]?.reason).toContain("token");
  });

  it("picks the tradable expiry up on a later poll once the provider starts supplying its token -- no code path change needed, since each poll re-derives everything from the front chain it is handed that call", async () => {
    // Every past NIFTY50 weekly rollover shows this exact shape in the live data: the provider
    // omits the token for several days after the roll is first needed, then starts including it
    // roughly a week before that contract's own expiry (see `option_chain_snapshots`'s
    // `first_seen` column across 2026-09-01 through 2026-09-29 -- every single rollover). Nothing
    // in `IngestOptionChain` persists "already tried and failed", so the very next scheduled poll
    // (every 15 minutes in production) is already a fresh, independent attempt against whatever
    // `listedExpiries` the provider hands back that call. This test is the proof: the same
    // instance, called twice, recovers on the second call purely because the second call's
    // fixture supplies a token the first call's did not.
    let tokenAvailable = false;
    const requested: Array<string | null | undefined> = [];
    const saved: string[] = [];
    const source = {
      async fetchChain(input: { underlyingSymbol: string; strikeCount?: number; expiryToken?: string | null }) {
        requested.push(input.expiryToken);
        if (input.expiryToken) return snapshot(ROLLED, input.expiryToken);
        return {
          ...snapshot(FRONT, null),
          listedExpiries: [
            { expiryDate: new Date(`${FRONT}T10:00:00.000Z`), expiryKind: "MONTHLY" as const, providerExpiryToken: "1756108800" },
            {
              expiryDate: new Date(`${ROLLED}T10:00:00.000Z`),
              expiryKind: "MONTHLY" as const,
              providerExpiryToken: tokenAvailable ? "1759132800" : null,
            },
          ],
        };
      },
    };
    const store = {
      async saveSnapshot(value: OptionChainSnapshot) {
        saved.push(value.quotes[0]!.expiryDate.toISOString().slice(0, 10));
        return { inserted: value.quotes.length, skipped: 0 };
      },
      async saveExpiryCalendar() { return { inserted: 2 }; },
    };
    const ingest = new IngestOptionChain(source, store);
    const now = new Date("2026-08-24T04:00:00.000Z");

    const firstPoll = await ingest.execute({ underlyingSymbols: ["BANKNIFTY"], now });
    expect(firstPoll.tradableExpiries).toEqual([]);
    expect(firstPoll.failures).toHaveLength(1);

    // The next scheduled poll: nothing about the caller or the instance changed, only what the
    // provider now supplies -- exactly what a real 15-minutes-later invocation would look like.
    tokenAvailable = true;
    const secondPoll = await ingest.execute({ underlyingSymbols: ["BANKNIFTY"], now });

    expect(secondPoll.failures).toEqual([]);
    expect(secondPoll.tradableExpiries).toEqual([
      { underlyingSymbol: "BANKNIFTY", expiryDate: ROLLED, contracts: 4, inserted: 4 },
    ]);
    expect(requested).toEqual([undefined, undefined, "1759132800"]);
    expect(saved).toEqual([FRONT, FRONT, ROLLED]);
  });

  it("can be switched back to front-expiry-only collection", async () => {
    const { ingest, requested } = harness();
    await ingest.execute({
      underlyingSymbols: ["BANKNIFTY"], now: new Date("2026-08-24T04:00:00.000Z"),
      includeTradableExpiry: false,
    });

    expect(requested).toEqual([undefined]);
  });

  it("keeps the collection floor equal to the trading floor", () => {
    // These are declared separately so market-data does not depend on paper-trading. If the trading
    // floor moves and this does not, collection silently stops covering the contract the bot picks
    // -- which is exactly the 2026-08-24 break.
    expect(MINIMUM_TRADABLE_DAYS_TO_EXPIRY).toBe(MINIMUM_DAYS_TO_EXPIRY);
  });
});
