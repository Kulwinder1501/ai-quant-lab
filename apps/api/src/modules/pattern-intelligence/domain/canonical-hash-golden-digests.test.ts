import { describe, expect, it } from "vitest";
import {
  calculateObservationHash,
  calculateObservationLogicalKey,
  encodeCanonical,
  sha256CanonicalBytes,
} from "./canonical-hash.js";
import { sealObservation } from "./observation-validation.js";
import type { AnyDetectedPattern } from "./contracts.js";

/**
 * Golden pins for the V1.0.1 type-tagged byte encoding, recorded **before** the PIT adoption.
 *
 * ## Why these did not already exist, despite the docs saying they did
 *
 * `canonical-hash.ts` stated that "`pattern-intelligence.test.ts` pins both key sets and a golden
 * digest, so a change to either is a test failure rather than a silent re-identification of history."
 * The key sets are pinned. The digest was not: every observation-hash assertion in that file is
 * **self-referential** —
 *
 *     expect(calculateObservationHash(sealed)).toBe(sealed.provenance.observationHash);
 *     expect(sealed.provenance.observationHash).toBe(sha256CanonicalBytes(nested));
 *
 * — comparing a recomputation against a value produced by the same code in the same run. A change to
 * the encoder moves both sides together and every one of them still passes. The only hard-coded
 * digests in the module belong to `pattern-definition-registry.test.ts`, which pins *definition*
 * hashes.
 *
 * So the protection the comment promised was not there, and this file is what makes the claim true.
 * Recorded first, on purpose: a pin written after a change captures the change.
 *
 * ## What depends on these staying stable
 *
 * `pattern_observations_v2` stores both `observation_hash` and `logical_key`. The logical key is the
 * storage identity — the field a duplicate check rests on — so a shift in it would make a re-scan
 * insert a parallel copy of history rather than colliding with it, which is the entire point of the
 * key.
 */

/** Byte-for-byte deterministic: no clock, no UUID generation, no environment. */
function baseObservation(): AnyDetectedPattern {
  return {
    identity: { observationId: "0192f2a9-6cdb-7000-8000-000000000001", patternFamily: "SWEEP_RECLAIM", patternSubtype: "SPRING", orientation: "UP" },
    source: {
      exchange: "NSE", underlying: "NIFTY50", instrumentType: "FUTIDX", contractSymbol: "NIFTY26AUGFUT",
      contractExpiry: new Date("2026-08-27T00:00:00.000Z"), contractRole: "NEAR_MONTH", timeframe: "5m", timezone: "Asia/Kolkata",
      priceScale: 100, tickSize: 0.05, dataVintageId: "nse-feed:2026-08-25T09:15:00.000Z", dataVintageAt: new Date("2026-08-25T09:15:00.000Z"),
    },
    definitionRef: { definitionId: "sweep-reclaim-v1", definitionVersion: "1.0.0", definitionHash: "a".repeat(64) },
    timing: {
      startAt: new Date("2026-08-25T09:15:00.000Z"), dataThrough: new Date("2026-08-25T09:20:00.000Z"),
      detectedAt: new Date("2026-08-25T09:20:00.000Z"), knownAt: new Date("2026-08-25T09:20:01.000Z"),
      earliestExecutionAt: new Date("2026-08-25T09:25:00.000Z"),
    },
    geometry: { durationBars: 2, rangeBps: 12.5, rangeAtr: 0.8 },
    context: { trendState: "DOWN", sessionSegment: "OPENING", volumeZscore: 1.2, rangeZscore: 0.2, effortResultDivergence: 1 },
    details: { kind: "SWEEP_RECLAIM", subtype: "SPRING", wyckoffEquivalent: "SPRING", referenceLevel: 24500, penetrationExcursionBps: 4, reclaimDistanceBps: 7, rejectionWickBps: 5 },
    provenance: { engineVersion: "pi-v1", configVersion: "1.0.0", configHash: "b".repeat(64), dataSource: "nse-feed", dataSchemaVersion: "1", observationHash: "" },
  } as AnyDetectedPattern;
}

/** Exercises every branch: type tags, ULEB128 length prefixes, nesting, empties, non-ASCII. */
const PROBE: Record<string, unknown> = {
  zulu: "last",
  alpha: 1,
  "éaccent": "non-ascii key",
  nested: { b: [1, 2, { c: null }], a: new Date("2026-08-31T09:46:00.000Z") },
  negativeZero: -0,
  flags: [true, false],
  unicodeValue: "₹ — ·",
  empty: {},
  emptyList: [],
  /*
   * The pair that actually distinguishes UTF-8 byte order from UTF-16 code-unit order.
   *
   * An earlier version of this probe carried only `eaccent` (U+00E9) and could not tell them apart:
   * both orders place it last, because its leading UTF-8 byte (0xC3) and its code unit (233) each
   * exceed `z`. Verified by mutation -- swapping `Buffer.compare` for `<` passed all 73 tests, so the
   * assertion below was previously true by luck rather than by construction.
   *
   * The orders diverge only above U+FFFF, where a surrogate pair's code units (0xD800-0xDBFF) sort
   * *below* a high-BMP character: U+FFFD precedes U+1F600 by code point, and follows it by code unit.
   */
  "\uFFFD_high_bmp": "sorts before astral by code point",
  "\u{1F600}_astral": "sorts after high BMP by code point",
};

