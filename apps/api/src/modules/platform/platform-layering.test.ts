import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The platform layer depends on no domain module.
 *
 * ## Why this is a test and not a convention
 *
 * It was violated within an hour of the layer existing. `platform/risk/risk-snapshot.ts` imported
 * `VolatilityRegimeEvidence` from `risk-management/domain/risk.ts` — which reads as harmless, since it
 * is only a type. But it would have made the platform know that a regime is
 * `CONTRACTION | STABLE | EXPANSION`, a domain fact about one strategy family, and the dependency
 * arrow would point from the shared layer into a consumer. The fix was a type parameter: the platform
 * knows a snapshot carries evidence per instrument, the domain says what evidence is.
 *
 * That is exactly the coupling Readiness Plan Gap 1 exists to prevent, and exactly the kind of import
 * that gets added again by someone reaching for a convenient type. A reviewer would have to notice a
 * single `import type` line among many; this notices for them.
 *
 * Test files are exempt. A test may legitimately instantiate a platform generic at a real domain type
 * — `risk-primitives.test.ts` does, deliberately, so the compiler still checks the field names the
 * platform is agnostic about.
 */

const PLATFORM_ROOT = resolve(process.cwd(), "src", "modules", "platform");
const MODULES_ROOT = resolve(process.cwd(), "src", "modules");

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFilesBelow(path) : [path];
  }).filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
}

/** Sibling directories of `platform` under `modules/` — every domain module there is. */
function domainModuleNames(): string[] {
  return readdirSync(MODULES_ROOT)
    .filter((entry) => entry !== "platform" && statSync(join(MODULES_ROOT, entry)).isDirectory());
}

describe("platform layering", () => {
  it("imports nothing from any domain module", () => {
    const domains = domainModuleNames();
    expect(domains.length, "expected sibling domain modules to exist").toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of sourceFilesBelow(PLATFORM_ROOT)) {
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]!);
      for (const specifier of specifiers) {
        // Only relative specifiers can escape the layer; bare ones are node_modules or workspace
        // packages, which are not domain modules.
        if (!specifier.startsWith(".")) continue;
        const resolved = resolve(join(file, ".."), specifier).replace(/\\/g, "/");
        if (resolved.startsWith(PLATFORM_ROOT.replace(/\\/g, "/"))) continue;
        const reached = domains.find((domain) => resolved.includes(`/modules/${domain}/`));
        if (reached) {
          violations.push(`${file.slice(MODULES_ROOT.length + 1)} -> ${reached} (${specifier})`);
        }
      }
    }

    expect(
      violations,
      "the platform layer must not depend on a domain module; parameterise the type instead:\n  "
      + violations.join("\n  "),
    ).toEqual([]);
  });

  it("actually inspects the platform sources, so a passing result means something", () => {
    // Guards the guard. If the directory walk broke or the layer moved, the check above would pass by
    // finding nothing to look at.
    const files = sourceFilesBelow(PLATFORM_ROOT).map((file) => file.replace(/\\/g, "/"));

    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const expected of ["identity/identity.ts", "pit/pit-instants.ts", "snapshot/snapshot-ref.ts", "calendar/trading-session.ts", "risk/risk-snapshot.ts"]) {
      expect(files.some((file) => file.endsWith(expected)), expected).toBe(true);
    }
  });
});
