import { describe, expect, it } from "vitest";
import { captureRunProvenance, describeRunProvenance } from "./run-provenance.js";

const at = new Date("2026-08-24T12:00:00.000Z");

describe("captureRunProvenance", () => {
  it("records the commit and whether the tree was dirty", () => {
    // Runs against this repository, so it exercises the real git path rather than a stub.
    const provenance = captureRunProvenance(at);

    expect(provenance.capturedAt).toBe("2026-08-24T12:00:00.000Z");
    expect(provenance.runnerNodeVersion).toBe(process.version);
    if (provenance.codeVersion !== null) {
      expect(provenance.codeVersion).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof provenance.codeDirty).toBe("boolean");
      expect(provenance.unavailableReason).toBeNull();
    } else {
      // Never silently absent: a null SHA must carry its reason.
      expect(provenance.unavailableReason).toBeTruthy();
      expect(provenance.codeDirty).toBeNull();
    }
  });
});

describe("describeRunProvenance", () => {
  it("says plainly that a dirty run is not reproducible from its SHA", () => {
    const line = describeRunProvenance({
      codeVersion: "a".repeat(40),
      codeDirty: true,
      runnerNodeVersion: "v22.0.0",
      capturedAt: at.toISOString(),
      unavailableReason: null,
    });

    expect(line).toContain("aaaaaaaaaaaa");
    expect(line).toMatch(/DIRTY — not reproducible/);
  });

  it("marks a clean run as clean", () => {
    const line = describeRunProvenance({
      codeVersion: "b".repeat(40),
      codeDirty: false,
      runnerNodeVersion: "v22.0.0",
      capturedAt: at.toISOString(),
      unavailableReason: null,
    });

    expect(line).toContain("(clean)");
  });

  it("distinguishes unavailable provenance from a clean run", () => {
    // The failure this prevents: "no git available" rendering as an empty SHA and reading as clean.
    const line = describeRunProvenance({
      codeVersion: null,
      codeDirty: null,
      runnerNodeVersion: "v22.0.0",
      capturedAt: at.toISOString(),
      unavailableReason: "git not found",
    });

    expect(line).toMatch(/unavailable \(git not found\)/);
    expect(line).not.toContain("clean");
  });
});
