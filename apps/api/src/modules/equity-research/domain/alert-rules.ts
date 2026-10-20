/**
 * Equity Watch: EOD Alert Engine Domain Logic
 * Work Plan: docs/2026-10-19-equity-alerts-and-event-flags-plan.md
 * Rule Set: domain/equity-alerts-v1.json
 *
 * Strict Architectural Rules:
 * 1. Pure functions only: no database, no clock, no network calls.
 * 2. Deterministic: same inputs produce identical outputs.
 * 3. Strictly descriptive: "when to look and what happened", never "what to do".
 * 4. Zero predictive advice or sentiment: no buy/sell/hold/bullish/bearish strings.
 * 5. Banned words list strictly enforced across all user-facing strings (Gate E11).
 * 6. Mandatory fixed footer attached to all alerts.
 * 7. Date alignment guard: asOfDate must equal evaluationDate.
 * 8. Same-day level collapse: at most one level alert per level per day (Break > Zone Enter > Approach).
 * 9. Cooldown tracked per kind: (stock, kind, levelKey) so breaks are never shadowed by approaches/zones.
 * 10. Scale-aware level keys: 0.5% log grid buckets prevent low-price collisions and high-price fragmentation.
 * 11. Data-health throttling: enter alert, single 5-day reminder repeat, and recovery note on exit (<= 2 per 30-day unhealthy run).
 */

import { createHash } from "node:crypto";
import rulesData from "./equity-alerts-v1.json" with { type: "json" };
import type { LevelItem, LevelsResult } from "./levels.js";
import { subtractCalendarDays } from "./trend-metrics.js";
import type { StockHealthStatus } from "./types.js";

export const EQUITY_ALERT_FOOTER =
  "Reference only. Not a forecast. In our test of six rule sets on 433 stocks none showed an edge.";

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    result[k] = canonicalize(obj[k]);
  }
  return result;
}

/**
 * Computes the canonical SHA-256 hash of the equity alert rule parameters.
 * Excludes narrative and metadata blocks ('calibration', 'disclaimer') so edits to
 * calibration history or disclaimer wording leave the frozen hash unchanged.
 * Recursively sorts keys at all depths to guarantee canonical representation.
 */
export function computeAlertRulesHash(
  rulesDataInput: Record<string, unknown> = rulesData as Record<string, unknown>,
): string {
  const { calibration, disclaimer, ...params } = rulesDataInput;
  const canonicalObj = canonicalize(params);
  return createHash("sha256")
    .update(JSON.stringify(canonicalObj))
    .digest("hex");
}

export const EQUITY_ALERT_RULES_VERSION = rulesData.version;
export const EQUITY_ALERT_RULES_HASH =
  "058320a1e578ad59f977422562f6a09e5bb36c2a3da3867d5202e8bd5fdfba58";

export type AlertKind =
  | "LEVEL_APPROACH"
  | "LEVEL_ZONE_ENTER"
  | "LEVEL_BREAK"
  | "NEW_52W_EXTREME"
  | "LARGE_MOVE"
  | "DATA_EVENT"
  | "DATA_HEALTH";

export type AlertSeverity = "INFO" | "NOTICE";

export interface AlertRulesConfig {
  version: string;
  calibrationHistory?: Array<{
    date: string;
    description: string;
    changes: Record<string, unknown>;
  }>;
  levelApproach: {
    maxAtrDistance: number;
    minTouches: number;
    minStrength: number;
    qualifyingKinds: string[];
  };
  levelZoneEnter: {
    minTouches: number;
    minStrength: number;
    qualifyingKinds: string[];
    requireCloseInZone: boolean;
  };
  levelBreak: {
    minTouches: number;
    minStrength: number;
    qualifyingKinds: string[];
    breakNote: string;
  };
  new52wExtreme: {
    minWindowBars: number;
    calendarDays: number;
  };
  largeMove: {
    atrMultiple: number;
    atrPeriod: number;
    artifactThresholdPct: number;
  };
  dataEvent: {
    artifactThresholdPct: number;
  };
  dataHealth: {
    staleDaysThreshold: number;
    repeatCooldownTradingDays: number;
    maxRepeatsPerIncident: number;
  };
  cooldown: {
    tradingDays: number;
    scope: "KIND_AND_LEVEL";
    rationale: string;
  };
  frequencyBudget: {
    maxMedianPerStockMonth: number;
    maxP95PerStockMonth: number;
  };
  bannedWords: string[];
  disclaimer: string;
}

