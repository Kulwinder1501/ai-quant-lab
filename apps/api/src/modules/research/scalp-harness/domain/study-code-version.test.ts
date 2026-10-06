import { describe, expect, it } from "vitest";
import { domainDirectory, pathStudyCodeFiles, studyCodeVersion } from "./study-code-version.js";

/**
 * Measured 2026-09-15 against the live production image: `run-path-study` had been throwing ENOENT
 * on every container invocation since it was first deployed, because `studyCodeVersion` resolved its
 * own directory to the compiled `dist/...` path and looked for `.ts` siblings there, which were never
 * compiled into `dist` -- only `src` carries them. These tests pin the fix directly against realistic
 * dist/src path pairs, since the existing tests above run this module via source (vitest/tsx) and
 * would pass identically whether or not the fix existed.
 */
describe("domainDirectory: compiled-vs-source path correction", () => {
  it("swaps a dist segment for src, on both POSIX and Windows separators", () => {
    expect(domainDirectory("/app/apps/api/dist/modules/research/scalp-harness/domain"))
      .toBe("/app/apps/api/src/modules/research/scalp-harness/domain");
    expect(domainDirectory("C:\\app\\apps\\api\\dist\\modules\\research\\scalp-harness\\domain"))
      .toBe("C:\\app\\apps\\api\\src\\modules\\research\\scalp-harness\\domain");
  });

  it("leaves a path with no dist segment unchanged, the dev/test case", () => {
    const sourcePath = "/repo/apps/api/src/modules/research/scalp-harness/domain";
    expect(domainDirectory(sourcePath)).toBe(sourcePath);
  });

  it("does not touch a directory or package merely named similarly to 'dist'", () => {
    // "distribution" must not be mistaken for the "dist" outDir segment.
    const path = "/app/apps/distribution/api/src/modules/research/scalp-harness/domain";
    expect(domainDirectory(path)).toBe(path);
  });
});

describe("study code version", () => {
  it("is stable across calls and order-independent in its file list", () => {
    // Determinism is the whole value: a provenance hash that moves between two runs over identical code
    // cannot distinguish a real implementation change from noise.
    expect(studyCodeVersion()).toBe(studyCodeVersion());
    expect(studyCodeVersion([...pathStudyCodeFiles].reverse())).toBe(studyCodeVersion());
  });

  it("moves when the declared file set changes", () => {
    const subset = pathStudyCodeFiles.filter((file) => file !== "estimators.ts");
    expect(studyCodeVersion(subset)).not.toBe(studyCodeVersion());
  });

  it("covers every file that can move a path-study number", () => {
    // Named explicitly rather than derived from the import graph: a transitive walk would make the hash
    // move on edits that cannot affect the result, which is the same failure as using a commit hash.
    expect([...pathStudyCodeFiles].sort()).toEqual([
      "barrier-free-path.ts",
      "directional-information-curve.ts",
      "estimators.ts",
      "matched-controls.ts",
      // Forward-window slicing and unit assembly. They were in the CLI, which the hash cannot reach —
      // so result-affecting logic sat outside the guarantee until they moved here.
      "path-study-inputs.ts",
      "policies.ts",
      "simultaneous-horizon-band.ts",
      "study-registry.ts",
    ]);
  });

  it("throws on a missing file rather than hashing a shorter set", () => {
    // A skipped file would still produce a well-formed hash, which would read as valid provenance for a
    // code set that was never actually measured.
    expect(() => studyCodeVersion(["does-not-exist.ts"])).toThrow();
  });

  it("returns a sha-256 digest", () => {
    expect(studyCodeVersion()).toMatch(/^[0-9a-f]{64}$/);
  });
});
