/**
 * Equity Watch: Shipped TypeScript Historical Frequency Replay (Gate E7)
 * Directly exercises the shipped evaluateAlerts and computeLevels code.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateAlerts, type EvaluatedAlert, type HistoricalAlertRef } from "../../api/src/modules/equity-research/domain/alert-rules.js";
import { computeLevels, type LevelsResult } from "../../api/src/modules/equity-research/domain/levels.js";
import rulesData from "../../api/src/modules/equity-research/domain/equity-alerts-v1.json" with { type: "json" };

const REPO_ROOT = resolve(__dirname, "../../..");
const MANIFEST_PATH = join(REPO_ROOT, "apps/ml/research_data/manifest.csv");
const RAW_DIR = join(REPO_ROOT, "apps/ml/research_data/raw");
const REPORT_PATH = join(REPO_ROOT, "docs/2026-10-19-equity-alerts-frequency-replay-report.md");

interface RawBar {
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function parseRawBars(symbol: string): RawBar[] {
  const filePath = join(RAW_DIR, `${symbol}.json`);
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  const result = raw.chart.result[0];
  const timestamps: number[] = result.timestamp ?? [];
  const quotes = result.indicators.quote[0];
  const opens: (number | null)[] = quotes.open ?? [];
  const highs: (number | null)[] = quotes.high ?? [];
  const lows: (number | null)[] = quotes.low ?? [];
  const closes: (number | null)[] = quotes.close ?? [];
  const volumes: (number | null)[] = quotes.volume ?? [];

  const bars: RawBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    const v = volumes[i];

    if (
      o !== null &&
      h !== null &&
      l !== null &&
      c !== null &&
      Number.isFinite(o) &&
      Number.isFinite(h) &&
      Number.isFinite(l) &&
      Number.isFinite(c) &&
      c > 0
    ) {
      const dateStr = new Date(t * 1000).toISOString().slice(0, 10);
      bars.push({
        bar_date: dateStr,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v ?? 0,
      });
    }
  }

  // Sort ascending by date and dedup
  bars.sort((a, b) => a.bar_date.localeCompare(b.bar_date));
  const deduped: RawBar[] = [];
  for (const b of bars) {
    if (deduped.length === 0 || deduped[deduped.length - 1].bar_date !== b.bar_date) {
      deduped.push(b);
    }
  }
  return deduped;
}

export function runReplay(limitStocks?: number) {
  const t0 = Date.now();
  const manifestContent = readFileSync(MANIFEST_PATH, "utf8");
  const lines = manifestContent.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const statusIdx = header.indexOf("status");
  const symIdx = header.indexOf("symbol");

  const qualified: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols[statusIdx] === "QUALIFIED" && cols[symIdx] !== "^NSEI") {
      qualified.push(cols[symIdx]);
    }
  }

  const symbols = limitStocks ? qualified.slice(0, limitStocks) : qualified;
  console.log(`Starting shipped TypeScript replay across ${symbols.length} stocks...`);

  const monthlyCountsAll: number[] = [];
  const levelCountsByKind: Record<string, number> = {
    LEVEL_BREAK: 0,
    LEVEL_ZONE_ENTER: 0,
    LEVEL_APPROACH: 0,
  };

  let totalBarsProcessed = 0;

  for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
    const sym = symbols[sIdx];
    const bars = parseRawBars(sym);
    if (bars.length < 258) continue;

    const monthlyCounts: Record<string, number> = {};
    const activeMonths = new Set<string>();

    const recentAlerts: HistoricalAlertRef[] = [];
    let prevLevels: LevelsResult | null = null;

    for (let T = 258; T < bars.length; T++) {
      totalBarsProcessed++;
      const evalDate = bars[T].bar_date;
      const monthKey = evalDate.slice(0, 7);
      activeMonths.add(monthKey);
      if (!(monthKey in monthlyCounts)) {
        monthlyCounts[monthKey] = 0;
      }

      const windowBars = bars.slice(Math.max(0, T - 599), T + 1);
      const levelsAtT = computeLevels({
        bars: windowBars,
        rebackfillNeeded: false,
        asOfEvaluationDate: evalDate,
      });

      const emitted = evaluateAlerts({
        stockId: sym,
        stockSymbol: sym,
        levelsAtT,
        levelsAtTMinus1: prevLevels,
        bars: bars.slice(0, T + 1),
        recentAlerts,
        evaluationDate: evalDate,
      });

      for (const a of emitted) {
        recentAlerts.push({
          kind: a.kind,
          levelKey: a.levelKey,
          evaluatedDate: a.evaluatedDate,
          payload: a.payload,
        });

        if (
          a.kind === "LEVEL_BREAK" ||
          a.kind === "LEVEL_ZONE_ENTER" ||
          a.kind === "LEVEL_APPROACH"
        ) {
          monthlyCounts[monthKey]++;
          levelCountsByKind[a.kind]++;
        }
      }

      // Prune recentAlerts older than cooldown window
      if (recentAlerts.length > 50) {
        recentAlerts.splice(0, recentAlerts.length - 30);
      }

      prevLevels = levelsAtT;
    }

    for (const m of activeMonths) {
      monthlyCountsAll.push(monthlyCounts[m] ?? 0);
    }

    if ((sIdx + 1) % 25 === 0 || sIdx + 1 === symbols.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  Processed ${sIdx + 1}/${symbols.length} stocks (${elapsed}s elapsed)`);
    }
  }

  // Compute distribution
  monthlyCountsAll.sort((a, b) => a - b);
  const n = monthlyCountsAll.length;
  const median = n % 2 === 0 ? (monthlyCountsAll[n / 2 - 1] + monthlyCountsAll[n / 2]) / 2 : monthlyCountsAll[Math.floor(n / 2)];
  const p75 = monthlyCountsAll[Math.floor(n * 0.75)];
  const p90 = monthlyCountsAll[Math.floor(n * 0.90)];
  const p95 = monthlyCountsAll[Math.floor(n * 0.95)];
  const p99 = monthlyCountsAll[Math.floor(n * 0.99)];
  const mean = monthlyCountsAll.reduce((a, b) => a + b, 0) / (n || 1);
  const max = monthlyCountsAll[n - 1] ?? 0;

  const passedMedian = median <= 3.0;
  const passedP95 = p95 <= 8.0;
  const verdict = passedMedian && passedP95 ? "PASS" : "FAIL";

  console.log("\n============================================================");
  console.log("SHIPPED TYPESCRIPT FREQUENCY REPLAY SUMMARY (Gate E7)");
  console.log("============================================================");
  console.log(`Stocks Evaluated:         ${symbols.length}`);
  console.log(`Total Stock-Months:       ${n}`);
  console.log(`Total Bars Replayed:      ${totalBarsProcessed}`);
  console.log(`Median Alerts / Month:    ${median.toFixed(1)} (Budget: <= 3.0) -> ${passedMedian ? "PASS" : "FAIL"}`);
  console.log(`95th Percentile / Month:  ${p95.toFixed(1)} (Budget: <= 8.0) -> ${passedP95 ? "PASS" : "FAIL"}`);
  console.log(`Mean Alerts / Month:      ${mean.toFixed(2)}`);
  console.log(`75th Percentile:          ${p75.toFixed(1)}`);
  console.log(`90th Percentile:          ${p90.toFixed(1)}`);
  console.log(`99th Percentile:          ${p99.toFixed(1)}`);
  console.log(`Max Alerts in Any Month:  ${max}`);
  console.log(`Breakdown by Kind:        BREAK=${levelCountsByKind.LEVEL_BREAK}, ZONE_ENTER=${levelCountsByKind.LEVEL_ZONE_ENTER}, APPROACH=${levelCountsByKind.LEVEL_APPROACH}`);
  console.log(`Gate E7 Verdict:          ${verdict}`);
  console.log(`Elapsed Time:             ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("============================================================");

  const totalLevelAlerts =
    levelCountsByKind.LEVEL_BREAK +
    levelCountsByKind.LEVEL_ZONE_ENTER +
    levelCountsByKind.LEVEL_APPROACH;
  const breakPct = totalLevelAlerts > 0 ? ((levelCountsByKind.LEVEL_BREAK / totalLevelAlerts) * 100).toFixed(1) : "0.0";
  const zonePct = totalLevelAlerts > 0 ? ((levelCountsByKind.LEVEL_ZONE_ENTER / totalLevelAlerts) * 100).toFixed(1) : "0.0";
  const approachPct = totalLevelAlerts > 0 ? ((levelCountsByKind.LEVEL_APPROACH / totalLevelAlerts) * 100).toFixed(1) : "0.0";

  const verdictProse = verdict === "PASS"
    ? `The measured frequency distribution strictly satisfies the pre-registered budget criteria (Median ${median.toFixed(1)} $\\le 3.0$, p95 ${p95.toFixed(1)} $\\le 8.0$). Gate E7 status is **PASS**.`
    : `The measured frequency distribution exceeds the pre-registered budget criteria (Median ${median.toFixed(1)} > 3.0 or p95 ${p95.toFixed(1)} > 8.0). Gate E7 status is **FAIL**.`;

  // Generate Report
  const report = `# Equity Alerts Historical Replay Report (Gate E7)

**Evaluated Engine:** Shipped TypeScript implementation (\`evaluateAlerts\` and \`computeLevels\`)  
**Rule Set:** \`apps/api/src/modules/equity-research/domain/equity-alerts-v1.json\`  
**Execution Date:** 2026-10-19  
**Gate E7 Verdict:** **${verdict}**

---

## 1. Frequency Budget Audit Summary

| Metric | Budget Target | Measured Shipped TypeScript Value | Gate E7 Status |
|---|:---:|:---:|:---:|
| **Median Level Alerts per Stock-Month** | $\\le 3.0$ | **${median.toFixed(1)}** | **${passedMedian ? "PASS" : "FAIL"}** |
| **95th Percentile per Stock-Month** | $\\le 8.0$ | **${p95.toFixed(1)}** | **${passedP95 ? "PASS" : "FAIL"}** |
| Mean Level Alerts per Stock-Month | Descriptive | ${mean.toFixed(2)} | Info |
| 75th Percentile | Descriptive | ${p75.toFixed(1)} | Info |
| 90th Percentile | Descriptive | ${p90.toFixed(1)} | Info |
| 99th Percentile | Descriptive | ${p99.toFixed(1)} | Info |
| Maximum Single Stock-Month | Descriptive | ${max} | Info |
| Total Stocks Evaluated | - | ${symbols.length} | Confirmed |
| Total Active Stock-Months | - | ${n.toLocaleString("en-US")} | Robust Sample |
| Alert Kind Breakdown | - | BREAK: ${levelCountsByKind.LEVEL_BREAK.toLocaleString("en-US")} (${breakPct}%), ZONE_ENTER: ${levelCountsByKind.LEVEL_ZONE_ENTER.toLocaleString("en-US")} (${zonePct}%), APPROACH: ${levelCountsByKind.LEVEL_APPROACH.toLocaleString("en-US")} (${approachPct}%) | Measured Distribution |

---

## 2. Methodology & Controls

1. **Direct Code Execution:** Evaluated through the shipped TypeScript \`evaluateAlerts\` and \`computeLevels\` domain functions, eliminating cross-language drift.
2. **Lookback Requirement:** Evaluated on daily bars with a 600-bar rolling window starting after 258 bars (lookbackBars 252 + pivotHalfWindow 5 + 1).
3. **Zone-Entry Discipline:** \`LEVEL_ZONE_ENTER\` requires current day close to land strictly inside the zone after closing outside it. Intraday wicks that close outside do not trigger zone entries.
4. **Same-Day Level Priority:** At most one level alert per level per day, prioritized as \`LEVEL_BREAK\` > \`LEVEL_ZONE_ENTER\` > \`LEVEL_APPROACH\`. Breaks are never shadowed.
5. **Cooldown Scope:** Cooldown is tracked per \`(stock, kind, levelKey)\` for 10 trading days (two calendar trading weeks), guaranteeing that an approach alert cannot silence a subsequent break.
6. **Scale-Aware Keys:** Logarithmic 0.5% relative price buckets prevent level collision on low-priced equities (e.g. ₹25) and level fragmentation on high-priced equities (e.g. ₹50,000).
7. **Point-in-Time & Date Guard:** Look-ahead strictly blocked; evaluation returns empty if \`levelsAtT.asOfDate !== evalDate\`.

---

## 3. Verdict
${verdictProse}
`;

  writeFileSync(REPORT_PATH, report, "utf8");
  console.log(`Report written to ${REPORT_PATH}`);
  return { median, p95, mean, verdict };
}

if (process.argv[1]?.includes("replay_alerts_ts")) {
  const limitArg = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  runReplay(limitArg);
}
