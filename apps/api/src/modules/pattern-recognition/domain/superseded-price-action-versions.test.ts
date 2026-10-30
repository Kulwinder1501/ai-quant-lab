import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  priceActionAlgorithmVersion,
  supersededPriceActionAlgorithmVersions,
  supersededPriceActionVersionsPinnedBy,
  supersededPriceActionVersionsSql,
} from "./market-pattern.js";

/**
 * Every file under src that reads the price_action_events table must exclude the superseded versions.
 *
 * Several readers (the higher-timeframe digest among them) take support/resistance from every version in the context they are handed,
 * with no version test of their own, so a second rule set in the loaded rows would be read as one. The old versions' rows stay in the
 * table as history; the loaders, the paper-trade market-context note and the scanner read the current version only. A reader added
 * later that does not exclude them fails here, which is the point. (The ML loader names its version in the query, and the writer only
 * inserts; neither matches the scan.)
 */
function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("superseded price-action versions", () => {
  it("lists v2 and v3 and their forced-ATR variants, and never the current version", () => {
    expect(supersededPriceActionAlgorithmVersions).toEqual(["price-action-v2", "price-action-v2-atr", "price-action-v3", "price-action-v3-atr"]);
    expect(supersededPriceActionAlgorithmVersions as readonly string[]).not.toContain(priceActionAlgorithmVersion);
    expect(priceActionAlgorithmVersion).toBe("price-action-v4");
  });

  it("names a superseded version a strategy configuration pins, and nothing else", () => {
    expect(supersededPriceActionVersionsPinnedBy({ priceActionAlgorithmVersion: "price-action-v3" })).toEqual(["price-action-v3"]);
    expect(supersededPriceActionVersionsPinnedBy({ priceActionAlgorithmVersion: "price-action-v2" })).toEqual(["price-action-v2"]);
    // The current version, a missing or mistyped pin and an unknown label all ask for nothing, so an ordinary run reads the current version only.
    expect(supersededPriceActionVersionsPinnedBy({ priceActionAlgorithmVersion: priceActionAlgorithmVersion })).toEqual([]);
    expect(supersededPriceActionVersionsPinnedBy({ priceActionAlgorithmVersion: 3 })).toEqual([]);
    expect(supersededPriceActionVersionsPinnedBy({ priceActionAlgorithmVersion: "price-action-v9" })).toEqual([]);
    expect(supersededPriceActionVersionsPinnedBy({ scoreThreshold: 5 })).toEqual([]);
    expect(supersededPriceActionVersionsPinnedBy(null)).toEqual([]);
  });

  it("splices into SQL as a quoted list", () => {
    expect(supersededPriceActionVersionsSql()).toBe("'price-action-v2', 'price-action-v2-atr', 'price-action-v3', 'price-action-v3-atr'");
  });

  it("is excluded by every reader of price_action_events", () => {
    const root = path.resolve(process.cwd(), "src");
    const readers = sourceFiles(root)
      .map((file) => ({ relative: path.relative(root, file).split(path.sep).join("/"), text: fs.readFileSync(file, "utf8") }))
      .filter(({ text }) => /FROM\s+price_action_events/i.test(text));

    expect(readers.length).toBeGreaterThanOrEqual(4); // the scan is finding the readers it is meant to, the scanner among them
    expect(readers.map(({ relative }) => relative)).toContain("infrastructure/database/repositories/postgres-market-scanner-query-repository.ts");
    const unguarded = readers
      // the clause itself, not just the import: deleting the SQL line must fail this
      .filter(({ text }) => !text.includes("NOT IN (${supersededPriceActionVersionsSql()})"))
      .map(({ relative }) => relative);
    expect(unguarded).toEqual([]);
  });
});
