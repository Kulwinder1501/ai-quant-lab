import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Brain V2.2 §6's quarantine, enforced structurally rather than by intention.
 *
 * The migration map sorts V1 into four buckets, and the QUARANTINE bucket carries one rule: "Retain as
 * benchmark only; **zero import path into `autonomous-v2/`**". A rule like that is cheap to state and
 * expensive to keep, because the pressure to break it is always local and reasonable -- a stage needs
 * a scoring helper that already exists, and importing it is one line.
 *
 * Written now, while `autonomous-v2/` holds only contracts, for the same reason the golden digests
 * were recorded before the identity relocation: a guard added after the violation documents the
 * violation. The house already does this three times -- `scalp-research-isolation.test.ts`,
 * `collector-health-isolation.test.ts`, `platform-layering.test.ts` -- and each of those caught
 * something.
 *
 * ## What is quarantined, and what is deliberately not
 *
 * Quarantined: `scoreDirectionalSetup`, legacy candlestick ranking, composite confidence,
 * `patterns[0]` selection, and news-based *trading authority*.
 *
 * **Not** quarantined: news, FII/DII and driver-tape *context*. Those sit in the ADAPTER bucket, so
 * forbidding every news import would over-enforce the rule and block a legitimate migration path. The
 * violation §6 names is an external context signal mutating position state directly, not the signal
 * existing.
 */

const MODULE_ROOT = resolve(process.cwd(), "src", "modules", "autonomous-v2");
const SOURCE_ROOT = resolve(process.cwd(), "src");

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFilesBelow(path) : [path];
  }).filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = resolve(dirname(fromFile), specifier).replace(/\.js$/, ".ts");
  return existsSync(resolved) ? resolved : null;
}

/**
 * Strips comments before pattern matching.
 *
 * Without this the check fires on its own documentation: `decision-outcome.ts` names
 * `scoreDirectionalSetup` in a comment explaining why it is quarantined, and that is exactly what the
 * comment should say. Deleting the prose to satisfy the test would make the docs worse to keep the
 * guard quiet, which is backwards -- quarantine is about *using* the thing, not naming it.
 *
 * Naive by design: a `//` inside a string literal would be treated as a comment. That is acceptable
 * for detecting forbidden identifiers and is cheaper than a parser, but it means this is a tripwire
 * rather than a proof.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // `.` excludes newlines by default, so a line comment needs no explicit newline class.
    .replace(/(^|[^:])\/\/.*/g, "$1 ");
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)]
    .map((match) => resolveImport(file, match[1]!))
    .filter((path): path is string => path !== null);
}

/** Module paths whose behaviour §6 retains as a benchmark and forbids V2 from consuming. */
const QUARANTINED_PATHS = [
  "strategy-engine/domain/directional-setup-score",
  "strategy-engine/application/ai-autonomous-agent",
  "research/scalp-harness",
];

/** Source patterns §6 lists under QUARANTINE or DELETE FROM V2. */
const FORBIDDEN_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bscoreDirectionalSetup\b/, why: "composite directional score (QUARANTINE)" },
  { pattern: /\bpatterns\[0\]/, why: "implicit observation selection; the Opportunity Resolver replaces it (I3)" },
  { pattern: /\blastTradeAttempt\b/, why: "in-memory decision idempotency (DELETE FROM V2)" },
  {
    // "Raw SQL inside orchestrator" (DELETE FROM V2). Anchored on a FROM/INTO clause so the word
    // "select" in prose does not trip it.
    pattern: /\b(SELECT\s+[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/,
    why: "raw SQL in the decision plane (DELETE FROM V2)",
  },
];

describe("autonomous-v2 quarantine", () => {
  it("inspects real source files, so a pass cannot come from an empty walk", () => {
    // Guards the guard. Every other assertion here is a negative, and a negative over nothing passes.
    const files = sourceFilesBelow(MODULE_ROOT);

    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((file) => file.endsWith("decision-outcome.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("decision-lifecycle.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("decision-lineage.ts"))).toBe(true);
  });

  it("has no transitive import path into a quarantined V1 module", () => {
    /*
     * Follows the real import graph rather than checking the literal text of each file, because the
     * dangerous shape is indirect: `autonomous-v2 -> some-innocent-helper -> ai-autonomous-agent`
     * names nothing forbidden in V2 source at all.
     */
    const visited = new Set<string>();
    const violations: string[] = [];
    const walk = (file: string, trail: readonly string[]): void => {
      if (visited.has(file)) return;
      visited.add(file);
      const relative = file.slice(SOURCE_ROOT.length + 1).replace(/\\/g, "/");
      const hit = QUARANTINED_PATHS.find((path) => relative.includes(path));
      if (hit) {
        violations.push([...trail, `${relative}  <-- ${hit}`].join("\n    -> "));
        return;
      }
      for (const next of importsOf(file)) walk(next, [...trail, relative]);
    };
    for (const seed of sourceFilesBelow(MODULE_ROOT)) walk(seed, []);

    expect(
      violations,
      `autonomous-v2 reaches quarantined V1 code:\n  ${violations.join("\n\n  ")}`,
    ).toEqual([]);
  });

  it("contains none of the patterns §6 sends to quarantine or deletion", () => {
    const violations: string[] = [];
    for (const file of sourceFilesBelow(MODULE_ROOT)) {
      const source = codeOnly(readFileSync(file, "utf8"));
      for (const { pattern, why } of FORBIDDEN_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${file.slice(SOURCE_ROOT.length + 1).replace(/\\/g, "/")}: ${why}`);
        }
      }
    }

    expect(violations, `quarantined patterns in autonomous-v2:\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("detects a violation when one is present, rather than passing by construction", () => {
    /*
     * The patterns are only worth anything if they match. Checked against V1 itself, which is the
     * benchmark they are drawn from: `ai-autonomous-agent.ts` carries `patterns[0]`,
     * `lastTradeAttempt` and raw SQL, and `directional-setup-score.ts` carries the score.
     *
     * Without this, a typo in a regex would leave the quarantine silently unenforced.
     */
    const agent = readFileSync(
      join(SOURCE_ROOT, "modules", "strategy-engine", "application", "ai-autonomous-agent.ts"), "utf8",
    );
    const scorer = readFileSync(
      join(SOURCE_ROOT, "modules", "strategy-engine", "domain", "directional-setup-score.ts"), "utf8",
    );
    // Same stripping as above, so the self-check exercises the code path the guard actually uses.
    const matched = (source: string): string[] => FORBIDDEN_PATTERNS
      .filter(({ pattern }) => pattern.test(codeOnly(source))).map(({ why }) => why);

    expect(matched(agent)).toContain("implicit observation selection; the Opportunity Resolver replaces it (I3)");
    expect(matched(agent)).toContain("in-memory decision idempotency (DELETE FROM V2)");
    expect(matched(agent)).toContain("raw SQL in the decision plane (DELETE FROM V2)");
    expect(matched(scorer)).toContain("composite directional score (QUARANTINE)");
  });
});