export type AlertSubtype =
  | "UNHEALTHY_ENTER"
  | "UNHEALTHY_REPEAT"
  | "RECOVERED"
  | "SPLIT"
  | "RESTATEMENT"
  | "DEMERGER_40PCT";

export interface AlertPayload {
  close: number;
  evaluatedDate: string;
  levelPrice?: number | null;
  levelKey?: string | null;
  levelKind?: string | null;
  levelSource?: string | null;
  levelSide?: string | null;
  levelTouches?: number | null;
  levelStrength?: number | null;
  zoneLow?: number | null;
  zoneHigh?: number | null;
  distanceAtr?: number | null;
  distancePct?: number | null;
  returnPct?: number | null;
  moveAtrMultiple?: number | null;
  atr14?: number | null;
  seriesVersion: number;
  rulesHash: string;
  disclaimer: string;
  reason?: string;
  subtype?: AlertSubtype;
  [key: string]: unknown;
}

export interface EvaluatedAlert {
  stockId: string;
  kind: AlertKind;
  levelKey: string | null;
  evaluatedDate: string; // YYYY-MM-DD
  severity: AlertSeverity;
  title: string;
  payload: AlertPayload;
}

export interface HistoricalAlertRef {
  kind: AlertKind;
  levelKey: string | null;
  evaluatedDate: string;
  payload?: {
    subtype?: AlertSubtype;
    [key: string]: unknown;
  };
}

