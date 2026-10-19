import { describe, expect, it } from "vitest";
import { describeControlMessage } from "./fyers-live-streamer.js";
import { SubscriptionRefCounter } from "./subscription-ref-counter.js";

describe("SubscriptionRefCounter", () => {
  it("frees a symbol only when the last holder lets go", () => {
    const holders = new SubscriptionRefCounter();
    expect(holders.acquire(["A", "B"])).toEqual(["A", "B"]);
    expect(holders.acquire(["B", "C"])).toEqual(["C"]);

    expect(holders.release(["A", "B"])).toEqual(["A"]);
    expect(holders.release(["B", "C"])).toEqual(["B", "C"]);
    expect(holders.heldCount()).toBe(0);
  });

  it("counts a symbol once per holder even if it is listed twice", () => {
    const holders = new SubscriptionRefCounter();
    holders.acquire(["A", "A"]);
    expect(holders.release(["A"])).toEqual(["A"]);
  });

  it("ignores a release for something nobody holds", () => {
    const holders = new SubscriptionRefCounter();
    expect(holders.release(["Z"])).toEqual([]);
  });
});

describe("describeControlMessage", () => {
  it("reports a Fyers refusal", () => {
    const text = describeControlMessage({ s: "error", code: -300, message: "Please provide a valid symbol" });
    expect(JSON.parse(text!)).toEqual({ s: "error", code: -300, message: "Please provide a valid symbol" });
  });

  it("reports a negative code even without the status field", () => {
    expect(describeControlMessage({ code: -99, message: "limit" })).not.toBeNull();
  });

  it("says nothing about ordinary acknowledgements and ticks", () => {
    expect(describeControlMessage({ s: "ok", code: 200, message: "Authentication done" })).toBeNull();
    expect(describeControlMessage({ type: "cn" })).toBeNull();
    expect(describeControlMessage("pong")).toBeNull();
    expect(describeControlMessage(null)).toBeNull();
  });
});
