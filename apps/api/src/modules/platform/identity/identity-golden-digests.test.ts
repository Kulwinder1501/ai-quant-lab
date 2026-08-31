import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  logicalKey,
  researchIdentityEncodingVersion,
  sha256Canonical,
} from "./identity.js";

/**
 * Golden digest pins for `canonical-json-sha256-v1`, recorded **before** the Platform P0 relocation.
 *
 * ## Why these exist and why they were written first
 *
 * Platform P0 moves this implementation into the shared platform identity package. The readiness plan
 * calls for it to be *relocated verbatim* rather than unified with the repository's three other
 * canonicalizers, because two of those export a function of the same name with different byte
 * semantics, and live research rows depend on these digests:
 *
 *   research_scalp.terminal_settlements   9,218 rows
 *   research_scalp.study_trials             180 rows
 *   Phase 29 D2 sessions under a pinned parent hash   9
 *
 * The ordering is the point. A golden test authored *after* the move pins whatever the moved code
 * produces, which proves nothing — it would pass even if the relocation silently changed the
 * encoding. Every literal below was emitted by this file's `./identity.js` at commit `afe91c0`,
 * before anything moved, and must survive the move unchanged.
 *
 * This file travels with the implementation. If it is ever separated from `identity.ts`, the pin is
 * worthless.
 *
 * ## Relocation outcome
 *
 * The move out of `modules/research/scalp-harness/domain/` into `modules/platform/identity/` is done
 * and these pins passed unchanged at the new location. Two further pieces of evidence were recorded
 * for the D1 gate, because a passing fixture alone would not have settled it:
 *
 * - `git` reports the move as **R100** on all three files — byte-identical content, not merely a
 *   test that happens to agree.
 * - 1,500 keys already persisted by the pre-move code (500 each of `proposalKey`, `controlPointKey`
 *   and `opportunityKey`) were recomputed through the relocated module with **zero mismatches**. That
 *   covers every date, direction and policy-version string actually in use, which a fixture chosen
 *   today cannot.
 *
 * ## Known constraint: the digest depends on the runtime's collation, not only on this source
 *
 * `canonicalJson` sorts object keys with `String.prototype.localeCompare`, which is ICU-backed and
 * therefore locale- and build-dependent. It is **not** UTF-8 byte order: the probe below contains a
 * key `"éaccent"`, and under collation it sorts between `"big"` and `"flags"` (as though it were
 * `"eaccent"`), where byte order would place it last, after `"zulu"`. A Node build without full ICU,
 * or a different default locale, can therefore change the digest of any object carrying a non-ASCII
 * key **without a single character of this source changing**.
 *
 * Real payloads key on code identifiers, so the practical exposure is close to nil — but "relocate
 * verbatim" is necessary and not sufficient, and this is the gap. `sortsKeysByCollationNotByteOrder`
 * below fails loudly and specifically if that assumption ever breaks, so a collation change is
 * diagnosed as itself rather than as an unexplained digest mismatch.
 */

/** Exercises every branch of the encoder: nesting, arrays, Date, -0, bigint, boolean, null, non-ASCII. */
const PROBE = {
  zulu: "last",
  alpha: 1,
  "éaccent": "non-ascii key",
  nested: { b: [1, 2, { c: null }], a: new Date("2026-08-31T09:46:00.000Z") },
  negativeZero: -0,
  big: 9007199254740993n,
  flags: [true, false],
  unicodeValue: "₹ — ·",
};

/** The canonical 8-field proposal tuple, in the exact order `buildProposal` passes it. */
const PROPOSAL_FIELDS = [
  "a".repeat(64),
  "instrument-1",
  "1m",
  "LONG",
  new Date("2026-08-31T09:46:00.000Z"),
  new Date("2026-08-31T09:45:59.999Z"),
  "MOMENTUM_PULLBACK",
  "b".repeat(64),
];

/**
 * Every namespace the system actually writes, each keyed on the same fixed field list.
 *
 * Enumerated rather than sampled: `logicalKey` mixes the namespace into the hashed envelope, so a
 * change to that envelope shifts all eighteen. Pinning one would catch it, but pinning all eighteen
 * is what proves no namespace was quietly renamed or dropped during the move.
 */