export interface EvaluateAlertsInput {
  stockId: string;
  stockSymbol?: string;
  levelsAtT: LevelsResult;
  levelsAtTMinus1?: LevelsResult | null;
  bars: Array<{
    bar_date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  recentAlerts?: HistoricalAlertRef[];
  sourceHealthStatus?: StockHealthStatus;
  rulesConfig?: AlertRulesConfig;
  rulesHash?: string;
  evaluationDate?: string; // If omitted, uses the last bar's date in bars
}

const BANNED_REGEX = new RegExp(
  `\\b(?:${rulesData.bannedWords.join("|")})\\b`,
  "i",
);

/**
 * Checks a string against the pre-registered banned words list (Gate E11).
 * The fixed footer is allow-listed.
 */
export function checkBannedWords(
  text: string,
  allowFooter = true,
): string | null {
  let cleaned = text;
  if (allowFooter) {
    cleaned = cleaned.replace(EQUITY_ALERT_FOOTER, "");
  }
  const match = cleaned.match(BANNED_REGEX);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Checks whether a level qualifies for level alerts (Gate E3, E4, E7).
 * Swing levels require touches >= minTouches and strength >= minStrength.
 * 52W extremes and SMA200 qualify.
 * Round numbers, gaps, and volume-profile levels are excluded in v1.
 */
export function isQualifyingLevel(
  level: LevelItem,
  rules: AlertRulesConfig = rulesData as AlertRulesConfig,
): boolean {
  if (level.kind === "SWING") {
    return (
      level.touches >= rules.levelApproach.minTouches &&
      level.strength >= rules.levelApproach.minStrength
    );
  }
  return (
    level.kind === "52W_HIGH" ||
    level.kind === "52W_LOW" ||
    level.kind === "SMA_200"
  );
}

/**
 * Scale-aware level key for cooldown and de-duplication across evaluation dates.
 * Uses 0.5% (50 bps) logarithmic price buckets to prevent low-priced stocks
 * (e.g. ₹25) from collapsing distinct levels, and high-priced stocks (e.g. ₹50,000)
 * from fragmenting moving clusters. Reference levels use fixed keys.
 */
export function getLevelKey(level: LevelItem): string {
  if (
    level.kind === "SMA_200" ||
    level.kind === "52W_HIGH" ||
    level.kind === "52W_LOW" ||
    level.kind === "SMA_50"
  ) {
    return level.kind;
  }
  if (level.price > 0) {
    // 0.5% relative grid bucket: index = round(ln(price) / 0.005)
    const bucketIndex = Math.round(Math.log(level.price) / 0.005);
    const bucketPrice = Math.exp(bucketIndex * 0.005);
    return `${level.kind}_${bucketPrice.toFixed(2)}`;
  }
  return `${level.kind}_${level.price.toFixed(2)}`;
}

/**
 * Checks if an alert is suppressed by cooldown.
 * Cooldown is tracked per (stock, kind, levelKey) so an earlier approach or zone enter
 * can never suppress a later break on the same level.
 */
export function isSuppressedByCooldown(
  kind: AlertKind,
  levelKey: string | null,
  currentBarIndex: number,
  bars: Array<{ bar_date: string }>,
  recentAlerts: HistoricalAlertRef[] = [],
  cooldownTradingDays = 10,
): boolean {
  if (!recentAlerts || recentAlerts.length === 0) return false;

  const targetKey = levelKey ?? "";
  for (const prior of recentAlerts) {
    // Strict cooldown per kind and level
    if (prior.kind !== kind) continue;
    if ((prior.levelKey ?? "") !== targetKey) continue;

    // Find prior bar index (searching backwards from current date is O(1) for recent alerts)
    let priorIndex = -1;
    for (let i = currentBarIndex; i >= 0; i--) {
      if (bars[i]?.bar_date === prior.evaluatedDate) {
        priorIndex = i;
        break;
      }
    }
    if (priorIndex >= 0) {
      const tradingDaysApart = currentBarIndex - priorIndex;
      if (tradingDaysApart >= 0 && tradingDaysApart < cooldownTradingDays) {
        return true;
      }
    } else {
      // Fallback if prior bar is not in current bars slice: calendar days
      const diffDays =
        (new Date(`${bars[currentBarIndex].bar_date}T00:00:00Z`).getTime() -
          new Date(`${prior.evaluatedDate}T00:00:00Z`).getTime()) /
        (1000 * 60 * 60 * 24);
      if (diffDays >= 0 && diffDays < cooldownTradingDays * 2) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Pure evaluation function for End-of-Day Alerts (Gate E1, E2, E3, E4, E5, E6, E11, E12).
 */
export function evaluateAlerts(input: EvaluateAlertsInput): EvaluatedAlert[] {
  const rules = input.rulesConfig ?? (rulesData as AlertRulesConfig);
  const rulesHash = input.rulesHash ?? EQUITY_ALERT_RULES_HASH;
  const { stockId, levelsAtT, levelsAtTMinus1, bars, recentAlerts = [] } = input;

  if (!bars || bars.length === 0) {
    return [];
  }

  const evalDate = input.evaluationDate ?? bars[bars.length - 1].bar_date;
  const currentBarIndex = bars.findIndex((b) => b.bar_date === evalDate);

  // Gate E12: If no bar exists for the evaluation date (weekend, holiday), do not evaluate
  if (currentBarIndex === -1) {
    return [];
  }

  // Date alignment guard: return nothing if levelsAtT.asOfDate differs from evalDate
  if (levelsAtT.asOfDate && levelsAtT.asOfDate !== evalDate) {
    return [];
  }

  // Gate E2: Point-in-time enforcement: only bars up to evalDate are accessible
  const usableBars = bars.slice(0, currentBarIndex + 1);
  const currentBar = usableBars[usableBars.length - 1];
  const priorBar = usableBars.length > 1 ? usableBars[usableBars.length - 2] : null;

  const seriesVersion = levelsAtT.seriesVersion ?? 1;
  const currentClose = currentBar.close;
  const prevClose = priorBar ? priorBar.close : null;
  const atr14 = levelsAtT.atr14 ?? 0;
  const atrPercent = levelsAtT.atrPercent ?? 0;

  // Gate E6: Evaluate 40%+ artifact move BEFORE the health branch.
  // The levels engine restarts its series after a 40%+ move so levelsAtT becomes INSUFFICIENT_HISTORY.
  // We evaluate the artifact move first to emit DATA_EVENT, never DATA_HEALTH, on the day of the move.
  if (prevClose !== null && prevClose > 0) {
    const oneDayReturn = (currentClose - prevClose) / prevClose;
    const absOneDayReturn = Math.abs(oneDayReturn);

    if (absOneDayReturn >= rules.dataEvent.artifactThresholdPct) {
      if (
        !isSuppressedByCooldown(
          "DATA_EVENT",
          null,
          currentBarIndex,
          bars,
          recentAlerts,
          rules.cooldown.tradingDays,
        )
      ) {
        return [
          {
            stockId,
            kind: "DATA_EVENT",
            levelKey: null,
            evaluatedDate: evalDate,
            severity: "NOTICE",
            title: `Large price movement of ${(oneDayReturn * 100).toFixed(2)}% on ${evalDate} (possible corporate action).`,
            payload: {
              close: currentClose,
              evaluatedDate: evalDate,
              returnPct: oneDayReturn,
              atr14: null,
              atrPercent: null,
              seriesVersion,
              rulesHash,
              disclaimer: EQUITY_ALERT_FOOTER,
              subtype: "DEMERGER_40PCT",
            },
          },
        ];
      }
      return [];
    }
  }

  // Gate E5: Non-OK stocks produce throttled DATA_HEALTH alerts and zero level alerts
  const isDataHealthProblem =
    levelsAtT.state !== "OK" ||
    levelsAtT.isStale ||
    levelsAtT.rebackfillNeeded ||
    input.sourceHealthStatus === "RATE_LIMITED" ||
    input.sourceHealthStatus === "UNAVAILABLE";

  // Find most recent DATA_HEALTH alert for this stock to govern state-transition throttling
  const recentHealthAlerts = recentAlerts
    .filter((a) => a.kind === "DATA_HEALTH")
    .sort((a, b) => b.evaluatedDate.localeCompare(a.evaluatedDate));
  const lastHealthAlert = recentHealthAlerts[0] ?? null;
  const lastHealthSubtype = lastHealthAlert?.payload?.subtype;

  if (isDataHealthProblem) {
    let reason = "Data health notice";
    if (levelsAtT.rebackfillNeeded) {
      reason = "Stock data is suspended due to pending historical re-backfill.";
    } else if (levelsAtT.state === "INSUFFICIENT_HISTORY") {
      // Check if insufficient history was caused by a recent corporate action / artifact move
      let artifactDate: string | null = null;
      for (let i = currentBarIndex; i >= Math.max(1, currentBarIndex - 30); i--) {
        const c = bars[i].close;
        const p = bars[i - 1].close;
        if (p > 0 && Math.abs((c - p) / p) >= rules.dataEvent.artifactThresholdPct) {
          artifactDate = bars[i].bar_date;
          break;
        }
      }
      if (artifactDate) {
        reason = `Insufficient history to compute levels (possible corporate action on ${artifactDate}).`;
      } else {
        reason = "Insufficient history to compute levels.";
      }
    } else if (levelsAtT.isStale) {
      reason = `Data is stale (${levelsAtT.staleDays} days since last bar).`;
    } else if (input.sourceHealthStatus === "RATE_LIMITED") {
      reason = "Data source rate limit cooldown active.";
    } else if (input.sourceHealthStatus === "UNAVAILABLE") {
      reason = "Data source is currently unavailable.";
    }

    // Determine whether to emit UNHEALTHY_ENTER, UNHEALTHY_REPEAT, or suppress
    const priorIndex = lastHealthAlert
      ? bars.findIndex((b) => b.bar_date === lastHealthAlert.evaluatedDate)
      : -1;
    const tradingDaysSincePrior =
      priorIndex >= 0 ? currentBarIndex - priorIndex : 999;

    let shouldEmit = false;
    let subtype: "UNHEALTHY_ENTER" | "UNHEALTHY_REPEAT" = "UNHEALTHY_ENTER";

    if (!lastHealthAlert || lastHealthSubtype === "RECOVERED") {
      // Transitioning from healthy to unhealthy
      shouldEmit = true;
      subtype = "UNHEALTHY_ENTER";
    } else if (lastHealthSubtype === "UNHEALTHY_ENTER") {
      // Repeat after at least 5 trading days (max 1 repeat per unhealthy incident)
      const repeatDays =
        rules.dataHealth?.repeatCooldownTradingDays ?? 5;
      if (tradingDaysSincePrior >= repeatDays) {
        shouldEmit = true;
        subtype = "UNHEALTHY_REPEAT";
      }
    }
    // If lastHealthSubtype === "UNHEALTHY_REPEAT", suppress all further repeats (max 2 alerts per 30-day run)

    if (shouldEmit) {
      const title =
        subtype === "UNHEALTHY_ENTER"
          ? `Data health notice: Entering unhealthy state - ${reason}`
          : `Data health notice: Persisting unhealthy state (reminder) - ${reason}`;

      const payload: AlertPayload = {
        close: currentBar.close,
        evaluatedDate: evalDate,
        seriesVersion,
        rulesHash,
        disclaimer: EQUITY_ALERT_FOOTER,
        reason,
        subtype,
      };

      return [
        {
          stockId,
          kind: "DATA_HEALTH",
          levelKey: null,
          evaluatedDate: evalDate,
          severity: "NOTICE",
          title,
          payload,
        },
      ];
    }

    // Unhealthy state but throttled: emit nothing, zero level alerts
    return [];
  }

  // If currently healthy, check if recovering from a previous unhealthy state
  const alerts: EvaluatedAlert[] = [];
  if (
    lastHealthAlert &&
    (lastHealthSubtype === "UNHEALTHY_ENTER" ||
      lastHealthSubtype === "UNHEALTHY_REPEAT")
  ) {
    alerts.push({
      stockId,
      kind: "DATA_HEALTH",
      levelKey: null,
      evaluatedDate: evalDate,
      severity: "INFO",
      title: "Data health notice: Data state recovered to OK.",
      payload: {
        close: currentBar.close,
        evaluatedDate: evalDate,
        seriesVersion,
        rulesHash,
        disclaimer: EQUITY_ALERT_FOOTER,
        subtype: "RECOVERED",
      },
    });
  }

  // 1. Large Move Check (abs return >= 2.5 * ATR%, strictly below 40% artifact threshold)
  if (prevClose !== null && prevClose > 0) {
    const oneDayReturn = (currentClose - prevClose) / prevClose;
    const absOneDayReturn = Math.abs(oneDayReturn);

    if (
      atrPercent > 0 &&
      absOneDayReturn >= rules.largeMove.atrMultiple * atrPercent
    ) {
      const moveAtrMultiple = absOneDayReturn / atrPercent;
      if (
        !isSuppressedByCooldown(
          "LARGE_MOVE",
          null,
          currentBarIndex,
          bars,
          recentAlerts,
          rules.cooldown.tradingDays,
        )
      ) {
        alerts.push({
          stockId,
          kind: "LARGE_MOVE",
          levelKey: null,
          evaluatedDate: evalDate,
          severity: "INFO",
          title: `Closed at ${currentClose.toFixed(2)}, daily return ${(oneDayReturn * 100).toFixed(2)}% (${moveAtrMultiple.toFixed(1)}x ATR).`,
          payload: {
            close: currentClose,
            evaluatedDate: evalDate,
            returnPct: oneDayReturn,
            moveAtrMultiple,
            atr14,
            atrPercent,
            seriesVersion,
            rulesHash,
            disclaimer: EQUITY_ALERT_FOOTER,
          },
        });
      }
    }
  }

  // 2. 52-Week Extreme Check
  const cutoffDate = subtractCalendarDays(
    evalDate,
    rules.new52wExtreme.calendarDays,
  );
  const windowBarsBeforeT = usableBars.slice(0, usableBars.length - 1).filter(
    (b) => b.bar_date > cutoffDate,
  );

  if (windowBarsBeforeT.length >= rules.new52wExtreme.minWindowBars) {
    let priorMaxHigh = -Infinity;
    let priorMinLow = Infinity;
    for (const b of windowBarsBeforeT) {
      if (b.high > priorMaxHigh) priorMaxHigh = b.high;
      if (b.low < priorMinLow) priorMinLow = b.low;
    }

    if (currentClose > priorMaxHigh) {
      if (
        !isSuppressedByCooldown(
          "NEW_52W_EXTREME",
          "52W_HIGH",
          currentBarIndex,
          bars,
          recentAlerts,
          rules.cooldown.tradingDays,
        )
      ) {
        alerts.push({
          stockId,
          kind: "NEW_52W_EXTREME",
          levelKey: "52W_HIGH",
          evaluatedDate: evalDate,
          severity: "INFO",
          title: `Closed at ${currentClose.toFixed(2)}, a new 52-week high.`,
          payload: {
            close: currentClose,
            evaluatedDate: evalDate,
            levelPrice: priorMaxHigh,
            levelKey: "52W_HIGH",
            atr14,
            seriesVersion,
            rulesHash,
            disclaimer: EQUITY_ALERT_FOOTER,
          },
        });
      }
    } else if (currentClose < priorMinLow) {
      if (
        !isSuppressedByCooldown(
          "NEW_52W_EXTREME",
          "52W_LOW",
          currentBarIndex,
          bars,
          recentAlerts,
          rules.cooldown.tradingDays,
        )
      ) {
        alerts.push({
          stockId,
          kind: "NEW_52W_EXTREME",
          levelKey: "52W_LOW",
          evaluatedDate: evalDate,
          severity: "INFO",
          title: `Closed at ${currentClose.toFixed(2)}, a new 52-week low.`,
          payload: {
            close: currentClose,
            evaluatedDate: evalDate,
            levelPrice: priorMinLow,
            levelKey: "52W_LOW",
            atr14,
            seriesVersion,
            rulesHash,
            disclaimer: EQUITY_ALERT_FOOTER,
          },
        });
      }
    }
  }

  // 3. Level Alerts: LEVEL_APPROACH, LEVEL_ZONE_ENTER, LEVEL_BREAK (Gate E3, E4, E7)
  // At most ONE alert per level per day, prioritized: Break > Zone Enter > Approach
  const qualifyingLevels = levelsAtT.levels.filter((lvl) =>
    isQualifyingLevel(lvl, rules),
  );

  const prevAtr14 = levelsAtTMinus1?.atr14 ?? atr14;

  // Group candidate alerts by level key
  const candidatesByLevelKey = new Map<string, EvaluatedAlert[]>();

  for (const level of qualifyingLevels) {
    const key = getLevelKey(level);
    const sideLabel = level.side === "SUPPORT" ? "support" : "resistance";

    if (!candidatesByLevelKey.has(key)) {
      candidatesByLevelKey.set(key, []);
    }
    const levelCandidates = candidatesByLevelKey.get(key)!;

    // A. LEVEL_BREAK (Gate E3 - Highest Priority)
    // Strictly fires on the exact date of the break (brokenOn === evalDate), preventing late events
    const isBrokenToday = level.brokenOn === evalDate;

    if (isBrokenToday) {
      levelCandidates.push({
        stockId,
        kind: "LEVEL_BREAK",
        levelKey: key,
        evaluatedDate: evalDate,
        severity: "NOTICE",
        title: `${sideLabel.charAt(0).toUpperCase() + sideLabel.slice(1)} level ${level.price.toFixed(2)} (${level.source}) changed to ${level.state}. ${rules.levelBreak.breakNote}.`,
        payload: {
          close: currentClose,
          evaluatedDate: evalDate,
          levelPrice: level.price,
          levelKey: key,
          levelKind: level.kind,
          levelSource: level.source,
          levelSide: level.side,
          levelTouches: level.touches,
          levelStrength: level.strength,
          zoneLow: level.zoneLow,
          zoneHigh: level.zoneHigh,
          atr14,
          seriesVersion,
          rulesHash,
          disclaimer: EQUITY_ALERT_FOOTER,
        },
      });
    }

    // B. LEVEL_ZONE_ENTER (Gate E4 - Second Priority)
    // Fires only when the close lands inside the zone and prior close was strictly outside it
    if (prevClose !== null) {
      const priorCloseOutsideZone =
        prevClose < level.zoneLow || prevClose > level.zoneHigh;
      const todayCloseInsideZone =
        currentClose >= level.zoneLow && currentClose <= level.zoneHigh;

      if (priorCloseOutsideZone && todayCloseInsideZone) {
        levelCandidates.push({
          stockId,
          kind: "LEVEL_ZONE_ENTER",
          levelKey: key,
          evaluatedDate: evalDate,
          severity: "INFO",
          title: `Entered zone [${level.zoneLow.toFixed(2)} - ${level.zoneHigh.toFixed(2)}] for ${sideLabel} ${level.price.toFixed(2)} (${level.source}).`,
          payload: {
            close: currentClose,
            evaluatedDate: evalDate,
            levelPrice: level.price,
            levelKey: key,
            levelKind: level.kind,
            levelSource: level.source,
            levelSide: level.side,
            levelTouches: level.touches,
            levelStrength: level.strength,
            zoneLow: level.zoneLow,
            zoneHigh: level.zoneHigh,
            atr14,
            seriesVersion,
            rulesHash,
            disclaimer: EQUITY_ALERT_FOOTER,
          },
        });
      }
    }

    // C. LEVEL_APPROACH (Third Priority)
    // Close is within maxAtrDistance of level and was farther away the day before
    if (atr14 > 0 && prevClose !== null && prevAtr14 > 0) {
      const currDistAtr = Math.abs(currentClose - level.price) / atr14;
      const prevDistAtr = Math.abs(prevClose - level.price) / prevAtr14;

      if (
        currDistAtr <= rules.levelApproach.maxAtrDistance &&
        prevDistAtr > rules.levelApproach.maxAtrDistance
      ) {
        const relation = currentClose >= level.price ? "above" : "below";
        levelCandidates.push({
          stockId,
          kind: "LEVEL_APPROACH",
          levelKey: key,
          evaluatedDate: evalDate,
          severity: "INFO",
          title: `Closed at ${currentClose.toFixed(2)}, ${currDistAtr.toFixed(1)} ATR ${relation} ${sideLabel} ${level.price.toFixed(2)} (${level.source}).`,
          payload: {
            close: currentClose,
            evaluatedDate: evalDate,
            levelPrice: level.price,
            levelKey: key,
            levelKind: level.kind,
            levelSource: level.source,
            levelSide: level.side,
            levelTouches: level.touches,
            levelStrength: level.strength,
            distanceAtr: currDistAtr,
            zoneLow: level.zoneLow,
            zoneHigh: level.zoneHigh,
            atr14,
            seriesVersion,
            rulesHash,
            disclaimer: EQUITY_ALERT_FOOTER,
          },
        });
      }
    }
  }

  // Resolve same-day priority per level: Break > Zone Enter > Approach
  const priorityOrder: Record<AlertKind, number> = {
    LEVEL_BREAK: 1,
    LEVEL_ZONE_ENTER: 2,
    LEVEL_APPROACH: 3,
    DATA_HEALTH: 0,
    DATA_EVENT: 0,
    NEW_52W_EXTREME: 4,
    LARGE_MOVE: 4,
  };

  for (const [, candidates] of candidatesByLevelKey.entries()) {
    if (candidates.length === 0) continue;

    // Sort by priority ascending (1 is highest)
    candidates.sort(
      (a, b) => (priorityOrder[a.kind] ?? 99) - (priorityOrder[b.kind] ?? 99),
    );

    // Pick top priority candidate that is not suppressed by cooldown
    for (const topCandidate of candidates) {
      if (
        !isSuppressedByCooldown(
          topCandidate.kind,
          topCandidate.levelKey,
          currentBarIndex,
          bars,
          recentAlerts,
          rules.cooldown.tradingDays,
        )
      ) {
        alerts.push(topCandidate);
        break; // Only one alert per level per day
      }
    }
  }

  return alerts;
}
