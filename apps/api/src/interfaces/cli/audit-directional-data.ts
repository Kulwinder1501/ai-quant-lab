import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { auditDirectionalCandles } from "../../modules/research/directional-v2/application/audit-directional-candles.js";
import { createStandardNseSession, type SessionCandle } from "../../modules/research/directional-v2/domain/session-calendar.js";
import { phase29ExcludedSpecialSessionMap } from "../../modules/research/directional-v2/domain/excluded-special-sessions.js";
import {
  phase29DataQualityCandleExclusionMap,
  phase29DataQualitySessionExclusionMap,
} from "../../modules/research/directional-v2/domain/data-quality-exclusions.js";

/**
 * Phase 29 §3: Data-Readiness Gate for Directional Intelligence V2.
 *
 * Audits the 1m candle series for NIFTYBEES and BANKBEES:
 * - Session count, bar count, date range, non-zero volume percentage
 * - Checks for duplicate timestamps or out-of-session bars
 * - Verifies indicator definition coverage and intersection between the pair
 *
 * Usage:
 *   node --loader ts-node/esm apps/api/src/interfaces/cli/audit-directional-data.ts
 */

interface SeriesSummary {
  readonly symbol: string;
  readonly barCount: number;
  readonly sessionCount: number;
  readonly firstSession: string;
  readonly lastSession: string;
  readonly nonZeroVolumePct: number;
  readonly duplicateCount: number;
  readonly indicatorDefCount: number;
  readonly indicatorDefCodes: string[];
  readonly auditIssueCount: number;
  readonly auditIssuePreview: readonly string[];
  readonly auditIssueCounts: Readonly<Record<string, number>>;
  readonly auditIssueDates: readonly string[];
  readonly excludedSpecialSessionCount: number;
  readonly excludedSpecialCandleCount: number;
  readonly excludedDataQualitySessionCount: number;
  readonly excludedDataQualityCandleCount: number;
}

