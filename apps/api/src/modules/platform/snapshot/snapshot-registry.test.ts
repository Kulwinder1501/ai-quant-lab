import { describe, expect, it } from "vitest";
import { runSnapshotRegistryContract } from "./testing/snapshot-registry-contract.js";
import { InMemorySnapshotRegistry } from "./snapshot-registry.js";
import { snapshotBytesFor, snapshotRefFor } from "./snapshot-ref.js";

// The reference implementation is held to the same invariants Brain P2's store will be. When that
// exists, its test file imports this same suite rather than restating it.
runSnapshotRegistryContract("InMemorySnapshotRegistry", () => new InMemorySnapshotRegistry());

describe("snapshot identity", () => {
  it("carries the encoding version as part of the reference", () => {
    // A reference that did not say which encoder produced it could be resolved against the wrong one,
    // and a future encoder is a different address space rather than a format detail.
    expect(snapshotRefFor({ a: 1 })).toEqual({
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      encodingVersion: "canonical-json-sha256-v1",
    });
  });

  it("is frozen, so a reference cannot be edited after it is derived", () => {
    const ref = snapshotRefFor({ a: 1 });

    expect(Object.isFrozen(ref)).toBe(true);
    expect(() => { (ref as { snapshotId: string }).snapshotId = "x".repeat(64); }).toThrow();
  });

  it("addresses the exact bytes an immutable store must keep", () => {
    // The bytes are the unit of the guarantee, so the helper that produces them and the helper that
    // hashes them must not be able to disagree about what was sealed.
    const content = { b: 2, a: new Date("2026-08-31T09:46:00.000Z") };

    expect(snapshotBytesFor(content)).toBe('{"a":"2026-08-31T09:46:00.000Z","b":2}');
  });
});

describe("InMemorySnapshotRegistry deduplication", () => {
  it("stores one copy for repeated identical content", async () => {
    /*
     * The property that makes copy-on-seal affordable. A 1-minute grid produces hundreds of decisions
     * a session over heavily overlapping bar sets; without dedup, copying would be untenable and the
     * design would collapse back to storing queries.
     */
    const registry = new InMemorySnapshotRegistry();
    const content = { bars: [1, 2, 3] };

    await registry.seal(content);
    await registry.seal({ bars: [1, 2, 3] });
    await registry.seal(content);

    expect(registry.size).toBe(1);
  });

  it("keeps distinct content distinct", async () => {
    const registry = new InMemorySnapshotRegistry();

    await registry.seal({ bars: [1, 2, 3] });
    await registry.seal({ bars: [1, 2, 4] });

    expect(registry.size).toBe(2);
  });
});
