import { describe, expect, it } from "vitest";
import type { CanonicalTimeframe } from "../../../modules/pattern-intelligence/domain/instrument-identifiers.js";
import { patternObservationFrozenTapeMigration } from "./085-pattern-observation-frozen-tape.js";

const { id, sql } = patternObservationFrozenTapeMigration;

describe("pattern observation frozen-tape view migration", () => {
  it("is registered under its file name and is re-runnable", () => {
    expect(id).toBe("085-pattern-observation-frozen-tape");
    // A re-run must be a no-op. The ledger has drifted from the schema once before, and a
    // non-idempotent statement is what turns that drift into a replayed write.
    expect(sql).toContain("CREATE OR REPLACE VIEW");
  });

  it("identifies rows without deleting or rewriting one of them", () => {
    // The whole point of this migration: the rows are evidence. Nothing here may mutate them.
    for (const verb of ["DELETE", "UPDATE", "TRUNCATE", "DROP TABLE", "ALTER TABLE"]) {
      expect(sql, `085 must not ${verb}`).not.toContain(verb);
    }
  });

  it("tests value repetition against a contiguous predecessor, not volume", () => {
    // Volume can never corroborate price freshness on an index -- the two come from different
    // sources, so the counter keeps accumulating while the price aggregate is pinned. A volume
    // predicate here would reproduce exactly the defect the runtime fix removed.
    expect(sql).toContain("b.high = b.low");
    for (const column of ["prev_open", "prev_high", "prev_low", "prev_close"]) {
      expect(sql).toContain(`b.${column}`);
    }
    expect(sql).toContain("b.open_time - b.prev_open_time");
    // `volume` appears only as reported evidence on the output row, never in the WHERE clause.
    expect(sql).not.toMatch(/WHERE[\s\S]*b\.volume\s*[<>=]/);
  });

  it("maps every canonical timeframe, so adding one cannot silently shrink the view", () => {
    // An unmapped timeframe makes the CASE NULL, the contiguity comparison NULL, and the row
    // absent -- a false clean bill of health rather than an error. This is the guard against that.
    const timeframes: readonly CanonicalTimeframe[] = ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d"];
    for (const timeframe of timeframes) {
      expect(sql, `timeframe ${timeframe} has no interval mapping`).toContain(`WHEN '${timeframe}'`);
    }
    // No ELSE branch: an unmapped timeframe must not be given a plausible default interval.
    expect(sql).not.toMatch(/CASE b\.timeframe[\s\S]*ELSE/);
  });
});
