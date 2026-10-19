import { describe, expect, it } from "vitest";
import {
  checkBannedWords,
  EQUITY_ALERT_FOOTER,
  EQUITY_ALERT_RULES_HASH,
  EQUITY_ALERT_RULES_VERSION,
  evaluateAlerts,
  getLevelKey,
  isQualifyingLevel,
  isSuppressedByCooldown,
  type EvaluatedAlert,
  type HistoricalAlertRef,
} from "./alert-rules.js";
import { type LevelItem, type LevelsResult } from "./levels.js";

// Helper to create synthetic daily bars
function createSyntheticBars(
  count: number,
  startPrice = 100,
  startDate = "2025-01-01",
  dailyReturn = 0.001,
): Array<{
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> {
  const bars: Array<{
    bar_date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];

  const start = new Date(`${startDate}T00:00:00Z`);
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const curDate = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    const dateStr = curDate.toISOString().slice(0, 10);

    const prevPrice = price;
    price = prevPrice * (1 + dailyReturn);

    bars.push({
      bar_date: dateStr,
      open: prevPrice,
      high: Math.max(prevPrice, price) * 1.005,
      low: Math.min(prevPrice, price) * 0.995,
      close: price,
      volume: 1_000_000,
    });
  }

  return bars;
}

function mockLevelsResult(
  overrides: Partial<LevelsResult> = {},
): LevelsResult {
  return {
    asOfDate: "2026-10-19",
    isStale: false,
    staleDays: 0,
    rebackfillNeeded: false,
    seriesVersion: 1,
    state: "OK",
    atr14: 2.0,
    atrPercent: 0.02,
    levels: [],
    nearestSupport: null,
    nearestResistance: null,
    riskDistanceAtr: null,
    warnings: [],
    disclaimer: "Mock disclaimer",
    empiricalNote: "Mock empirical note",
    formulas: {},
    ...overrides,
  };
}

function mockLevelItem(overrides: Partial<LevelItem> = {}): LevelItem {
  return {
    id: "swing-0-100.00",
    price: 100.0,
    kind: "SWING",
    source: "Swing Clusters",
    side: "SUPPORT",
    touches: 3,
    strength: 1.6,
    firstDate: "2026-01-01",
    lastDate: "2026-06-01",
    distancePct: 0.01,
    distanceAtr: 0.5,
    zoneLow: 99.0,
    zoneHigh: 101.0,
    state: "INTACT",
    brokenOn: null,
    ...overrides,
  };
}

