import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeLevels } from "./levels.js";

interface FixtureLevel {
  id: string;
  price: number;
  kind: string;
  source: string;
  side: string;
  touches: number;
  strength: number;
  state: string;
}

interface FixtureExpected {
  as_of_date: string | null;
  state: string;
  atr14: number | null;
  atr_percent: number | null;
  nearest_support: { price: number; touches: number; strength: number; state: string } | null;
  nearest_resistance: { price: number; touches: number; strength: number; state: string } | null;
  risk_distance_atr: number | null;
  levels_count: number;
  levels: FixtureLevel[];
}

interface ParityFixture {
  name: string;
  description: string;
  bars: Array<{
    bar_date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  expected: FixtureExpected;
}

describe("Gate R4 / L3: Parity Verification on Shared Golden Fixtures", () => {
  const fixturesPath = resolve(
    __dirname,
    "../../../../../../apps/ml/tests/fixtures/r0_parity_fixtures.json",
  );
  const content = JSON.parse(readFileSync(fixturesPath, "utf-8")) as {
    version: string;
    fixtures: ParityFixture[];
  };

  it("verifies shared fixtures file contains 14 golden cases (5 synthetic + 9 real)", () => {
    expect(content.fixtures.length).toBe(14);
  });

  for (const fixture of content.fixtures) {
    it(`verifies mathematical parity on fixture '${fixture.name}' to 1e-9`, () => {
      const { name, bars, expected } = fixture;
      const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
      const evalDate = lastBar ? lastBar.bar_date : "2026-10-16";

      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: evalDate,
      });

      // 1. Overall State
      expect(res.state, `[${name}] state mismatch`).toBe(expected.state);

      // 2. As of date
      expect(res.asOfDate, `[${name}] asOfDate mismatch`).toBe(expected.as_of_date);

      // 3. ATR14
      if (expected.atr14 !== null) {
        expect(res.atr14, `[${name}] expected atr14 not null`).not.toBeNull();
        expect(res.atr14!).toBeCloseTo(expected.atr14, 8);
      } else {
        expect(res.atr14, `[${name}] expected atr14 to be null`).toBeNull();
      }

      // 4. Nearest Support
      if (expected.nearest_support !== null) {
        expect(res.nearestSupport, `[${name}] expected nearestSupport not null`).not.toBeNull();
        expect(res.nearestSupport!.price).toBeCloseTo(expected.nearest_support.price, 8);
        expect(res.nearestSupport!.touches).toBe(expected.nearest_support.touches);
        expect(res.nearestSupport!.strength).toBeCloseTo(expected.nearest_support.strength, 8);
        expect(res.nearestSupport!.state).toBe(expected.nearest_support.state);
      } else {
        expect(res.nearestSupport, `[${name}] expected nearestSupport to be null`).toBeNull();
      }

      // 5. Nearest Resistance
      if (expected.nearest_resistance !== null) {
        expect(res.nearestResistance, `[${name}] expected nearestResistance not null`).not.toBeNull();
        expect(res.nearestResistance!.price).toBeCloseTo(expected.nearest_resistance.price, 8);
        expect(res.nearestResistance!.touches).toBe(expected.nearest_resistance.touches);
        expect(res.nearestResistance!.strength).toBeCloseTo(expected.nearest_resistance.strength, 8);
        expect(res.nearestResistance!.state).toBe(expected.nearest_resistance.state);
      } else {
        expect(res.nearestResistance, `[${name}] expected nearestResistance to be null`).toBeNull();
      }

      // 6. Risk Distance ATR
      if (expected.risk_distance_atr !== null) {
        expect(res.riskDistanceAtr, `[${name}] expected riskDistanceAtr not null`).not.toBeNull();
        expect(res.riskDistanceAtr!).toBeCloseTo(expected.risk_distance_atr, 8);
      } else {
        expect(res.riskDistanceAtr, `[${name}] expected riskDistanceAtr to be null`).toBeNull();
      }

      // 7. Total levels count
      expect(res.levels.length, `[${name}] total levels count mismatch`).toBe(expected.levels_count);

      // 8. Individual levels match
      for (let i = 0; i < expected.levels.length; i++) {
        const expLvl = expected.levels[i];
        const actLvl = res.levels[i];
        expect(actLvl.kind, `[${name}] level ${i} kind mismatch`).toBe(expLvl.kind);
        expect(actLvl.source, `[${name}] level ${i} source mismatch`).toBe(expLvl.source);
        expect(actLvl.side, `[${name}] level ${i} side mismatch`).toBe(expLvl.side);
        expect(actLvl.touches, `[${name}] level ${i} touches mismatch`).toBe(expLvl.touches);
        expect(actLvl.state, `[${name}] level ${i} state mismatch`).toBe(expLvl.state);
        expect(actLvl.price, `[${name}] level ${i} price mismatch`).toBeCloseTo(expLvl.price, 8);
        expect(actLvl.strength, `[${name}] level ${i} strength mismatch`).toBeCloseTo(expLvl.strength, 8);
      }
    });
  }
});