async function main(): Promise<void> {
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  const excludedSpecialSessions = phase29ExcludedSpecialSessionMap();

  try {
    console.info("============================================================");
    console.info("PHASE 29 — DIRECTIONAL INTELLIGENCE V2 DATA-READINESS AUDIT");
    console.info("============================================================\n");

    const targets = ["NIFTYBEES", "BANKBEES", "NIFTY50", "BANKNIFTY"];
    const summaries: SeriesSummary[] = [];

    for (const symbol of targets) {
      const excludedDataQualitySessions = phase29DataQualitySessionExclusionMap(symbol);
      const excludedCandleOpens = phase29DataQualityCandleExclusionMap(symbol);
      // 1. Basic candle counts and dates
      const candleStats = await database.query<{
        bar_count: string;
        first_open: Date | null;
        last_open: Date | null;
        zero_vol_count: string;
      }>(`
        SELECT
          COUNT(*) AS bar_count,
          MIN(c.open_time) AS first_open,
          MAX(c.open_time) AS last_open,
          COUNT(*) FILTER (WHERE c.volume = '0' OR c.volume IS NULL) AS zero_vol_count
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
      `, [symbol]);

      const statsRow = candleStats.rows[0];
      const barCount = Number(statsRow?.bar_count ?? 0);
      const firstOpen = statsRow?.first_open;
      const lastOpen = statsRow?.last_open;
      const zeroVolCount = Number(statsRow?.zero_vol_count ?? 0);
      const nonZeroVolumePct = barCount > 0 ? ((barCount - zeroVolCount) / barCount) * 100 : 0;

      // 2. Count distinct sessions
      const sessionStats = await database.query<{ session_count: string }>(`
        SELECT COUNT(DISTINCT (c.open_time AT TIME ZONE 'Asia/Kolkata')::date) AS session_count
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
      `, [symbol]);
      const sessionCount = Number(sessionStats.rows[0]?.session_count ?? 0);

      // 3. Check duplicate open_time
      const dupStats = await database.query<{ duplicate_count: string }>(`
        SELECT COUNT(*) AS duplicate_count
        FROM (
          SELECT c.open_time, COUNT(*)
          FROM candles c
          JOIN instruments i ON i.id = c.instrument_id
          WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
          GROUP BY c.open_time
          HAVING COUNT(*) > 1
        ) dups
      `, [symbol]);
      const duplicateCount = Number(dupStats.rows[0]?.duplicate_count ?? 0);

      // 4. Indicator definitions computed for this symbol on 1m
      const indStats = await database.query<{ indicator_code: string }>(`
        SELECT DISTINCT id_def.indicator_code
        FROM indicator_snapshots snap
        JOIN indicator_definitions id_def ON id_def.id = snap.indicator_definition_id
        JOIN candles c ON c.id = snap.candle_id
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = '1m'
        ORDER BY id_def.indicator_code ASC
      `, [symbol]);
      const indicatorDefCodes = indStats.rows.map((r) => r.indicator_code);

      const candleRows = await database.query<{
        open_time: Date; close_time: Date; open: string; high: string; low: string; close: string; volume: string | null;
      }>(`
        SELECT c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
        ORDER BY c.open_time ASC
      `, [symbol]);
      const auditCandles: SessionCandle[] = candleRows.rows.map((row) => ({
        openTime: new Date(row.open_time),
        closeTime: new Date(row.close_time),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume ?? 0),
      }));
      const calendarRows = firstOpen && lastOpen
        ? await database.query<{ session_date: string }>(`
          SELECT day::date::text AS session_date
          FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS dates(day)
          WHERE EXTRACT(ISODOW FROM day) BETWEEN 1 AND 5
            AND NOT EXISTS (
              SELECT 1 FROM nse_holidays holiday WHERE holiday.holiday_date = day::date
            )
          ORDER BY day ASC
        `, [firstOpen.toISOString().slice(0, 10), lastOpen.toISOString().slice(0, 10)])
        : { rows: [] as { session_date: string }[] };
      const strictAudit = auditDirectionalCandles(
        symbol,
        auditCandles,
        calendarRows.rows
          .filter((row) => (
            !excludedSpecialSessions.has(row.session_date)
            && !excludedDataQualitySessions.has(row.session_date)
          ))
          .map((row) => createStandardNseSession(row.session_date)),
        { excludedSpecialSessions, excludedDataQualitySessions, excludedCandleOpens },
      );
      const auditIssueCounts = strictAudit.issues.reduce<Record<string, number>>((counts, issue) => {
        counts[issue.code] = (counts[issue.code] ?? 0) + 1;
        return counts;
      }, {});
      const issueCountByDate = strictAudit.issues.reduce<Map<string, number>>((counts, issue) => {
        if (!issue.sessionDate) return counts;
        counts.set(issue.sessionDate, (counts.get(issue.sessionDate) ?? 0) + 1);
        return counts;
      }, new Map());
      const auditIssueDates = [...issueCountByDate.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 10)
        .map(([date, count]) => `${date}:${count}`);

      summaries.push({
        symbol,
        barCount,
        sessionCount,
        firstSession: firstOpen ? firstOpen.toISOString().slice(0, 10) : "N/A",
        lastSession: lastOpen ? lastOpen.toISOString().slice(0, 10) : "N/A",
        nonZeroVolumePct,
        duplicateCount,
        indicatorDefCount: indicatorDefCodes.length,
        indicatorDefCodes,
        auditIssueCount: strictAudit.issues.length,
        auditIssuePreview: strictAudit.issues.slice(0, 10).map((issue) => issue.message),
        auditIssueCounts,
        auditIssueDates,
        excludedSpecialSessionCount: strictAudit.excludedSpecialSessionCount,
        excludedSpecialCandleCount: strictAudit.excludedSpecialCandleCount,
        excludedDataQualitySessionCount: strictAudit.excludedDataQualitySessionCount,
        excludedDataQualityCandleCount: strictAudit.excludedDataQualityCandleCount,
      });
    }

    // Print summary table
    console.info("SERIES INVENTORY");
    console.info("--------------------------------------------------------------------------------------");
    console.info("SYMBOL       SESSIONS   BARS       FROM         TO           NON-ZERO VOL   DUPLICATES");
    console.info("--------------------------------------------------------------------------------------");
    for (const s of summaries) {
      const sym = s.symbol.padEnd(12);
      const sess = String(s.sessionCount).padStart(8);
      const bars = String(s.barCount).padStart(10);
      const from = s.firstSession.padEnd(12);
      const to = s.lastSession.padEnd(12);
      const nz = `${s.nonZeroVolumePct.toFixed(1)}%`.padStart(14);
      const dups = String(s.duplicateCount).padStart(12);
      console.info(`${sym} ${sess} ${bars}   ${from} ${to} ${nz} ${dups}`);
    }
    console.info("--------------------------------------------------------------------------------------\n");

    // Coverage intersection
    const niftybeesInds = new Set(summaries.find((s) => s.symbol === "NIFTYBEES")?.indicatorDefCodes ?? []);
    const bankbeesInds = new Set(summaries.find((s) => s.symbol === "BANKBEES")?.indicatorDefCodes ?? []);
    const intersection = Array.from(niftybeesInds).filter((x) => bankbeesInds.has(x));

    console.info("INDICATOR COVERAGE INTERSECTION");
    console.info("--------------------------------------------------------------------------------------");
    console.info(`NIFTYBEES Indicator Definitions: ${niftybeesInds.size}`);
    console.info(`BANKBEES Indicator Definitions:  ${bankbeesInds.size}`);
    console.info(`Common Indicator Definitions:    ${intersection.length}`);
    console.info(`Intersection List: ${intersection.join(", ") || "(none)"}`);
    console.info("--------------------------------------------------------------------------------------\n");

    // Readiness Verdict
    const niftybees = summaries.find((s) => s.symbol === "NIFTYBEES");
    const bankbees = summaries.find((s) => s.symbol === "BANKBEES");

    let isReady = true;
    const notes: string[] = [];

    if (!niftybees || niftybees.sessionCount < 100) {
      isReady = false;
      notes.push("NIFTYBEES has insufficient 1m session history (< 100 sessions).");
    }
    if (!bankbees || bankbees.sessionCount < 100) {
      isReady = false;
      notes.push("BANKBEES has insufficient 1m session history (< 100 sessions).");
    }
    if (niftybees && niftybees.duplicateCount > 0) {
      isReady = false;
      notes.push(`NIFTYBEES has ${niftybees.duplicateCount} duplicate timestamps.`);
    }
    if (bankbees && bankbees.duplicateCount > 0) {
      isReady = false;
      notes.push(`BANKBEES has ${bankbees.duplicateCount} duplicate timestamps.`);
    }
    for (const summary of summaries.filter((entry) => ["NIFTYBEES", "BANKBEES"].includes(entry.symbol))) {
      if (summary.excludedSpecialSessionCount > 0) {
        notes.push(
          `${summary.symbol}: explicitly excluded ${summary.excludedSpecialCandleCount} candle(s) across `
          + `${summary.excludedSpecialSessionCount} known special session(s).`,
        );
      }
      if (summary.excludedDataQualitySessionCount > 0 || summary.excludedDataQualityCandleCount > 0) {
        notes.push(
          `${summary.symbol}: data-quality policy excluded ${summary.excludedDataQualityCandleCount} candle(s) `
          + `across ${summary.excludedDataQualitySessionCount} incomplete session(s), including exact closing prints.`,
        );
      }
      if (summary.auditIssueCount > 0) {
        isReady = false;
        notes.push(`${summary.symbol} failed strict candle audit with ${summary.auditIssueCount} issue(s).`);
        notes.push(`${summary.symbol} issue counts: ${JSON.stringify(summary.auditIssueCounts)}`);
        notes.push(`${summary.symbol} highest-impact dates: ${summary.auditIssueDates.join(", ") || "none"}.`);
        notes.push(...summary.auditIssuePreview.map((message) => `${summary.symbol}: ${message}`));
      }
    }
    console.info(`DATA READINESS VERDICT: ${isReady ? "READY FOR D0/D1 STUDY" : "NOT READY"}`);
    if (notes.length > 0) {
      for (const n of notes) console.info(`  - ${n}`);
    }
    if (!isReady) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
