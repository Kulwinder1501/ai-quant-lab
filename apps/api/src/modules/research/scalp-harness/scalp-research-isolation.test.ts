import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { researchStrategySourceChecksums } from "./domain/research-strategies.js";

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

describe("scalp research physical isolation", () => {
  const sourceRoot = resolve(process.cwd(), "src");
  const researchRoot = join(sourceRoot, "modules", "research", "scalp-harness");
  const isolatedEntrypoints = [
    researchRoot,
    join(sourceRoot, "interfaces", "scheduler", "scalp-research-scheduler.ts"),
    join(sourceRoot, "interfaces", "cli", "run-scalp-research-harness.ts"),
    join(sourceRoot, "interfaces", "cli", "match-scalp-research-controls.ts"),
    join(sourceRoot, "interfaces", "cli", "settle-scalp-research.ts"),
    join(sourceRoot, "interfaces", "cli", "audit-scalp-research.ts"),
    join(sourceRoot, "interfaces", "cli", "estimate-scalp-research.ts"),
    join(sourceRoot, "infrastructure", "database", "repositories", "postgres-scalp-research-estimand-repository.ts"),
    join(sourceRoot, "interfaces", "cli", "scalp-research-database.ts"),
    join(sourceRoot, "infrastructure", "database", "repositories", "postgres-scalp-research-repository.ts"),
    join(sourceRoot, "infrastructure", "database", "repositories", "postgres-scalp-research-query-repository.ts"),
    join(sourceRoot, "infrastructure", "database", "repositories", "postgres-research-risk-snapshot-provider.ts"),
    join(sourceRoot, "infrastructure", "database", "repositories", "postgres-scalp-research-acceptance-repository.ts"),
  ];

  it("is absent from the operational strategy registry", () => {
    const registry = readFileSync(join(sourceRoot, "modules", "strategy-engine", "domain", "strategy-registry.ts"), "utf8");
    expect(registry).not.toContain("scalp-harness");
    expect(registry).not.toContain("researchScalpStrategies");
  });

  it("has no execution imports or order-opening symbols", () => {
    const source = isolatedEntrypoints.flatMap((path) => statSync(path).isDirectory() ? filesBelow(path) : [path])
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const forbidden of [
      "OpenPaperTrade",
      "PrepareOptionEntry",
      "open-paper-trade",
      "order-adapter",
      "broker-adapter",
      "paper-trading-bot",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  /**
   * Walks the real import graph out of every research entrypoint and refuses any path that reaches an
   * execution module.
   *
   * The substring denylist above is a useful tripwire but proves less than it appears: it only catches a
   * forbidden name written *literally in research source*. It cannot see
   * `research -> some-innocent-helper -> paper-execution`, where no research file ever names the
   * execution module, and it goes stale the moment an execution API is renamed. Following the graph
   * removes both blind spots — a new indirect edge fails the build regardless of what anything is called.
   */
  it("has no transitive import path from research code into execution modules", () => {
    const forbiddenSegments = ["paper-trading", "broker", "execution", "order-routing"];
    // These are shared, non-executing seams the harness legitimately reads: pure domain types and the
    // read-only paper-account/trade *queries* the point-in-time risk snapshot reconstructs from. They
    // open no position, so they are traversed like any other node but do not themselves count as
    // execution — the forbidden check below is what decides that, per file.
    const resolveImport = (fromFile: string, specifier: string): string | null => {
      if (!specifier.startsWith(".")) return null; // node_modules and bare specifiers are out of scope.
      const resolved = resolve(dirname(fromFile), specifier).replace(/\.js$/, ".ts");
      return existsSync(resolved) ? resolved : null;
    };
    const importsOf = (file: string): string[] => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)]
        .map((match) => resolveImport(file, match[1]!))
        .filter((path): path is string => path !== null);
    };

    const seeds = isolatedEntrypoints
      .flatMap((path) => statSync(path).isDirectory() ? filesBelow(path) : [path])
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    const visited = new Set<string>();
    const violations: string[] = [];
    const walk = (file: string, trail: readonly string[]): void => {
      if (visited.has(file)) return;
      visited.add(file);
      const relative = file.slice(sourceRoot.length + 1).replace(/\\/g, "/");
      // An execution module is one that opens or routes an order. Reaching one from research code —
      // by any path, however indirect — is the failure this test exists to make impossible.
      if (forbiddenSegments.some((segment) => relative.includes(`${segment}/`))
        && /open-paper-trade|paper-trading-bot|order-adapter|broker-adapter|order-routing/.test(relative)) {
        violations.push([...trail, relative].join("\n    -> "));
        return;
      }
      for (const next of importsOf(file)) walk(next, [...trail, relative]);
    };
    for (const seed of seeds) walk(seed, []);
    expect(violations, `research code transitively imports execution modules:\n  ${violations.join("\n\n  ")}`)
      .toEqual([]);
  });

  it("keeps execution code from importing research internals", () => {
    // The reverse direction. Architecture hygiene rather than an order-routing hazard, but a production
    // module reaching into research internals is how a "research-only" subsystem quietly acquires a
    // production consumer — which is exactly the guarantee V1.3.1 freezes.
    const executionRoots = [
      join(sourceRoot, "modules", "paper-trading"),
      join(sourceRoot, "modules", "strategy-engine"),
    ].filter((path) => existsSync(path));
    const offenders = executionRoots
      .flatMap((root) => filesBelow(root))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => /research\/scalp-harness|scalp-research/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(sourceRoot.length + 1));
    expect(offenders, `execution code imports research internals: ${offenders.join(", ")}`).toEqual([]);
  });

  it("fails visibly when a frozen source strategy changes without a research version bump", () => {
    const strategyRoot = join(sourceRoot, "modules", "strategy-engine", "domain");
    for (const [file, expected] of Object.entries(researchStrategySourceChecksums)) {
      const actual = createHash("sha256").update(readFileSync(join(strategyRoot, file))).digest("hex");
      expect(actual, `${file} changed; create a new research strategy version and checksum`).toBe(expected);
    }
  });
});