describe("canonical byte encoding golden pins (pre-PIT-adoption)", () => {
  it("pins the scalar byte encodings, tag by tag", () => {
    /*
     * The tags are the encoding. A rewrite that renumbered them, dropped a length prefix, or emitted
     * a number as its IEEE bytes would still produce a plausible 32-byte digest and pass every
     * self-referential test.
     */
    expect(encodeCanonical(null).toString("hex")).toBe("04");
    expect(encodeCanonical(true).toString("hex")).toBe("0301");
    expect(encodeCanonical("").toString("hex")).toBe("0100");
    expect(encodeCanonical(new Date("2026-08-31T09:46:00.000Z")).toString("hex"))
      .toBe("0518323032362d30382d33315430393a34363a30302e3030305a");
  });

  it("normalises negative zero to the same bytes as zero", () => {
    // Not cosmetic: two encodings of the same number would split one observation's identity in two.
    expect(encodeCanonical(-0).toString("hex")).toBe("020130");
    expect(encodeCanonical(0).toString("hex")).toBe("020130");
  });

  it("sorts object keys by UTF-8 byte order, not by collation", () => {
    /*
     * The line that distinguishes this encoder from the JSON one in the platform identity module.
     * That encoder sorts with `localeCompare`, which places `éaccent` between `big` and `flags`; this
     * one compares UTF-8 bytes, which places it **last**, after `zulu`.
     *
     * Pinning it here is what stops a future "consolidation" swapping one for the other on the
     * grounds that both are "sorted".
     */
    const hex = encodeCanonical(PROBE).toString("hex");
    const keyAt = (key: string): number => hex.indexOf(Buffer.from(key, "utf8").toString("hex"));

    expect(keyAt("alpha")).toBeLessThan(keyAt("zulu"));
    expect(keyAt("zulu")).toBeLessThan(keyAt("éaccent"));
    // The discriminating assertion: by code point U+FFFD precedes U+1F600, and by UTF-16 code unit it
    // does not. Only a pair straddling U+FFFF can tell the two orderings apart.
    expect(keyAt("\uFFFD_high_bmp")).toBeLessThan(keyAt("\u{1F600}_astral"));
    // And the first key really is `alpha`: object tag 07, ULEB128 count 0b (11 keys), then length 05.
    expect(hex.startsWith("070b" + "05" + Buffer.from("alpha", "utf8").toString("hex"))).toBe(true);
  });

  it("pins the probe's byte length and digest", () => {
    // Length as well as digest, so a failure says whether the shape or only the content moved.
    expect(encodeCanonical(PROBE).length).toBe(286);
    expect(sha256CanonicalBytes(PROBE))
      .toBe("9b87f6938a54e28562113ed5f814e0a55bb051f9fdfe7adcd918e9d28123b5c2");
  });

  it("pins the observation hash for a fixed observation", () => {
    // The assertion that was missing. Every existing observation-hash test compares the code to
    // itself; this one compares it to a value recorded before the change.
    const sealed = sealObservation(baseObservation());

    expect(sealed.provenance.observationHash)
      .toBe("13a8be9b4d7d4a482efb66550c4abc6cae1cb38122be23c4565b5010f8715090");
    expect(calculateObservationHash(sealed)).toBe(sealed.provenance.observationHash);
  });

  it("pins the observation logical key, which is the storage identity", () => {
    /*
     * The more important of the two. `logical_key` is what a duplicate check rests on, so a shift in
     * it makes a re-scan insert a parallel copy of history instead of colliding with it.
     *
     * It also excludes `timing.knownAt`, `earliestExecutionAt`, all of `provenance` and all of
     * `context` -- deliberately, because those vary with when the detector ran. The next test proves
     * that exclusion still holds, which is what makes the PIT adoption safe for storage identity.
     */
    const sealed = sealObservation(baseObservation());

    expect(calculateObservationLogicalKey(sealed))
      .toBe("e519c92d9287ffcf778c0905181fe3094bbdcce3d1cad6267fc321b4b653ce9c");
  });

  it("keeps the logical key independent of earliestExecutionAt and knownAt", () => {
    /*
     * Directly relevant to adopting the shared PIT primitive: if the derivation ever produced a
     * different instant, storage identity must not move. A backfill pass and a live pass over the
     * same bar have to collide.
     */
    const original = sealObservation(baseObservation());
    const shifted = sealObservation({
      ...baseObservation(),
      timing: {
        ...baseObservation().timing,
        knownAt: new Date("2026-08-25T09:21:30.000Z"),
        earliestExecutionAt: new Date("2026-08-25T09:30:00.000Z"),
      },
    });

    expect(calculateObservationLogicalKey(shifted)).toBe(calculateObservationLogicalKey(original));
    // But the observation hash *does* move, because it covers timing. Both facts are load-bearing.
    expect(shifted.provenance.observationHash).not.toBe(original.provenance.observationHash);
  });
});
