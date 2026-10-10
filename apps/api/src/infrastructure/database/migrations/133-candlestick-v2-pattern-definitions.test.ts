import { describe, expect, it } from "vitest";
import {
  candlestickAlgorithmVersion,
  candlestickPatternCodes,
  candlestickPatternDescriptions,
  supersededCandlestickAlgorithmVersions,
} from "../../../modules/pattern-recognition/domain/market-pattern.js";
import { candlestickV2PatternDefinitionsMigration } from "./133-candlestick-v2-pattern-definitions.js";

const sql = candlestickV2PatternDefinitionsMigration.sql;

describe("132 candlestick v2 pattern definitions", () => {
  it("is numbered 132 and its id matches its file name", () => {
    expect(candlestickV2PatternDefinitionsMigration.id).toBe("133-candlestick-v2-pattern-definitions");
  });

  it("inserts a definition row for every candlestick code at the version the engine writes", () => {
    expect(candlestickAlgorithmVersion).toBe("candlestick-v2");
    for (const code of candlestickPatternCodes) {
      const description = candlestickPatternDescriptions[code];
      expect(sql, `missing v2 definition for ${code}`).toContain(
        `('${code}', 'CANDLESTICK', '${candlestickAlgorithmVersion}', '${description}')`,
      );
    }
    // No code is defined twice and nothing outside the engine's vocabulary is defined.
    const inserted = [...sql.matchAll(/^\s+\('([A-Z_]+)', 'CANDLESTICK', 'candlestick-v2'/gm)].map((match) => match[1]);
    expect([...inserted].sort()).toEqual([...candlestickPatternCodes].sort());
  });

  it("marks every superseded version instead of deleting it", () => {
    for (const version of supersededCandlestickAlgorithmVersions) {
      expect(sql).toContain(`WHERE algorithm_version = '${version}'`);
    }
    expect(sql).toContain("superseded_by_version = 'candlestick-v2'");
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("is idempotent where it creates rows or columns", () => {
    expect(sql).toContain("ON CONFLICT (pattern_code, algorithm_version) DO NOTHING");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS superseded_at");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS known_at");
  });

  it("adds known_at to both evidence tables, backfilled from the candle close and never moved later", () => {
    for (const table of ["pattern_detections", "price_action_events"]) {
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS known_at TIMESTAMPTZ`);
      expect(sql).toContain(`ALTER TABLE ${table} ALTER COLUMN known_at SET NOT NULL`);
      expect(sql).toContain(`BEFORE INSERT ON ${table}`);
      expect(sql).toContain(`BEFORE UPDATE ON ${table}`);
    }
    expect(sql).toContain("SET known_at = c.close_time");
    // The earliest knowledge time wins on a re-detection.
    expect(sql).toContain("LEAST(OLD.known_at, COALESCE(NEW.known_at, OLD.known_at))");
  });

  it("backfills before it makes the column NOT NULL and before the update trigger exists", () => {
    const backfill = sql.indexOf("SET known_at = c.close_time");
    const notNull = sql.indexOf("ALTER COLUMN known_at SET NOT NULL");
    const trigger = sql.indexOf("CREATE TRIGGER pattern_detections_known_at_update");
    expect(backfill).toBeGreaterThan(-1);
    expect(notNull).toBeGreaterThan(backfill);
    expect(trigger).toBeGreaterThan(notNull);
  });

  it("contains no backtick that would end the template literal", () => {
    expect(sql.includes("`")).toBe(false);
  });
});
