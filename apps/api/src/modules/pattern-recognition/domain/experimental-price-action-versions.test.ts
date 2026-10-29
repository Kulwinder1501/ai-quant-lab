import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  experimentalPriceActionAlgorithmVersions,
  experimentalPriceActionVersionsSql,
  priceActionAlgorithmVersion,
  priceActionAtrAlgorithmVersion,
  priceActionV4AlgorithmVersion,
} from "./market-pattern.js";

/**
 * Every file under src that reads the price_action_events table, and what it does about experimental versions.
 *
 * The scanner shows every version side by side on purpose, as research-only display. Every other reader must exclude the experimental
 * labels, because price-action-v4 is written beside v3 for comparison and must not reach a bot, a backtest or the paper-trade note. A
 * reader added later that does neither fails here, which is the point. (The ML loader names its version in the query, and the writer
 * only inserts; neither matches the scan.)
 */
const deliberateExceptions: ReadonlyMap<string, string> = new Map([
  ["infrastructure/database/repositories/postgres-market-scanner-query-repository.ts", "research-only display: shows every version side by side"],
]);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("experimental price-action versions", () => {
  it("never include the current version, or the forced-ATR variant of it", () => {
    expect(experimentalPriceActionAlgorithmVersions).toContain(priceActionV4AlgorithmVersion);
    expect(experimentalPriceActionAlgorithmVersions).not.toContain(priceActionAlgorithmVersion);
    expect(experimentalPriceActionAlgorithmVersions).not.toContain(priceActionAtrAlgorithmVersion);
  });

  it("splices into SQL as a quoted list", () => {
    expect(experimentalPriceActionVersionsSql()).toBe("'price-action-v4'");
  });

  it("is read by nothing that decides anything: every reader of price_action_events excludes them or is a listed exception", () => {
    const root = path.resolve(process.cwd(), "src");
    const readers = sourceFiles(root)
      .map((file) => ({ relative: path.relative(root, file).split(path.sep).join("/"), text: fs.readFileSync(file, "utf8") }))
      .filter(({ text }) => /FROM\s+price_action_events/i.test(text));

    expect(readers.length).toBeGreaterThanOrEqual(4); // the scan is finding the readers it is meant to
    const unguarded = readers
      // the clause itself, not just the import: deleting the SQL line must fail this
      .filter(({ relative, text }) => !deliberateExceptions.has(relative) && !text.includes("NOT IN (${experimentalPriceActionVersionsSql()})"))
      .map(({ relative }) => relative);
    expect(unguarded).toEqual([]);
    for (const exception of deliberateExceptions.keys()) {
      expect(readers.map(({ relative }) => relative), `exception ${exception} no longer reads the table; remove it`).toContain(exception);
    }
  });
});