describe("Equity Alert Rules & Evaluation Engine", () => {
  describe("Metadata & Rule Set Constants", () => {
    it("exports version, calibrated hash, and mandatory disclaimer footer", () => {
      expect(EQUITY_ALERT_RULES_VERSION).toBe("equity-alerts-v1");
      expect(EQUITY_ALERT_RULES_HASH).toBe(
        "a9395c383901de063a25f833a849c0ddc952ee1f31f158030df9deaf2412ed91",
      );
      expect(EQUITY_ALERT_FOOTER).toBe(
        "Reference only. Not a forecast. In our test of six rule sets on 433 stocks none showed an edge.",
      );
    });

    it("ensures alert payloads carry the frozen SHA-256 hash (64 hex characters), not version text", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        levels: [
          mockLevelItem({
            price: 100.0,
            side: "RESISTANCE",
            state: "BROKEN",
            brokenOn: evalDate,
          }),
        ],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_HASH",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      expect(alerts.length).toBeGreaterThan(0);
      for (const a of alerts) {
        expect(a.payload.rulesHash).toBe(EQUITY_ALERT_RULES_HASH);
        expect(a.payload.rulesHash).not.toBe("equity-alerts-v1");
        expect(a.payload.rulesHash).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe("Gate E11: Banned Words Enforcement", () => {
    it("detects banned words in arbitrary strings", () => {
      expect(checkBannedWords("This is a buy signal")).toBe("buy");
      expect(checkBannedWords("Showing strong support")).toBe("strong");
      expect(checkBannedWords("Market is bullish")).toBe("bullish");
      expect(checkBannedWords("Target price is 150")).toBe("target");
      expect(checkBannedWords("We recommend holding")).toBe("recommend");
    });

    it("allows the fixed disclaimer footer", () => {
      expect(checkBannedWords(EQUITY_ALERT_FOOTER, true)).toBeNull();
    });

    it("ensures all generated alert titles and payloads have zero banned words", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;

      const level = mockLevelItem({
        price: 101.0,
        zoneLow: 100.0,
        zoneHigh: 102.0,
        touches: 3,
        strength: 1.6,
      });

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        atr14: 2.0,
        atrPercent: 0.02,
        levels: [level],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_STOCK_01",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      for (const alert of alerts) {
        expect(checkBannedWords(alert.title, false)).toBeNull();
        if (alert.payload.reason) {
          expect(checkBannedWords(alert.payload.reason, false)).toBeNull();
        }
      }
    });
  });

  describe("Qualifying Level Identification", () => {
    it("qualifies SWING levels with touches >= 3 and strength >= 1.5", () => {
      expect(
        isQualifyingLevel(mockLevelItem({ kind: "SWING", touches: 3, strength: 1.5 })),
      ).toBe(true);
      expect(
        isQualifyingLevel(mockLevelItem({ kind: "SWING", touches: 2, strength: 2.0 })),
      ).toBe(false);
      expect(
        isQualifyingLevel(mockLevelItem({ kind: "SWING", touches: 4, strength: 1.2 })),
      ).toBe(false);
    });

    it("qualifies 52W_HIGH, 52W_LOW, and SMA_200", () => {
      expect(isQualifyingLevel(mockLevelItem({ kind: "52W_HIGH" }))).toBe(true);
      expect(isQualifyingLevel(mockLevelItem({ kind: "52W_LOW" }))).toBe(true);
      expect(isQualifyingLevel(mockLevelItem({ kind: "SMA_200" }))).toBe(true);
    });

    it("excludes ROUND_NUMBER, GAP, VOLUME_PROFILE, and SMA_50 in v1", () => {
      expect(isQualifyingLevel(mockLevelItem({ kind: "ROUND_NUMBER" }))).toBe(false);
      expect(isQualifyingLevel(mockLevelItem({ kind: "GAP" }))).toBe(false);
      expect(isQualifyingLevel(mockLevelItem({ kind: "VOLUME_PROFILE_POC" }))).toBe(
        false,
      );
      expect(isQualifyingLevel(mockLevelItem({ kind: "SMA_50" }))).toBe(false);
    });
  });

  describe("Gate E1: Idempotency", () => {
    it("evaluating the same date twice produces identical alerts and payloads", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        atr14: 2.0,
        atrPercent: 0.02,
        levels: [mockLevelItem({ price: 101.0, zoneLow: 100.0, zoneHigh: 102.0 })],
      });

      const input = {
        stockId: "TEST_IDEMPOTENT",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      };

      const run1 = evaluateAlerts(input);
      const run2 = evaluateAlerts(input);

      expect(run1).toEqual(run2);
      expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
    });
  });

  describe("Gate E2: No Look-Ahead (Point-in-Time)", () => {
    it("alerts for date T are identical whether future bars exist or are truncated", () => {
      const bars = createSyntheticBars(300, 100);
      const cutIndex = 250;
      const evalDate = bars[cutIndex].bar_date;

      const truncatedBars = bars.slice(0, cutIndex + 1);

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        atr14: 2.0,
        atrPercent: 0.02,
        levels: [mockLevelItem({ price: 101.0, zoneLow: 100.0, zoneHigh: 102.0 })],
      });

      const alertsWithFuture = evaluateAlerts({
        stockId: "TEST_PIT",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      const alertsTruncated = evaluateAlerts({
        stockId: "TEST_PIT",
        levelsAtT: levelsResult,
        bars: truncatedBars,
        evaluationDate: evalDate,
      });

      expect(alertsWithFuture).toEqual(alertsTruncated);
    });
  });

  describe("Gate E3: Break & Flip Alerts", () => {
    it("fires LEVEL_BREAK when level changes to BROKEN or FLIPPED on date T", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;

      const brokenLevel = mockLevelItem({
        price: 105.0,
        kind: "SWING",
        side: "RESISTANCE",
        state: "BROKEN",
        brokenOn: evalDate,
      });

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        levels: [brokenLevel],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_BREAK",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      const breakAlert = alerts.find((a) => a.kind === "LEVEL_BREAK");
      expect(breakAlert).toBeDefined();
      expect(breakAlert?.severity).toBe("NOTICE");
      expect(breakAlert?.title).toContain(
        "Resistance level 105.00 (Swing Clusters) changed to BROKEN. In our test, breaks reversed more often than they continued.",
      );
      expect(checkBannedWords(breakAlert!.title, false)).toBeNull();
    });
  });

  describe("Same-Day Multi-Kind Collapse & Prioritization", () => {
    it("collapses multiple qualifying alerts on the same level into a single alert with priority Break > Zone Enter > Approach", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[259].bar_date;
      // Setup bar 258 outside zone (95.0), bar 259 inside zone (100.2) and breaking resistance
      bars[258].close = 95.0;
      bars[259].close = 100.2;

      const level = mockLevelItem({
        price: 100.0,
        zoneLow: 99.0,
        zoneHigh: 101.0,
        side: "RESISTANCE",
        state: "BROKEN",
        brokenOn: evalDate,
      });

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        atr14: 2.0,
        levels: [level],
      });

      // The bar satisfies:
      // 1. Break: brokenOn === evalDate
      // 2. Zone Enter: priorClose 95 < 99, currClose 100.2 in [99, 101]
      // 3. Approach: abs(100.2 - 100) / 2.0 = 0.1 ATR <= 0.5 ATR
      const alerts = evaluateAlerts({
        stockId: "TEST_COLLAPSE",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      // Exactly ONE level alert must be emitted, and it MUST be LEVEL_BREAK
      const levelAlerts = alerts.filter((a) => a.levelKey === getLevelKey(level));
      expect(levelAlerts).toHaveLength(1);
      expect(levelAlerts[0].kind).toBe("LEVEL_BREAK");

      // Now test intact level where both Zone Enter and Approach qualify: Zone Enter wins over Approach
      const intactLevel = mockLevelItem({
        price: 100.0,
        zoneLow: 99.0,
        zoneHigh: 101.0,
        side: "RESISTANCE",
        state: "INTACT",
        brokenOn: null,
      });

      const alertsIntact = evaluateAlerts({
        stockId: "TEST_COLLAPSE_ZONE",
        levelsAtT: mockLevelsResult({
          asOfDate: evalDate,
          atr14: 2.0,
          levels: [intactLevel],
        }),
        bars,
        evaluationDate: evalDate,
      });

      const intactLevelAlerts = alertsIntact.filter(
        (a) => a.levelKey === getLevelKey(intactLevel),
      );
      expect(intactLevelAlerts).toHaveLength(1);
      expect(intactLevelAlerts[0].kind).toBe("LEVEL_ZONE_ENTER");
    });
  });

  describe("Gate E4: Cooldown & Zone Enter Protection", () => {
    it("does not re-fire LEVEL_ZONE_ENTER when price sits inside the zone for 10 days", () => {
      const bars = createSyntheticBars(270, 100, "2025-01-01", 0);
      // Make bar at 259 close outside the zone (e.g. 95)
      bars[259].close = 95.0;
      bars[259].high = 96.0;
      bars[259].low = 94.0;

      // Bars 260 to 269 sit strictly inside the zone [98, 102]
      for (let i = 260; i < 270; i++) {
        bars[i].close = 100.0;
        bars[i].open = 100.0;
        bars[i].high = 101.0;
        bars[i].low = 99.0;
      }

      const zoneLevel = mockLevelItem({
        price: 100.0,
        zoneLow: 98.0,
        zoneHigh: 102.0,
      });

      const levelsResult = mockLevelsResult({
        asOfDate: bars[260].bar_date,
        levels: [zoneLevel],
      });

      // Day 1 (bar 260): Enters zone from outside (prior close 95 < 98)
      const day1Alerts = evaluateAlerts({
        stockId: "TEST_ZONE_SIT",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: bars[260].bar_date,
      });

      const day1ZoneAlert = day1Alerts.find((a) => a.kind === "LEVEL_ZONE_ENTER");
      expect(day1ZoneAlert).toBeDefined();

      // Days 2 to 10 (bars 261 to 269): Prior close was already inside zone (100 in [98, 102])
      for (let i = 261; i < 270; i++) {
        const subsequentAlerts = evaluateAlerts({
          stockId: "TEST_ZONE_SIT",
          levelsAtT: levelsResult,
          bars,
          evaluationDate: bars[i].bar_date,
          recentAlerts: [
            {
              kind: "LEVEL_ZONE_ENTER",
              levelKey: getLevelKey(zoneLevel),
              evaluatedDate: bars[260].bar_date,
            },
          ],
        });

        const reFired = subsequentAlerts.find(
          (a) => a.kind === "LEVEL_ZONE_ENTER" && a.levelKey === getLevelKey(zoneLevel),
        );
        expect(reFired).toBeUndefined();
      }
    });

    it("cooldown suppresses duplicate alerts for the same stock, kind, and level within cooldown period", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[259].bar_date;
      const priorDate = bars[255].bar_date; // 4 trading days ago

      const level = mockLevelItem({ price: 100.0 });
      expect(
        isSuppressedByCooldown(
          "LEVEL_APPROACH",
          getLevelKey(level),
          259,
          bars,
          [
            {
              kind: "LEVEL_APPROACH",
              levelKey: getLevelKey(level),
              evaluatedDate: priorDate,
            },
          ],
          10,
        ),
      ).toBe(true);

      // Outside 10 trading days (e.g. 12 trading days ago)
      const oldDate = bars[247].bar_date;
      expect(
        isSuppressedByCooldown(
          "LEVEL_APPROACH",
          getLevelKey(level),
          259,
          bars,
          [
            {
              kind: "LEVEL_APPROACH",
              levelKey: getLevelKey(level),
              evaluatedDate: oldDate,
            },
          ],
          10,
        ),
      ).toBe(false);
    });

    it("cooldown is scoped per kind: a break after an approach within 5/10 days still fires", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[259].bar_date;
      const priorDate = bars[257].bar_date; // 2 trading days ago

      const level = mockLevelItem({
        price: 100.0,
        side: "RESISTANCE",
        state: "BROKEN",
        brokenOn: evalDate,
      });
      const levelKey = getLevelKey(level);

      // Prior alert was LEVEL_APPROACH on the same level 2 days ago
      const recentAlerts: HistoricalAlertRef[] = [
        {
          kind: "LEVEL_APPROACH",
          levelKey,
          evaluatedDate: priorDate,
        },
      ];

      // Unit check: isSuppressedByCooldown allows LEVEL_BREAK
      expect(
        isSuppressedByCooldown(
          "LEVEL_BREAK",
          levelKey,
          259,
          bars,
          recentAlerts,
          5,
        ),
      ).toBe(false);

      // System check: evaluateAlerts emits LEVEL_BREAK despite recent approach
      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        levels: [level],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_KIND_COOLDOWN",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
        recentAlerts,
      });

      const breakAlert = alerts.find((a) => a.kind === "LEVEL_BREAK");
      expect(breakAlert).toBeDefined();
      expect(breakAlert?.levelKey).toBe(levelKey);
    });
  });

  describe("Gate E5: Non-OK Data States Suppression", () => {
    it("SUSPENDED produces exactly one DATA_HEALTH alert and zero level alerts", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        state: "SUSPENDED",
        rebackfillNeeded: true,
        levels: [mockLevelItem({ price: 100.0 })],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_SUSPENDED",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe("DATA_HEALTH");
      expect(alerts[0].severity).toBe("NOTICE");
      expect(alerts[0].title).toContain("re-backfill");
    });

    it("STALE produces exactly one DATA_HEALTH alert and zero level alerts", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        isStale: true,
        staleDays: 6,
        levels: [mockLevelItem({ price: 100.0 })],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_STALE",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe("DATA_HEALTH");
      expect(alerts[0].title).toContain("Data is stale");
    });

    it("RATE_LIMITED source status produces DATA_HEALTH alert", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;

      const levelsResult = mockLevelsResult({
        asOfDate: evalDate,
        levels: [mockLevelItem({ price: 100.0 })],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_RATE_LIMITED",
        levelsAtT: levelsResult,
        bars,
        sourceHealthStatus: "RATE_LIMITED",
        evaluationDate: evalDate,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe("DATA_HEALTH");
      expect(alerts[0].title).toContain("rate limit");
    });

    it("throttles repeated data health alerts across a 30-day unhealthy run (at most 2 alerts) and emits recovery note on exit", () => {
      const bars = createSyntheticBars(60, 100);
      const unhealthyStartIndex = 20;
      const unhealthyEndIndex = 50; // 30 trading days of unhealthy data

      const emittedAlerts: EvaluatedAlert[] = [];
      const runningAlertHistory: HistoricalAlertRef[] = [];

      for (let i = unhealthyStartIndex; i <= unhealthyEndIndex + 5; i++) {
        const isUnhealthyDay = i <= unhealthyEndIndex;
        const curDate = bars[i].bar_date;

        const levelsResult = mockLevelsResult({
          asOfDate: curDate,
          state: isUnhealthyDay ? "SUSPENDED" : "OK",
          rebackfillNeeded: isUnhealthyDay,
          levels: [mockLevelItem({ price: 100.0 })],
        });

        const dayAlerts = evaluateAlerts({
          stockId: "TEST_THROTTLE",
          levelsAtT: levelsResult,
          bars: bars.slice(0, i + 1),
          evaluationDate: curDate,
          recentAlerts: runningAlertHistory,
        });

        for (const a of dayAlerts) {
          emittedAlerts.push(a);
          runningAlertHistory.push({
            kind: a.kind,
            levelKey: a.levelKey,
            evaluatedDate: a.evaluatedDate,
            payload: a.payload,
          });
        }
      }

      // During the 30-day unhealthy run (indexes 20 to 50):
      const alertsDuringUnhealthy = emittedAlerts.filter(
        (a) => a.evaluatedDate <= bars[unhealthyEndIndex].bar_date,
      );
      // Exactly 2 alerts: UNHEALTHY_ENTER on day 1 (index 20) and UNHEALTHY_REPEAT on day 6 (index 25)
      expect(alertsDuringUnhealthy).toHaveLength(2);
      expect(alertsDuringUnhealthy[0].payload.subtype).toBe("UNHEALTHY_ENTER");
      expect(alertsDuringUnhealthy[0].evaluatedDate).toBe(bars[20].bar_date);
      expect(alertsDuringUnhealthy[1].payload.subtype).toBe("UNHEALTHY_REPEAT");
      expect(alertsDuringUnhealthy[1].evaluatedDate).toBe(bars[25].bar_date);

      // On exit (day 51 / index 51), data is OK again -> exactly 1 recovery alert
      const recoveryAlerts = emittedAlerts.filter(
        (a) => a.payload.subtype === "RECOVERED",
      );
      expect(recoveryAlerts).toHaveLength(1);
      expect(recoveryAlerts[0].evaluatedDate).toBe(bars[unhealthyEndIndex + 1].bar_date);
      expect(recoveryAlerts[0].severity).toBe("INFO");
      expect(recoveryAlerts[0].title).toContain("recovered to OK");
    });
  });

  describe("Gate E6: 40%+ Day Yields DATA_EVENT, Never LARGE_MOVE", () => {
    it("TMPV demerger scenario (-40.15% on 2025-10-14) produces DATA_EVENT, never LARGE_MOVE", () => {
      const bars = createSyntheticBars(260, 100);
      const T = bars.length - 1;
      bars[T].bar_date = "2025-10-14";
      bars[T - 1].close = 100.0;
      bars[T].close = 59.85; // -40.15% drop

      const levelsResult = mockLevelsResult({
        asOfDate: "2025-10-14",
        atr14: 2.0,
        atrPercent: 0.02,
      });

      const alerts = evaluateAlerts({
        stockId: "TMPV",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: "2025-10-14",
      });

      const dataEventAlert = alerts.find((a) => a.kind === "DATA_EVENT");
      const largeMoveAlert = alerts.find((a) => a.kind === "LARGE_MOVE");

      expect(dataEventAlert).toBeDefined();
      expect(dataEventAlert?.severity).toBe("NOTICE");
      expect(dataEventAlert?.title).toContain("-40.15%");
      expect(largeMoveAlert).toBeUndefined();
    });

    it("normal volatility move of 2.8x ATR (e.g. +5.6% with ATR% 2.0%) produces LARGE_MOVE", () => {
      const bars = createSyntheticBars(260, 100);
      const T = bars.length - 1;
      bars[T - 1].close = 100.0;
      bars[T].close = 105.6; // +5.6% move (2.8x ATR)

      const levelsResult = mockLevelsResult({
        asOfDate: bars[T].bar_date,
        atr14: 2.0,
        atrPercent: 0.02,
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_LARGE_MOVE",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: bars[T].bar_date,
      });

      const largeMoveAlert = alerts.find((a) => a.kind === "LARGE_MOVE");
      const dataEventAlert = alerts.find((a) => a.kind === "DATA_EVENT");

      expect(largeMoveAlert).toBeDefined();
      expect(largeMoveAlert?.title).toContain("2.8x ATR");
      expect(dataEventAlert).toBeUndefined();
    });
  });

  describe("Gate E12: Missing Evaluation Date / Holiday Handling", () => {
    it("returns empty array when evaluation date is not in bars (weekend or holiday)", () => {
      const bars = createSyntheticBars(260, 100, "2025-01-01");
      const weekendDate = "2026-01-03"; // Saturday not in bars

      const levelsResult = mockLevelsResult();

      const alerts = evaluateAlerts({
        stockId: "TEST_WEEKEND",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: weekendDate,
      });

      expect(alerts).toEqual([]);
    });
  });

  describe("NEW_52W_EXTREME Detection", () => {
    it("fires NEW_52W_EXTREME when close reaches a new 52-week high", () => {
      const bars = createSyntheticBars(260, 100);
      const T = bars.length - 1;
      bars[T].close = 150.0; // Higher than any prior high
      bars[T].high = 151.0;

      const levelsResult = mockLevelsResult({
        asOfDate: bars[T].bar_date,
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_52W",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: bars[T].bar_date,
      });

      const extremeAlert = alerts.find(
        (a) => a.kind === "NEW_52W_EXTREME" && a.levelKey === "52W_HIGH",
      );
      expect(extremeAlert).toBeDefined();
      expect(extremeAlert?.title).toContain("a new 52-week high");
    });
  });

  describe("Scale-Aware Level Keys (Logarithmic 0.5% Relative Grid)", () => {
    it("differentiates distinct levels on low-priced stocks (e.g. ₹25.00 vs ₹25.30)", () => {
      // Under previous integer rounding Math.round(price), 25.00 and 25.30 both produced SWING_25 (collision)
      const level1 = mockLevelItem({ kind: "SWING", price: 25.0 });
      const level2 = mockLevelItem({ kind: "SWING", price: 25.3 });

      const key1 = getLevelKey(level1);
      const key2 = getLevelKey(level2);

      expect(key1).not.toBe(key2);
      expect(key1).toBe("SWING_25.03");
      expect(key2).toBe("SWING_25.28");
    });

    it("clusters closely matching prices on high-priced stocks (e.g. ₹50,000)", () => {
      const levelA = mockLevelItem({ kind: "SWING", price: 50000.0 });
      const levelB = mockLevelItem({ kind: "SWING", price: 50010.0 }); // 0.02% difference -> same 0.5% bucket
      const levelC = mockLevelItem({ kind: "SWING", price: 50500.0 }); // 1.0% difference -> different bucket

      const keyA = getLevelKey(levelA);
      const keyB = getLevelKey(levelB);
      const keyC = getLevelKey(levelC);

      expect(keyA).toBe(keyB);
      expect(keyA).not.toBe(keyC);
    });

    it("preserves fixed keys for reference levels regardless of price", () => {
      expect(getLevelKey(mockLevelItem({ kind: "SMA_200", price: 152.5 }))).toBe("SMA_200");
      expect(getLevelKey(mockLevelItem({ kind: "52W_HIGH", price: 210.0 }))).toBe("52W_HIGH");
      expect(getLevelKey(mockLevelItem({ kind: "52W_LOW", price: 85.0 }))).toBe("52W_LOW");
      expect(getLevelKey(mockLevelItem({ kind: "SMA_50", price: 140.0 }))).toBe("SMA_50");
    });
  });

  describe("Date Misalignment Guard", () => {
    it("returns empty array if levelsResult.asOfDate differs from evaluationDate", () => {
      const bars = createSyntheticBars(260, 100);
      const evalDate = bars[bars.length - 1].bar_date;
      const mismatchedDate = bars[bars.length - 2].bar_date;

      const levelsResult = mockLevelsResult({
        asOfDate: mismatchedDate, // Stale / mismatched asOfDate
        levels: [mockLevelItem({ price: 100.0 })],
      });

      const alerts = evaluateAlerts({
        stockId: "TEST_MISALIGNMENT",
        levelsAtT: levelsResult,
        bars,
        evaluationDate: evalDate,
      });

      expect(alerts).toEqual([]);
    });
  });
});

