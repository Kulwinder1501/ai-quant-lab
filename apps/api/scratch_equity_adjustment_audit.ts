/**
 * Corporate-action audit for candidate NSE equities, run before seeding any of them.
 *
 * The historical provider reads Yahoo's raw `close`, never `adjclose`. On the three
 * instruments seeded so far that distinction is meaningless -- indices have no splits
 * and pay no dividends -- but an equity series carries both, and either one forges a
 * price move that never happened:
 *
 *   - An unadjusted 1:5 split prints as a -80% day. At a 50bps neutral band that is
 *     labelled BEARISH, and the model learns a corporate action as a market signal.
 *   - An ex-dividend date prints as a drop of roughly the dividend. Smaller, but a 1%
 *     yield paid once a year is still a 100bps fake BEARISH label per stock per year.
 *
 * So this measures rather than assumes. A split-adjusted series shows no daily move
 * anywhere near +/-40%; an unadjusted one shows exactly one such move per split. The
 * close-vs-adjclose comparison separately reveals whether dividends are folded in.
 */
import yahooFinance from "yahoo-finance2";
import { resolveYahooSymbol } from "./src/modules/market-data/domain/yahoo-symbol-resolver.js";

const CANDIDATES = [
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK",
  "HINDUNILVR", "ITC", "SBIN", "BHARTIARTL", "KOTAKBANK",
  "LT", "AXISBANK", "ASIANPAINT", "MARUTI", "TITAN",
  "SUNPHARMA", "ULTRACEMCO", "WIPRO", "NESTLEIND", "BAJFINANCE",
];

const FROM = new Date("2023-01-01");
const TO = new Date();

interface Row { date: Date; close: number; adjclose?: number }

async function audit(symbol: string): Promise<void> {
  const yfSymbol = resolveYahooSymbol(symbol);
  const yf = new (yahooFinance as any)({ suppressNotices: ["ripHistorical"] });

  let quotes: any[];
  try {
    const result = await yf.chart(yfSymbol, { period1: FROM, period2: TO, interval: "1d" });
    quotes = result.quotes ?? [];
  } catch (error) {
    console.log(`${symbol.padEnd(12)} FETCH FAILED  ${(error as Error).message.slice(0, 60)}`);
    return;
  }

  const rows: Row[] = quotes
    .filter((q) => typeof q.close === "number" && Number.isFinite(q.close) && q.close > 0)
    .map((q) => ({ date: new Date(q.date), close: q.close, adjclose: q.adjclose }));

  if (rows.length < 2) {
    console.log(`${symbol.padEnd(12)} NO DATA (${rows.length} rows)`);
    return;
  }

  let maxMovePct = 0;
  let maxMoveDate = "";
  let extremeDays = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const movePct = ((rows[i].close - rows[i - 1].close) / rows[i - 1].close) * 100;
    if (Math.abs(movePct) > Math.abs(maxMovePct)) {
      maxMovePct = movePct;
      maxMoveDate = rows[i].date.toISOString().slice(0, 10);
    }
    if (Math.abs(movePct) > 20) extremeDays += 1;
  }

  // If close and adjclose diverge on old rows but converge on recent ones, the series
  // carries dividend (and/or split) adjustments that `close` alone does not reflect.
  const first = rows[0];
  const last = rows[rows.length - 1];
  const firstGapPct = first.adjclose ? ((first.close - first.adjclose) / first.close) * 100 : Number.NaN;
  const lastGapPct = last.adjclose ? ((last.close - last.adjclose) / last.close) * 100 : Number.NaN;

  console.log(
    `${symbol.padEnd(12)} rows=${String(rows.length).padStart(4)}  `
    + `${first.date.toISOString().slice(0, 10)}..${last.date.toISOString().slice(0, 10)}  `
    + `maxMove=${maxMovePct.toFixed(1).padStart(6)}% (${maxMoveDate})  `
    + `>20%days=${extremeDays}  `
    + `close-vs-adj: first=${Number.isNaN(firstGapPct) ? "n/a" : `${firstGapPct.toFixed(2)}%`} `
    + `last=${Number.isNaN(lastGapPct) ? "n/a" : `${lastGapPct.toFixed(2)}%`}`,
  );
}

async function main(): Promise<void> {
  console.log(`Auditing ${CANDIDATES.length} NSE equities, ${FROM.toISOString().slice(0, 10)} to today\n`);
  for (const symbol of CANDIDATES) {
    await audit(symbol);
  }
  console.log(
    "\nInterpretation:"
    + "\n  A >20% day is a split fingerprint unless real news explains it."
    + "\n  A non-zero close-vs-adj gap that shrinks toward the present means dividends"
    + "\n  are excluded from `close`, so ex-dividend days carry a fake negative return.",
  );
}

void main();