const NAMESPACE_DIGESTS: Readonly<Record<string, string>> = {
  "control-match": "bbc91ba6b03c62b94d5f96124f213087240268277e1346d5f85de0e4e767eb45",
  "control-point": "08d77b60e7ad035999b8a0bf18dced6d92ea71de7b7714aedb2b0107c7a15fac",
  "control-rank": "57ce9346690b4467128eedc9f0e58ceef923f70bb5330c5e3e26c19d64fc6e48",
  "control-seed": "3aa49aa67d18909425522ddb02d6ed0ac4cf7b076807cd117746e9d54a399c38",
  "event": "c3fa209b8e27fba88bed50b2529e5e6add1eaa8935e986423a1a26f3d996931a",
  "opportunity": "3aae8ff6d13969122c13b9c2540410b4409cc4acef31a02381f25f8fc4179f83",
  "opportunity-membership": "aba4f6118bfc4aa5aa3313d0c2c33b446fc30e77a885b7c75289ffde1d3255c8",
  "path-study-run": "320a728e4e522f82d13e0770204e59bbbc9293e1f82b297be6e0dabce2394247",
  "path-study-trial": "b0f2f4f216785784cef1921d0df8c40b76ec06757cbb78b527573f279f631001",
  "proposal": "6cebcaf810834b351c13de75e73f9d8aeffffb46e4e8cd94e3aee7905fda07e4",
  "risk-decision": "0606f97c1fbd5ca5b96333adc41056b9a1f72e445e7287a2fc927288cdb4803b",
  "risk-snapshot": "a2b440f6720b45eac2810361e21805ee8ddc9b3c1a243ca8b9dbd15e65961997",
  "risk-subject": "8ce8c7b586284bc739ca99443d7efab26f7e6f1c44a7d30941ff33e094742997",
  "settlement-observation": "d88e370c546003602eaf311462528da284681fe998ef57648d027ccbe168c345",
  "settlement-policy-definition": "9ffd63424ac132728aeddd511b618a6ddca4595f5e4c1f132f3a72be0368028a",
  "setup-fingerprint": "5fa178dd63c472dda200737588cedbd614af50870b740c15eaa95c6aafb6aaf8",
  "strategy-definition": "93814b9c4117913eb44e3238e95ff2de26eed763221df3f80dd660a035176767",
  "terminal-settlement": "62eafdfe7da50762cd0595dbcfc849d4bc0b507626066c87d252fd5adbea8bec",
};

describe("canonical-json-sha256-v1 golden pins (pre-relocation)", () => {
  it("keeps the encoding version string", () => {
    // Stored on research rows as `researchIdentityEncodingVersion`. Changing it is a new encoding.
    expect(researchIdentityEncodingVersion).toBe("canonical-json-sha256-v1");
  });

  it("produces the recorded canonical byte string for the probe value", () => {
    expect(canonicalJson(PROBE)).toBe(
      '{"alpha":1,"big":"9007199254740993","éaccent":"non-ascii key",'
      + '"flags":[true,false],"negativeZero":0,'
      + '"nested":{"a":"2026-08-31T09:46:00.000Z","b":[1,2,{"c":null}]},'
      + '"unicodeValue":"₹ — ·","zulu":"last"}',
    );
  });

  it("produces the recorded digest for the probe value", () => {
    expect(sha256Canonical(PROBE)).toBe("5cf2a2a75f71b1e9f0adf904f11865978b7c8f05eba7434ce4abc2df0b8932bb");
  });

  it("keeps the scalar encodings that a rewrite would most plausibly change", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson(null)).toBe("null");
    // Negative zero normalises to "0". A rewrite using plain JSON.stringify would emit "0" too, but
    // one using String(-0) would emit "0" and one using a template would emit "0" -- the pin is here
    // because the *sign* surviving would silently split identities for the same number.
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(0)).toBe("0");
    // BigInt becomes a quoted decimal string, not a number. Dropping the quotes would collide a
    // bigint with the equal-valued number.
    expect(canonicalJson(9007199254740993n)).toBe('"9007199254740993"');
    expect(canonicalJson(new Date("2026-08-31T09:46:00.000Z"))).toBe('"2026-08-31T09:46:00.000Z"');
  });

  it("sorts keys by collation, not by byte order", () => {
    /*
     * Pins the runtime assumption, not the source. `localeCompare` is ICU-backed, so a Node build
     * without full ICU can change this with no source change at all. If this test fails while the
     * others still pass, the cause is the runtime's collation and not an edit to identity.ts.
     */
    const encoded = canonicalJson({ zulu: 1, "éaccent": 2, big: 3 });

    expect(encoded).toBe('{"big":3,"éaccent":2,"zulu":1}');
    // Byte order would place the non-ASCII key last; collation places it between b and z.
    expect(encoded.indexOf("éaccent")).toBeLessThan(encoded.indexOf("zulu"));
  });

  it("produces the recorded proposalKey for the canonical 8-field tuple", () => {
    // The identity behind RESEARCH CANDIDATE = PRODUCTION CANDIDATE. Production reproducing a
    // different value here is a hard promotion blocker, so this digest is the reference both sides
    // are measured against.
    expect(logicalKey("proposal", PROPOSAL_FIELDS))
      .toBe("fc72d666b8d44311c7d0cadb47317392642ee173dfbb8ad7d9139746e276c3ec");
  });

  it("produces the recorded digest for every namespace in use", () => {
    for (const [namespace, digest] of Object.entries(NAMESPACE_DIGESTS)) {
      expect(logicalKey(namespace, ["fixed", 1, true]), namespace).toBe(digest);
    }
  });

  it("still refuses the values the encoding cannot represent", () => {
    // Part of the contract, not incidental: an identity that silently accepted undefined or NaN would
    // let two different objects share a key.
    expect(() => canonicalJson(undefined)).toThrow(/undefined/i);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/i);
    expect(() => canonicalJson(new Date("nope"))).toThrow(/invalid dates/i);
    expect(() => logicalKey("  ", ["x"])).toThrow(/namespace is required/i);
  });
});
