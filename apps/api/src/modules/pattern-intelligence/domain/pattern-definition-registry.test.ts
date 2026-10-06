import { describe, expect, it } from "vitest";
import { calculateDefinitionHash } from "./canonical-hash.js";
import type { PatternFamily } from "./contracts.js";
import {
  assertDefinitionRegistrable,
  definitionIdForFamily,
  registeredPatternDefinitions,
  StaticPatternDefinitionRegistry,
} from "./pattern-definition-registry.js";

/**
 * The pinned definition hashes.
 *
 * This map is the ratchet the Implementation Gate was protecting. Changing any threshold, note or
 * invalidation condition in a frozen record changes its hash and fails here, so a detection rule
 * cannot move without someone either registering a new `definitionVersion` or consciously restating
 * the pin. Left unpinned, the registry would only document the rules — it would not hold them.
 */
const pinnedDefinitionHashes: Readonly<Record<string, string>> = {
  "pattern-intelligence.sweep-reclaim": "3d8b6d3a0b0506be766ced0801aeeb860465fc72054fa1d6a87ceb93181f7f27",
  "pattern-intelligence.breakout-state": "ee593f8522cbfefd408a024cb95fd8b98efb09aca39812e303fdb4199e595905",
  "pattern-intelligence.compression-expansion": "fa4090846ade56eb973e9898367513d463d3ed7565b254da092441f13c50512c",
  "pattern-intelligence.opening-structure": "f802467322087493eb3a901be3cb946abe6d6bc3209124255422c4ca11a71b07",
  "pattern-intelligence.gap-structure": "25a696c03224a1183d8e78af7113c3b1826a7832d671d6c5ea3ddc7a50f5fbdd",
  "pattern-intelligence.level-interaction": "20021f4e38586d69a7b3f909fc60b07346cd2e680f153a533f317d4d6098252d",
  "pattern-intelligence.swing-structure": "5f252776736f2874be77d7557d93fb33e2ed08130e36b1053f4d7c62fee74ffe",
  "pattern-intelligence.effort-result": "a4fcc20e9dfc50055ba889c9b5f743d331b8e14e6bbb0867a0d89941a03d80a0",
  "pattern-intelligence.candle-geometry": "625f0d511f088d90a77729dfc58664003f6dfb099aa60462bb9b5015afbdf84b",
  "pattern-intelligence.multi-candle": "f4636280f1b7b564976a14797a66289967f6ba2f83acce6bb5cf3a693a2979b2",
  "pattern-intelligence.classical-reversal": "8b40c4ca0bbc7399a6c8f8e3cf59675dc3afc8d2ebf2fcfb0ef12f558167ca5c",
  "pattern-intelligence.continuation-structure": "4d64aa3427a28d92cfe90b72deaa28e84b4278202503032ecefdcee067e95cd7",
};

/** The families with an implemented engine. Not the whole taxonomy — see the registry docstring. */
const implementedFamilies: readonly PatternFamily[] = [
  "SWEEP_RECLAIM", "BREAKOUT_STATE", "COMPRESSION_EXPANSION", "OPENING_STRUCTURE", "GAP_STRUCTURE",
  "LEVEL_INTERACTION", "SWING_STRUCTURE", "EFFORT_RESULT", "CANDLE_GEOMETRY", "MULTI_CANDLE",
  "CLASSICAL_REVERSAL", "CONTINUATION_STRUCTURE",
];

describe("Pattern Definition Registry", () => {
  it("pins every frozen definition hash so a threshold cannot move silently", () => {
    for (const definition of registeredPatternDefinitions) {
      expect(pinnedDefinitionHashes[definition.definitionId]).toBeDefined();
      expect(definition.definitionHash).toBe(pinnedDefinitionHashes[definition.definitionId]);
    }
    // No pin without a record, so a deleted definition fails here rather than passing vacuously.
    expect(Object.keys(pinnedDefinitionHashes).sort())
      .toEqual(registeredPatternDefinitions.map((d) => d.definitionId).sort());
  });

  it("computes each pinned hash from the record's own canonical payload", () => {
    for (const definition of registeredPatternDefinitions) {
      expect(calculateDefinitionHash(definition)).toBe(definition.definitionHash);
    }
  });

  it("covers exactly the twelve implemented families, once each", () => {
    const families = registeredPatternDefinitions.map((d) => d.family);
    expect(families).toHaveLength(12);
    expect([...families].sort()).toEqual([...implementedFamilies].sort());
    expect(new Set(families).size).toBe(families.length);
  });

  it("registers no definition for a family with no detector", () => {
    // AUCTION_PROFILE needs near-month FUTIDX contracts and a TRADE_VAP/VENDOR_VAP store; the
    // database has neither. The rest are taxonomy entries with no engine behind them. A definition
    // here would assert a detector exists.
    for (const family of ["AUCTION_PROFILE", "WYCKOFF_EVENT", "WYCKOFF_STATE", "RELATIVE_STRUCTURE", "HARMONIC", "BROADENING_STRUCTURE"] as const) {
      expect(definitionIdForFamily(family)).toBeNull();
    }
  });

  it("requires an invalidation condition on every record, not just detection rules", () => {
    // The Implementation Gate names invalidation explicitly. A detector that can fire but never
    // expire produces observations that are never wrong, which is worse than none.
    for (const definition of registeredPatternDefinitions) {
      expect(definition.invalidationConditions.length).toBeGreaterThan(0);
      expect(() => assertDefinitionRegistrable(definition)).not.toThrow();
    }
  });

  it("marks all V1.0.1 records as derived from their implementation", () => {
    // Honest provenance: these were reconstructed from twelve already-written engines, so they
    // document the detectors rather than having constrained them. The flag exists so a later reader
    // cannot mistake the retrofit for a pre-registration.
    for (const definition of registeredPatternDefinitions) {
      expect(definition.derivedFromImplementation).toBe(true);
    }
  });

  it("rejects a record that cannot serve as a frozen registration", () => {
    const valid = registeredPatternDefinitions[0]!;
    expect(() => assertDefinitionRegistrable({ ...valid, definitionId: "sweep-reclaim-spring" })).toThrow(/namespaced/);
    expect(() => assertDefinitionRegistrable({ ...valid, definitionVersion: "1" })).toThrow(/definitionVersion/);
    expect(() => assertDefinitionRegistrable({ ...valid, parameters: {} })).toThrow(/nothing is actually frozen/);
    expect(() => assertDefinitionRegistrable({ ...valid, invalidationConditions: [] })).toThrow(/invalidation condition/);
  });

  it("serves only frozen records, so an unregistered detector cannot persist", async () => {
    const registry = new StaticPatternDefinitionRegistry();
    const found = await registry.findFrozen({
      definitionId: "pattern-intelligence.sweep-reclaim", definitionVersion: "1.0.0",
    });
    expect(found?.definitionHash).toBe(pinnedDefinitionHashes["pattern-intelligence.sweep-reclaim"]);

    // A version that was never frozen is absent, not silently upgraded to the nearest one.
    expect(await registry.findFrozen({
      definitionId: "pattern-intelligence.sweep-reclaim", definitionVersion: "1.1.0",
    })).toBeNull();
    expect(await registry.findFrozen({
      definitionId: "pattern-intelligence.auction-profile", definitionVersion: "1.0.0",
    })).toBeNull();
  });
});
