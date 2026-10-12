import "dotenv/config";
import { spawnSync } from "node:child_process";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  chunkMissingRange,
  scanOandaGaps,
  type MissingRange,
} from "../../modules/market-data/application/scan-oanda-gaps.js";

/**
 * Backfills holes in the OANDA 1m series that the regular 15-minute collection tick cannot reach:
 * XAU_USD, the six FX pairs the synthetic DXY is rebuilt from, and DXY itself.
 *
 * That tick only ever fetches the last 45 minutes, so whenever the host sleeps or the scheduler is
 * down for longer than that, the missed bars stay missing for good -- measured 2026-10-11: Friday
 * 15:15-21:00 UTC and 11 hours of Oct 8 were absent from gold's `candles`, and on 2026-10-12 the six FX
 * legs held only the last 45 minutes, so DXY could not be rebuilt for the days it was missing. The
 * 5m/15m series and the indicators the gold strategies read (including their DXY intermarket filter)
 * are all derived from these 1m series, so a hole propagates.
 *
 * What it does, in order:
 *  1. Scans each series for missing minutes inside gold's session calendar (the weekend close and the
 *     daily New York break are never gaps; see `isHealSessionActive` for why gold's applies to all seven).
 *  2. Fetches the missing minutes for XAU_USD and the six FX pairs from OANDA, append-only.
 *  3. Gold: if anything healed, derives 5m/15m and recomputes indicators over that window.
 *  4. DXY is never fetched -- it does not exist at OANDA. It is recomputed from the six healed legs
 *     over every window where a leg healed or DXY itself was missing (the latter catches a rebuild
 *     that failed while the legs were fine), then its indicators are recomputed if anything healed.
 *
 * Same safety properties as `data:heal-gaps` (the index healer):
 *  - Dry-run unless `--apply`.
 *  - Append-only: fetches use `--skip-existing`, and completed candles are immutable.
 *  - A run with nothing to heal is a handful of queries; derivations only run when something healed.
 *  - A range the provider has no bars for stays missing and is reported as `stillMissing` (logged,
 *    not failed), so a venue closure cannot fail the job forever. A fetch/derive/recompute command
 *    that actually errors does not stop the rest of the run, but fails the job at the end.
 *
 * Usage: heal-gold-gaps [--apply] [--lookback-days 7] [--min-gap-minutes 5]
 *                       [--tail-grace-minutes 30] [--max-chunk-minutes 4000]
 */

const MINUTE_MS = 60_000;
const HIGHER_TIMEFRAME_MARGIN_MINUTES = 15;
const GOLD = "XAU_USD";
const DXY = "DXY";
const FX_COMPONENTS = ["EUR_USD", "USD_JPY", "GBP_USD", "USD_CAD", "USD_SEK", "USD_CHF"] as const;

interface SeriesPlan {
  readonly symbol: string;
  /** OANDA series are fetched; the synthetic one is recomputed. */
  readonly origin: "OANDA" | "SYNTHETIC";
}

const SERIES: readonly SeriesPlan[] = [
  { symbol: GOLD, origin: "OANDA" },
  ...FX_COMPONENTS.map((symbol): SeriesPlan => ({ symbol, origin: "OANDA" })),
  { symbol: DXY, origin: "SYNTHETIC" },
];

function npmRun(args: string[]): void {
  const result = spawnSync("npm", ["run", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`npm run ${args.join(" ")} exited with status ${String(result.status)}`);
  }
}

function summarizeRange(range: MissingRange): Record<string, unknown> {
  return { from: range.from.toISOString(), to: range.to.toISOString(), minutes: range.minutes };
}

function totalMinutes(ranges: readonly MissingRange[]): number {
  return ranges.reduce((sum, range) => sum + range.minutes, 0);
}

