import { describe, expect, it } from "vitest";
import { snapshotRefFor, type SnapshotRef } from "../snapshot-ref.js";
import type { SnapshotRegistry } from "../snapshot-registry.js";

/**
 * The invariant suite every `SnapshotRegistry` implementation must pass.
 *
 * Exported from a non-test file on purpose: Brain P2's Postgres-backed registry and the in-memory
 * reference implementation have to be held to the *same* assertions, and a suite copied into two test
 * files drifts. The cost is that this file imports `vitest` from `src/`. It is only ever imported by
 * test files, so nothing in the runtime path loads it, and the alternative — two hand-maintained
 * copies of the invariant that protects replay — is worse.
 *
 * The centre of this suite is `resolves identically after the source data has been healed`. That is
 * not a hypothetical: index candle gaps self-heal nightly at 16:18, append-only, and the healer runs
 * before the gap detector so a repair is routine rather than exceptional. An implementation that
 * resolves a reference by re-querying its source passes every other test here and fails that one.
 */
export function runSnapshotRegistryContract(
  implementationName: string,
  createRegistry: () => SnapshotRegistry,
): void {
  describe(`SnapshotRegistry contract: ${implementationName}`, () => {
    /** A sealed decision context: bars through a decision instant, as a caller would seal it. */
    const contextAt = (bars: readonly { openTime: string; close: number }[]) => ({
      instrumentId: "instrument-1",
      timeframe: "1m",
      decisionAt: new Date("2026-08-31T09:46:00.000Z"),
      bars: bars.map((bar) => ({ openTime: new Date(bar.openTime), close: bar.close })),
    });

    const threeBars = contextAt([
      { openTime: "2026-08-31T09:43:00.000Z", close: 24_300 },
      { openTime: "2026-08-31T09:44:00.000Z", close: 24_305 },
      { openTime: "2026-08-31T09:45:00.000Z", close: 24_312 },
    ]);

    it("resolves to the exact bytes that were sealed", async () => {
      const registry = createRegistry();
      const ref = await registry.seal(threeBars);

      expect(await registry.resolve(ref)).toBe(await registry.resolve(ref));
      expect(await registry.resolve(ref)).toContain("24312");
    });

    it("resolves identically after the source data has been healed", async () => {
      /*
       * I21, and the reason content addressing is not optional here.
       *
       * The nightly healer appends missing bars *into historical ranges*, so a reference meaning
       * "everything through T" resolves to a different row set after a repair -- same reference,
       * different data, no error raised. Here the heal is simulated the way it actually happens: a bar
       * that was missing at seal time appears afterwards, in the middle of the range.
       *
       * A registry that stored a query and re-ran it would return four bars on the second resolve and
       * pass every other test in this suite.
       */
      const registry = createRegistry();
      const sealedBytes = await registry.seal(threeBars).then((ref) => registry.resolve(ref));
      const ref = snapshotRefFor(threeBars);

      /*
       * Assert the sealed bytes are substantive before comparing anything to them.
       *
       * Without this the test passes vacuously against an implementation whose `resolve` returns the
       * same empty or undefined value both times -- `toBe(sealedBytes)` is then a tautology. Caught
       * by running this suite against a deliberately-wrong registry, which slipped through the
       * comparison while failing elsewhere.
       */
      expect(typeof sealedBytes).toBe("string");
      expect(sealedBytes).toContain("24312");
      expect(sealedBytes).not.toContain("24307");

      // The 09:44 gap is filled by the healer, after sealing.
      const healed = contextAt([
        { openTime: "2026-08-31T09:43:00.000Z", close: 24_300 },
        { openTime: "2026-08-31T09:44:00.000Z", close: 24_305 },
        { openTime: "2026-08-31T09:44:30.000Z", close: 24_307 },
        { openTime: "2026-08-31T09:45:00.000Z", close: 24_312 },
      ]);
      await registry.seal(healed);

      const afterHeal = await registry.resolve(ref);
      expect(afterHeal).toBe(sealedBytes);
      // Stated independently of the comparison above: the healed bar must not have leaked in, which
      // is the concrete symptom of a registry that re-read its source.
      expect(afterHeal).not.toContain("24307");
      expect(snapshotRefFor(threeBars).snapshotId).toBe(ref.snapshotId);
      // And the healed content is a *different* snapshot, not an update to this one.
      expect(snapshotRefFor(healed).snapshotId).not.toBe(ref.snapshotId);
    });

    it("gives identical content one address, and stores it once", async () => {
      const registry = createRegistry();
      const first = await registry.seal(threeBars);
      const second = await registry.seal(contextAt([
        { openTime: "2026-08-31T09:43:00.000Z", close: 24_300 },
        { openTime: "2026-08-31T09:44:00.000Z", close: 24_305 },
        { openTime: "2026-08-31T09:45:00.000Z", close: 24_312 },
      ]));

      expect(second.snapshotId).toBe(first.snapshotId);
      expect(await registry.resolve(second)).toBe(await registry.resolve(first));
    });

    it("gives different content different addresses, down to a single value", async () => {
      const registry = createRegistry();
      const ref = await registry.seal(threeBars);
      const nudged = await registry.seal(contextAt([
        { openTime: "2026-08-31T09:43:00.000Z", close: 24_300 },
        { openTime: "2026-08-31T09:44:00.000Z", close: 24_305 },
        { openTime: "2026-08-31T09:45:00.000Z", close: 24_312.05 },
      ]));

      expect(nudged.snapshotId).not.toBe(ref.snapshotId);
    });

    it("is insensitive to key order but sensitive to array order", async () => {
      // Key order is not information; bar order is. A registry that canonicalised arrays would make
      // two different series share an address.
      const registry = createRegistry();
      const forward = await registry.seal({ a: 1, bars: [1, 2, 3] });
      const reordered = await registry.seal({ bars: [1, 2, 3], a: 1 });
      const reversed = await registry.seal({ a: 1, bars: [3, 2, 1] });

      expect(reordered.snapshotId).toBe(forward.snapshotId);
      expect(reversed.snapshotId).not.toBe(forward.snapshotId);
    });

    it("throws rather than returning empty for a reference it does not hold", async () => {
      /*
       * A missing snapshot must not be indistinguishable from an empty one. If `resolve` returned
       * null, a decision replayed against a lost context would look like a legitimate no-op -- the
       * same conflation that made an earlier collector outage invisible, where "we have not looked"
       * and "it broke" shared a value.
       */
      const registry = createRegistry();
      const unknown = snapshotRefFor({ never: "sealed" });

      expect(await registry.has(unknown)).toBe(false);
      await expect(registry.resolve(unknown)).rejects.toThrow(/not in this registry/);
    });

    it("refuses a reference from a different encoding rather than resolving it", async () => {
      const registry = createRegistry();
      const ref = await registry.seal(threeBars);
      const foreign: SnapshotRef = { snapshotId: ref.snapshotId, encodingVersion: "some-future-encoding-v9" };

      // The bytes for that id are present, so a lax implementation would happily return them under
      // an encoding it does not speak.
      await expect(registry.resolve(foreign)).rejects.toThrow(/different address space|cannot resolve/);
    });

    it("refuses a malformed reference", async () => {
      const registry = createRegistry();

      await expect(registry.resolve({ snapshotId: "not-a-digest", encodingVersion: "canonical-json-sha256-v1" }))
        .rejects.toThrow(/lowercase SHA-256 digest/);
      await expect(registry.resolve({ snapshotId: "A".repeat(64), encodingVersion: "canonical-json-sha256-v1" }))
        .rejects.toThrow(/lowercase SHA-256 digest/);
    });

    it("refuses content that has no stable representation", async () => {
      /*
       * Inherited from the pinned identity encoder, and load-bearing. `undefined` and `NaN` have no
       * canonical form, so two materially different contexts could otherwise seal to one address --
       * silently, since both would look like well-formed snapshots.
       */
      const registry = createRegistry();

      await expect(registry.seal({ bars: [1], gap: undefined })).rejects.toThrow(/undefined/i);
      await expect(registry.seal({ bars: [Number.NaN] })).rejects.toThrow(/non-finite/i);
      await expect(registry.seal({ at: new Date("nope") })).rejects.toThrow(/invalid dates/i);
    });

    it("produces an address that depends on nothing but the content", async () => {
      // No clock, no counter, no process identity. Two registries that never met must agree, or a
      // reference cannot survive being written down and resolved elsewhere.
      const first = createRegistry();
      const second = createRegistry();

      expect((await first.seal(threeBars)).snapshotId).toBe((await second.seal(threeBars)).snapshotId);
    });
  });
}