/**
 * Runtime privilege probes — the authorization half of severance the substring test above cannot prove.
 *
 * A username string-compare proves identity, not authority; these assert the real privilege boundary
 * the research role runs behind (migration 076 provisions it). They need a live DB reached through that
 * role, so they are skipped unless SCALP_RESEARCH_DATABASE_URL is set — CI and the default unit run stay
 * hermetic, while a deploy (or a wired local env) exercises the negative assertions that make
 * "PHYSICALLY SEVERED" true at runtime. `has_*_privilege` reads the catalog; it never attempts a write.
 */
const researchDatabaseUrl = process.env.SCALP_RESEARCH_DATABASE_URL;
describe.skipIf(!researchDatabaseUrl)("scalp research role privileges (live DB)", () => {
  const pool = new Pool({ connectionString: researchDatabaseUrl });
  afterAll(async () => { await pool.end(); });

  async function privilege(sql: string): Promise<boolean> {
    const result = await pool.query<{ ok: boolean }>(sql);
    return result.rows[0]!.ok;
  }

  it("can read and INSERT within research_scalp, but never mutate it", async () => {
    expect(await privilege("SELECT has_schema_privilege(current_user, 'research_scalp', 'USAGE') AS ok")).toBe(true);
    expect(await privilege("SELECT has_table_privilege(current_user, 'research_scalp.control_points', 'INSERT') AS ok")).toBe(true);
    // Append-only even inside its own schema — the harness records, it never revises.
    expect(await privilege("SELECT has_table_privilege(current_user, 'research_scalp.control_points', 'UPDATE') AS ok")).toBe(false);
    expect(await privilege("SELECT has_table_privilege(current_user, 'research_scalp.control_points', 'DELETE') AS ok")).toBe(false);
  });

  it("can read but never write production / paper state", async () => {
    // SELECT on source data is the harness's legitimate read; every mutation verb must be denied.
    expect(await privilege("SELECT has_table_privilege(current_user, 'paper_trades', 'SELECT') AS ok")).toBe(true);
    for (const verb of ["INSERT", "UPDATE", "DELETE"]) {
      expect(
        await privilege(`SELECT has_table_privilege(current_user, 'paper_trades', '${verb}') AS ok`),
        `research role must not ${verb} paper_trades`,
      ).toBe(false);
    }
  });
});
