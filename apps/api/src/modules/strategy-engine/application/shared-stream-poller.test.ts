import { describe, expect, it, vi } from "vitest";
import { SharedStreamPollerRegistry } from "./shared-stream-poller.js";

function silent() {
  return { log: () => {}, logError: () => {} };
}

/** Registry whose produce returns the key and counts calls per key. */
function counting(overrides: Partial<{ fail: boolean; value: unknown }> = {}) {
  const calls = new Map<string, number>();
  const registry = new SharedStreamPollerRegistry<Record<string, unknown>>({
    name: "test",
    intervalMs: 60_000, // long, so only explicit pollOnce calls run during a test
    produce: async (key: string) => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (overrides.fail) throw new Error("upstream 429");
      return (overrides.value as Record<string, unknown>) ?? { key };
    },
    ...silent(),
  });
  return { registry, calls };
}

describe("SharedStreamPollerRegistry", () => {
  it("makes one upstream call per key regardless of subscriber count", async () => {
    /*
     * The reason this exists. /stream/live-agent owned a 1s interval running three database queries
     * and a provider quote *per connected tab* -- 60 provider requests a minute for one dashboard,
     * 240 for four. On 2026-08-27 that tripped the provider's edge rate limiter for forty minutes.
     */
    const { registry, calls } = counting();
    const seen: unknown[] = [];
    const releases = [0, 1, 2, 3].map(() =>
      registry.subscribe("NIFTY50|1d", (value) => seen.push(value)));

    await registry.pollOnce("NIFTY50|1d");

    expect(registry.subscriberCount("NIFTY50|1d")).toBe(4);
    // One from the first subscribe's immediate poll, one explicit. Not one per subscriber.
    expect(calls.get("NIFTY50|1d")).toBeLessThanOrEqual(2);
    for (const release of releases) release();
    registry.stopAll();
  });

  it("keeps distinct keys independent", async () => {
    // Two tabs on different symbols genuinely need different data, so they must not share a poll.
    const { registry, calls } = counting();
    const a = registry.subscribe("NIFTY50|1d", () => {});
    const b = registry.subscribe("BANKNIFTY|5m", () => {});

    await registry.pollOnce("NIFTY50|1d");
    await registry.pollOnce("BANKNIFTY|5m");

    expect(registry.stats.keys).toBe(2);
    expect(calls.get("NIFTY50|1d")).toBeGreaterThan(0);
    expect(calls.get("BANKNIFTY|5m")).toBeGreaterThan(0);
    a();
    b();
    registry.stopAll();
  });

  it("replays the cached snapshot to a late subscriber without polling again", async () => {
    const { registry, calls } = counting();
    const first = registry.subscribe("NIFTY50|1d", () => {});
    await registry.pollOnce("NIFTY50|1d");
    const before = calls.get("NIFTY50|1d")!;

    const received: unknown[] = [];
    const second = registry.subscribe("NIFTY50|1d", (value) => received.push(value));

    expect(received).toHaveLength(1);
    expect(calls.get("NIFTY50|1d")).toBe(before);
    first();
    second();
    registry.stopAll();
  });

  it("tears a key down when its last subscriber leaves, and tolerates double release", async () => {
    /*
     * The key space is caller-supplied (`?symbol=&timeframe=`) and therefore unbounded, so retaining
     * state for departed keys would leak for the process's lifetime. Release is idempotent because a
     * stream can both close and error.
     */
    const { registry } = counting();
    const a = registry.subscribe("NIFTY50|1d", () => {});
    const b = registry.subscribe("NIFTY50|1d", () => {});
    expect(registry.stats.keys).toBe(1);

    a();
    a();
    expect(registry.subscriberCount("NIFTY50|1d")).toBe(1);

    b();
    expect(registry.subscriberCount("NIFTY50|1d")).toBe(0);
    expect(registry.stats.keys).toBe(0);
  });

  it("treats a null produce as 'not ready', not as a failure", async () => {
    // The live-agent payload needs two candles; fewer means nothing to publish yet, which must not
    // be reported as an outage or cached as a snapshot.
    const registry = new SharedStreamPollerRegistry<Record<string, unknown>>({
      name: "test",
      intervalMs: 60_000,
      produce: async () => null,
      ...silent(),
    });
    const data: unknown[] = [];
    const unavailable: number[] = [];
    const release = registry.subscribe("k", (v) => data.push(v), (n) => unavailable.push(n));

    await registry.pollOnce("k");

    expect(data).toHaveLength(0);
    expect(unavailable).toHaveLength(0);
    release();
    registry.stopAll();
  });

  it("notifies every subscriber on failure so no stream sends zero bytes", async () => {
    // An open socket delivering nothing is indistinguishable from a healthy connection that has not
    // ticked yet -- the state that made the original outage take a manual provider request to find.
    const { registry } = counting({ fail: true });
    const unavailable: number[] = [];
    const release = registry.subscribe("k", () => {}, (n) => unavailable.push(n));

    await registry.pollOnce("k");

    expect(unavailable.length).toBeGreaterThan(0);
    release();
    registry.stopAll();
  });

  it("retains the last good snapshot across a failure", async () => {
    let fail = false;
    const registry = new SharedStreamPollerRegistry<Record<string, unknown>>({
      name: "test",
      intervalMs: 60_000,
      produce: async () => {
        if (fail) throw new Error("upstream 429");
        return { ok: true };
      },
      ...silent(),
    });
    const first = registry.subscribe("k", () => {});
    await registry.pollOnce("k");

    fail = true;
    await registry.pollOnce("k");

    // Proven by a new subscriber still receiving the stale snapshot immediately.
    const received: unknown[] = [];
    const second = registry.subscribe("k", (v) => received.push(v));
    expect(received).toEqual([{ ok: true }]);
    first();
    second();
    registry.stopAll();
  });

  it("throttles failure logs per key and reports recovery", async () => {
    const logError = vi.fn();
    const log = vi.fn();
    let clock = 0;
    let fail = true;
    const registry = new SharedStreamPollerRegistry<Record<string, unknown>>({
      name: "test",
      intervalMs: 60_000,
      produce: async () => {
        if (fail) throw new Error("upstream 429");
        return { ok: true };
      },
      now: () => clock,
      log,
      logError,
    });
    const release = registry.subscribe("k", () => {});

    await registry.pollOnce("k");
    await registry.pollOnce("k");
    await registry.pollOnce("k");
    expect(logError).toHaveBeenCalledTimes(1);

    clock = 31_000;
    await registry.pollOnce("k");
    expect(logError).toHaveBeenCalledTimes(2);

    fail = false;
    await registry.pollOnce("k");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("recovered");
    release();
    registry.stopAll();
  });
});