function envelope(ranges: readonly MissingRange[]): { from: Date; to: Date } | null {
  if (ranges.length === 0) return null;
  return {
    from: new Date(Math.min(...ranges.map((range) => range.from.getTime()))),
    to: new Date(Math.max(...ranges.map((range) => range.to.getTime()))),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const apply = argv.includes("--apply");
  const lookbackDays = Number(flag("--lookback-days") ?? "7");
  const minMissingMinutes = Number(flag("--min-gap-minutes") ?? "5");
  const tailGraceMinutes = Number(flag("--tail-grace-minutes") ?? "30");
  const maxChunkMinutes = Number(flag("--max-chunk-minutes") ?? "4000");

  if (![lookbackDays, minMissingMinutes, tailGraceMinutes, maxChunkMinutes].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("--lookback-days, --min-gap-minutes, --tail-grace-minutes and --max-chunk-minutes must be positive numbers.");
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const scan = (plan: SeriesPlan): Promise<MissingRange[]> => scanOandaGaps(database, {
      symbol: plan.symbol,
      lookbackDays,
      minMissingMinutes,
      tailGraceMinutes,
    });

    const before = new Map<string, MissingRange[]>();
    for (const plan of SERIES) before.set(plan.symbol, await scan(plan));

    if ([...before.values()].every((ranges) => ranges.length === 0)) {
      console.info(JSON.stringify({ level: "info", message: "OANDA gap heal: nothing to do", mode: apply ? "apply" : "dry-run", lookbackDays }));
      return;
    }

    if (!apply) {
      console.info(JSON.stringify({
        level: "info",
        message: "OANDA gap heal plan (dry-run -- pass --apply to backfill)",
        mode: "dry-run",
        lookbackDays,
        missingRanges: Object.fromEntries(
          [...before.entries()].filter(([, ranges]) => ranges.length > 0).map(([symbol, ranges]) => [symbol, ranges.map(summarizeRange)]),
        ),
      }, null, 2));
      return;
    }

    if (!process.env.OANDA_ACCESS_TOKEN) {
      throw new Error("OANDA_ACCESS_TOKEN is not set; cannot fetch the missing OANDA bars.");
    }

    const failures: string[] = [];
    const attempt = (label: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(JSON.stringify({ level: "error", message: "Heal step failed; continuing", step: label }));
      }
    };

    // 1. Fetch what OANDA has for gold and the six FX legs.
    for (const plan of SERIES.filter((candidate) => candidate.origin === "OANDA")) {
      for (const range of before.get(plan.symbol) ?? []) {
        for (const chunk of chunkMissingRange(range, maxChunkMinutes)) {
          console.info(JSON.stringify({ level: "info", message: "Fetching missing 1m bars", symbol: plan.symbol, ...summarizeRange(chunk) }));
          attempt(`fetch ${plan.symbol} ${chunk.from.toISOString()}`, () => npmRun([
            "data:collect:historical", "--workspace", "@ai-quant-lab/api", "--",
            "--provider", "oanda", "--exchange", "OANDA", "--instrument", plan.symbol, "--timeframe", "1m",
            "--from", chunk.from.toISOString(),
            "--to", new Date(chunk.to.getTime() + MINUTE_MS).toISOString(),
            "--skip-existing",
          ]));
        }
      }
    }

    const after = new Map<string, MissingRange[]>();
    for (const plan of SERIES.filter((candidate) => candidate.origin === "OANDA")) after.set(plan.symbol, await scan(plan));
    const healedMinutes = (symbol: string): number => totalMinutes(before.get(symbol) ?? []) - totalMinutes(after.get(symbol) ?? []);
    const margin = HIGHER_TIMEFRAME_MARGIN_MINUTES * MINUTE_MS;

    // 2. Gold: derive higher timeframes and recompute indicators over the healed window.
    const goldWindow = envelope(before.get(GOLD) ?? []);
    if (goldWindow && healedMinutes(GOLD) > 0) {
      attempt("derive XAU_USD 5m/15m", () => npmRun([
        "data:derive:higher-timeframes", "--workspace", "@ai-quant-lab/api", "--",
        "--exchange", "OANDA", "--instrument", GOLD, "--timeframes", "5,15",
        "--from", new Date(goldWindow.from.getTime() - margin).toISOString(),
        "--to", new Date(Math.min(goldWindow.to.getTime() + margin, Date.now())).toISOString(),
      ]));
      for (const timeframe of ["1m", "5m", "15m"]) {
        attempt(`indicators XAU_USD ${timeframe}`, () => npmRun([
          "analysis:calculate-indicators", "--workspace", "@ai-quant-lab/api", "--",
          "--exchange", "OANDA", "--instrument", GOLD, "--timeframe", timeframe,
          "--from", goldWindow.from.toISOString(),
        ]));
      }
    }

    // 3. DXY: rebuild wherever a leg healed or DXY itself is missing, then recompute its indicators.
    const dxyWindows: MissingRange[] = [...(before.get(DXY) ?? [])];
    for (const symbol of FX_COMPONENTS) {
      if (healedMinutes(symbol) > 0) dxyWindows.push(...(before.get(symbol) ?? []));
    }
    const dxyWindow = envelope(dxyWindows);
    const dxyPlan = SERIES.find((plan) => plan.symbol === DXY)!;
    let dxyHealed = 0;
    if (dxyWindow) {
      attempt("rebuild DXY", () => npmRun([
        "data:compute:synthetic-dxy", "--workspace", "@ai-quant-lab/api", "--",
        "--from", new Date(dxyWindow.from.getTime() - margin).toISOString(),
        "--to", new Date(Math.min(dxyWindow.to.getTime() + margin, Date.now())).toISOString(),
      ]));
      const dxyAfter = await scan(dxyPlan);
      after.set(DXY, dxyAfter);
      dxyHealed = totalMinutes(before.get(DXY) ?? []) - totalMinutes(dxyAfter);
      if (dxyHealed > 0) {
        for (const timeframe of ["1m", "5m", "15m"]) {
          attempt(`indicators DXY ${timeframe}`, () => npmRun([
            "analysis:calculate-indicators", "--workspace", "@ai-quant-lab/api", "--",
            "--exchange", "OANDA", "--instrument", DXY, "--timeframe", timeframe,
            "--from", dxyWindow.from.toISOString(),
          ]));
        }
      }
    } else {
      after.set(DXY, before.get(DXY) ?? []);
    }

    const bySeries = Object.fromEntries(SERIES.map((plan) => {
      const stillMissing = after.get(plan.symbol) ?? [];
      return [plan.symbol, {
        missingMinutesBefore: totalMinutes(before.get(plan.symbol) ?? []),
        healedMinutes: plan.symbol === DXY ? dxyHealed : healedMinutes(plan.symbol),
        // Ranges the provider returned no bars for (or, for DXY, a leg is still missing); retried next run.
        stillMissing: stillMissing.map(summarizeRange),
      }];
    }));
    const anyStillMissing = [...after.values()].some((ranges) => ranges.length > 0);

    console.info(JSON.stringify({
      level: anyStillMissing || failures.length > 0 ? "warn" : "info",
      message: "OANDA gap heal complete",
      mode: "apply",
      lookbackDays,
      series: bySeries,
      failures,
    }, null, 2));

    if (failures.length > 0) {
      throw new Error(`${failures.length} heal step(s) failed: ${failures.join("; ")}`);
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("OANDA gap heal failed:", error);
  process.exitCode = 1;
});
