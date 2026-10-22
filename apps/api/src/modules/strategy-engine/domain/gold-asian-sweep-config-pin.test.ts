import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  goldAsianSweepStrategyRegistration,
  goldAsianSweepStrategyVersion,
} from "./gold-asian-sweep-strategy.js";

/*
 * A registered strategy version's configuration is immutable: the repository refuses to re-register a
 * version under a changed configuration, so editing the defaults without bumping the version fails at the
 * first gold-bot pass with STRATEGY_FAILED, in the database rather than in CI. This is how
 * `gold-asian-sweep-v1` was caught on 2026-10-22: a version-1 row had been registered from the first commit's
 * configuration, and the corrected configuration could no longer be registered under 1.
 *
 * If this test fails, you changed the configuration. Bump `goldAsianSweepStrategyVersion`, then update both
 * constants below in the same commit.
 */
const EXPECTED_VERSION = 2;
const EXPECTED_CONFIGURATION_SHA256 = "0be4e30eca3a6b0c5a623056fd6d3ff177d6d67afddf318d681fca0d4f39c3b9";

function configurationDigest(configuration: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(configuration).sort(([a], [b]) => (a < b ? -1 : 1)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

describe("gold-asian-sweep configuration is pinned to its version", () => {
  it("registers the version this test was written for", () => {
    expect(goldAsianSweepStrategyVersion).toBe(EXPECTED_VERSION);
    expect(goldAsianSweepStrategyRegistration.version).toBe(EXPECTED_VERSION);
  });

  it("has not changed its configuration without a new version", () => {
    expect(configurationDigest(goldAsianSweepStrategyRegistration.configuration)).toBe(EXPECTED_CONFIGURATION_SHA256);
  });
});
