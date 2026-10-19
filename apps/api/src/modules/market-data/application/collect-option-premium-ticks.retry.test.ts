import { describe, expect, it, vi } from "vitest";
import { CollectOptionPremiumTicks } from "./collect-option-premium-ticks.js";

const SECOND_REFUSAL = {
  s: "error",
  code: -360,
  message: "You've reached the Standard plan limit of 5 requests/second. Upgrade to Prime for higher API limits.",
};
const MINUTE_REFUSAL = {
  s: "error",
  code: -360,
  message: "You've reached the Standard plan limit of 50 requests/minute. Upgrade to Prime for higher API limits.",
};
const OK = { s: "ok", d: [{ n: "NSE:NIFTY2682522000CE", s: "ok", v: { lp: 200, bid: 199, ask: 201, volume: 1_000 } }] };

function collectorWith(responses: Array<{ status: number; body: unknown }>) {
  const queue = [...responses];
  const fetchFn = vi.fn(async () => {
    const next = queue.shift() ?? responses[responses.length - 1]!;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  });
  const sleep = vi.fn(async () => undefined);
  const collector = new CollectOptionPremiumTicks(
    {} as never,
    {} as never,
    { appId: "app", tokenService: { getAccessToken: async () => "token" }, fetch: fetchFn as never, sleep },
  );
  const fetchRichQuotes = (symbols: string[]) =>
    (collector as unknown as { fetchRichQuotes(symbols: string[]): Promise<Map<string, { lastPrice: number | null }>> })
      .fetchRichQuotes(symbols);
  return { fetchRichQuotes, fetchFn, sleep };
}

describe("CollectOptionPremiumTicks per-second refusals", () => {
  it("waits out a per-second refusal and asks again, so one busy second does not cost a minute of ticks", async () => {
    const { fetchRichQuotes, fetchFn, sleep } = collectorWith([
      { status: 429, body: SECOND_REFUSAL },
      { status: 200, body: OK },
    ]);

    const quotes = await fetchRichQuotes(["NSE:NIFTY2682522000CE"]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_100);
    expect(quotes.get("NSE:NIFTY2682522000CE")?.lastPrice).toBe(200);
  });

  it("gives up after two retries rather than keep adding load", async () => {
    const { fetchRichQuotes, fetchFn } = collectorWith([{ status: 429, body: SECOND_REFUSAL }]);

    await expect(fetchRichQuotes(["NSE:NIFTY2682522000CE"])).rejects.toThrow("requests/second");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a per-minute refusal, which a second cannot clear", async () => {
    const { fetchRichQuotes, fetchFn, sleep } = collectorWith([{ status: 429, body: MINUTE_REFUSAL }]);

    await expect(fetchRichQuotes(["NSE:NIFTY2682522000CE"])).rejects.toThrow("requests/minute");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry an ordinary failure", async () => {
    const { fetchRichQuotes, fetchFn } = collectorWith([{ status: 500, body: { s: "error", message: "boom" } }]);

    await expect(fetchRichQuotes(["NSE:NIFTY2682522000CE"])).rejects.toThrow("HTTP 500");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
