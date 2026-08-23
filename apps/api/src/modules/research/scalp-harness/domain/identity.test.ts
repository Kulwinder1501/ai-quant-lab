import { describe, expect, it } from "vitest";
import { canonicalJson, logicalKey, sha256Canonical } from "./identity.js";

describe("scalp research identities", () => {
  it("canonicalizes object order and UTC dates", () => {
    const left = { z: 2, a: new Date("2026-08-22T10:00:00+05:30") };
    const right = { a: new Date("2026-08-22T04:30:00.000Z"), z: 2 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
  });

  it("namespaces logical keys and rejects lossy values", () => {
    expect(logicalKey("proposal", ["a"])).not.toBe(logicalKey("opportunity", ["a"]));
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
  });
});
