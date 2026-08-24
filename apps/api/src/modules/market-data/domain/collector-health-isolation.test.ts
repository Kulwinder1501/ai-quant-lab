import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

/**
 * Collector health is operational monitoring and must never reach research qualification.
 *
 * The split is deliberate and load-bearing:
 *
 *   CollectorHealth   = operational warning     (market-data)
 *   D2SessionCoverage = research qualification  (directional-v2)
 *
 * A health threshold is an operations judgement that gets tuned as the deployment changes. If a
 * tuned number could admit or exclude a session from a frozen experiment, the experiment's admission
 * criteria would drift silently without anyone re-registering them — the outcome §8.3 exists to
 * prevent, and the reason it derives qualification entirely from already-frozen rules.
 *
 * Convention is not enough for that, so this fails the build instead.
 */
describe("collector health isolation", () => {
  const sourceRoot = resolve(process.cwd(), "src");
  const researchRoots = [
    join(sourceRoot, "modules", "research"),
    join(sourceRoot, "interfaces", "cli", "run-directional-v2-d2.ts"),
    join(sourceRoot, "interfaces", "cli", "run-scalp-research-harness.ts"),
    join(sourceRoot, "interfaces", "cli", "audit-d2-opportunity-coverage.ts"),
    join(sourceRoot, "interfaces", "cli", "verify-live-backfill-parity.ts"),
  ];

  it("is not imported anywhere under the research modules or their entrypoints", () => {
    const offenders = researchRoots
      .flatMap((path) => (statSync(path).isDirectory() ? filesBelow(path) : [path]))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("collector-health")
          || source.includes("evaluateCollectorHealth")
          || source.includes("STRUCTURAL_SILENCE_MS");
      });

    expect(offenders).toEqual([]);
  });

  it("does not itself import anything from the research modules", () => {
    // The other direction matters too: reading a research constant here would couple an operations
    // threshold to a frozen protocol and invite someone to "keep them in sync".
    //
    // Checked against import statements rather than raw text, because the file's own documentation
    // names `D2SessionCoverage` to explain the split -- prose describing the boundary is not a
    // violation of it, and a substring test that cannot tell the two apart would push the
    // explanation out of the file that most needs it.
    const source = readFileSync(join(sourceRoot, "modules", "market-data", "domain", "collector-health.ts"), "utf8");
    const importedPaths = [...source.matchAll(/(?:^|\n)\s*import[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!);

    expect(importedPaths.filter((path) => path.includes("research") || path.includes("directional-v2"))).toEqual([]);
  });

  it("keeps the D2 qualification rule free of any health concept", () => {
    const gate = readFileSync(
      join(sourceRoot, "modules", "research", "directional-v2", "domain", "d2-premium-cost-gate.ts"),
      "utf8",
    );

    expect(gate).not.toContain("CollectorHealth");
    expect(gate).not.toContain("STRUCTURAL_SILENCE");
    // Qualification stays derived from the frozen quote rules alone.
    expect(gate).toContain("qualifiedSessionCount");
  });
});
