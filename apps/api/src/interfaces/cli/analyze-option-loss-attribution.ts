import { parseArgs } from "node:util";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import type { OptionType } from "../../modules/market-data/domain/option-chain.js";
import { yearsToExpiry, priceEuropeanOption, RISK_FREE_RATE } from "@ai-quant-lab/pricing";
import { computeOptionLossAttribution, MAX_RESEARCH_MARK_DELAY_MS } from "../../modules/paper-trading/domain/option-loss-attribution.js";

function bsPrice(spot: number, strike: number, iv: number, tte: number, type: OptionType): number {
  return priceEuropeanOption({ spot, strike, volatility: iv, timeToExpiryYears: tte, riskFreeRate: RISK_FREE_RATE, optionType: type }).premium;
}

const env = loadEnvironment();
const pool = createDatabasePool(env.DATABASE_URL);

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  },
});

const accountArg = values.account;
const fromDate = values.from ? new Date(values.from) : null;
const toDate = values.to ? new Date(values.to) : null;

if (!accountArg) {
  console.error("Usage: npm run research:option:attribution -- --account <accountId_or_name> [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
  await pool.end();
  process.exit(1);
}

async function resolveAccount(arg: string): Promise<string> {
  const byId = await pool.query<{ id: string }>("SELECT id FROM paper_accounts WHERE id = $1 LIMIT 1", [arg]);
  if (byId.rows[0]) return byId.rows[0].id;
  const byName = await pool.query<{ id: string }>("SELECT id FROM paper_accounts WHERE name = $1 LIMIT 1", [arg]);
  if (byName.rows[0]) return byName.rows[0].id;
  console.error(`Paper account not found for '${arg}'.`);
  await pool.end();
  process.exit(1);
}

async function resolveUnderlyingAt(underlyingSymbol: string, cutoff: Date): Promise<number | null> {
  const tick = await pool.query<{ underlying_value: string }>(`
    SELECT opt.underlying_value FROM option_premium_ticks opt
    JOIN instruments oi ON oi.id = opt.instrument_id
    WHERE oi.underlying_symbol = $1 AND opt.underlying_value IS NOT NULL AND opt.underlying_value::numeric > 0 AND opt.received_at <= $2
    ORDER BY opt.received_at DESC, opt.id DESC LIMIT 1
  `, [underlyingSymbol, cutoff]);
  if (tick.rows[0]) return Number(tick.rows[0].underlying_value);

  const candle = await pool.query<{ close: string }>(`
    SELECT c.close FROM candles c JOIN instruments i ON i.id = c.instrument_id
    WHERE i.symbol = $1 AND c.timeframe = '5m' AND c.is_complete = TRUE AND c.close_time <= $2
    ORDER BY c.close_time DESC, c.id DESC LIMIT 1
  `, [underlyingSymbol, cutoff]);
  return candle.rows[0] ? Number(candle.rows[0].close) : null;
}

async function resolveIVAt(underlyingSymbol: string, strike: number, optionType: string, expiry: Date, cutoff: Date, spot: number | null): Promise<number | null> {
  if (spot === null || spot <= 0) return null;
  const r = await pool.query<{ bid: string | null; ask: string | null }>(`
    SELECT opt.bid, opt.ask FROM option_premium_ticks opt
    JOIN instruments oi ON oi.id = opt.instrument_id
    WHERE oi.underlying_symbol = $1 AND oi.strike_price = $2 AND oi.option_type = $3 AND oi.expiry_date::date = $4::date
      AND opt.received_at <= $5 AND opt.bid IS NOT NULL AND opt.ask IS NOT NULL
    ORDER BY opt.received_at DESC, opt.id DESC LIMIT 1
  `, [underlyingSymbol, strike, optionType, expiry.toISOString().slice(0, 10), cutoff]);
  if (!r.rows[0]) return null;
  const bid = Number(r.rows[0].bid), ask = Number(r.rows[0].ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= bid) return null;
  const mid = (bid + ask) / 2;
  const tte = yearsToExpiry(cutoff, expiry);
  if (tte <= 0) return null;
  let lo = 0.01, hi = 5.0;
  for (let i = 0; i < 50; i++) {
    const mv = (lo + hi) / 2;
    if (bsPrice(spot, strike, mv, tte, optionType as OptionType) < mid) lo = mv; else hi = mv;
    if (hi - lo < 1e-6) break;
  }
  const iv = (lo + hi) / 2;
  return Number.isFinite(iv) && iv > 0 ? iv : null;
}

async function lookupResearchMarks(instrumentId: string, openedAt: Date, closedAt: Date): Promise<{
  entryMark: { price: number; time: Date } | null;
  exitMark: { price: number; time: Date } | null;
}> {
  const windowEndEntry = new Date(openedAt.getTime() + MAX_RESEARCH_MARK_DELAY_MS);
  const entryRes = await pool.query<{ open: string; open_time: Date }>(`
    SELECT open, open_time FROM candles
    WHERE instrument_id = $1 AND timeframe = '1m' AND open_time >= $2 AND open_time < $3
    ORDER BY open_time ASC LIMIT 1
  `, [instrumentId, openedAt, windowEndEntry]);

  const windowEndExit = new Date(closedAt.getTime() + MAX_RESEARCH_MARK_DELAY_MS);
  const exitRes = await pool.query<{ close: string; close_time: Date }>(`
    SELECT close, close_time FROM candles
    WHERE instrument_id = $1 AND timeframe = '1m' AND close_time >= $2 AND close_time < $3
    ORDER BY close_time ASC LIMIT 1
  `, [instrumentId, closedAt, windowEndExit]);

  return {
    entryMark: entryRes.rows[0] ? { price: Number(entryRes.rows[0].open), time: entryRes.rows[0].open_time } : null,
    exitMark: exitRes.rows[0] ? { price: Number(exitRes.rows[0].close), time: exitRes.rows[0].close_time } : null,
  };
}

async function run() {
  const accountId = await resolveAccount(accountArg!);

  const whereClause = ["pt.account_id = $1", "pt.status = 'CLOSED'", "pt.option_type IS NOT NULL"];
  const params: unknown[] = [accountId];
  if (fromDate) { params.push(fromDate); whereClause.push(`pt.closed_at >= $${params.length}::timestamptz`); }
  if (toDate) { params.push(toDate); whereClause.push(`pt.closed_at < $${params.length}::timestamptz`); }

  const rows = await pool.query<{
    id: string; account_id: string; strategy_key: string | null; side: string;
    entry_price: string; exit_price: string; exit_reason: string;
    opened_at: Date; closed_at: Date; quantity: number; instrument_id: string;
    option_type: string; option_strike: string; option_expiry: Date;
    entry_iv: string | null; exit_fees: string; entry_fees: string;
    underlying_symbol: string; fee_breakdown: Record<string, unknown> | null;
    underlying_entry_price: string | null; underlying_exit_price: string | null;
  }>(`
    SELECT pt.id, pt.account_id, pt.strategy_key, pt.side, pt.instrument_id,
           pt.entry_price, pt.exit_price, pt.exit_reason, pt.opened_at, pt.closed_at, pt.quantity,
           pt.option_type, pt.option_strike, pt.option_expiry, pt.entry_iv,
           pt.exit_fees, pt.entry_fees, i.underlying_symbol,
           pt.fee_breakdown, pt.underlying_entry_price, pt.underlying_exit_price
    FROM paper_trades pt JOIN instruments i ON i.id = pt.instrument_id
    WHERE ${whereClause.join(" AND ")} ORDER BY pt.closed_at ASC
  `, params);

  if (!rows.rows.length) {
    console.log(`No closed option trades found for ${accountArg}.`);
    await pool.end();
    process.exit(0);
  }

  console.log(`Analysing ${rows.rows.length} closed option trades for account: ${accountArg}\n`);

  let totGross = 0, totNet = 0, totUnder = 0, totTime = 0, totVola = 0;
  const byReason = new Map<string, { count: number; gross: number; net: number; completedCount: number }>();
  const fmt = (n: number | null, dp = 2) => n === null ? "N/A" : n.toFixed(dp);

  console.log("-".repeat(150));
  console.log(
    "TradeId".padEnd(38) + "ExitReason".padEnd(24) + "Status".padEnd(26) +
    "Underlying".padStart(12) + "Time".padStart(10) + "Vola".padStart(10) +
    "Residual".padStart(10) + "GrossPnL".padStart(12) + "NetPnL".padStart(12)
  );
  console.log("-".repeat(150));

  for (const row of rows.rows) {
    const K = Number(row.option_strike);
    const bsType = row.option_type as OptionType;
    const expiry = row.option_expiry;
    const openedAt = row.opened_at, closedAt = row.closed_at;
    const entryPrice = Number(row.entry_price), exitPrice = Number(row.exit_price);
    const quantity = row.quantity;
    const entryFees = Number(row.entry_fees), exitFees = Number(row.exit_fees);

    const ep = (row.fee_breakdown as Record<string, unknown> | null)?.entryProvenance as Record<string, unknown> | undefined;
    const entryIv = row.entry_iv ? Number(row.entry_iv) : ep?.IVAtEntry ? Number(ep.IVAtEntry) : null;

    const S0 = row.underlying_entry_price && Number(row.underlying_entry_price) > 0
      ? Number(row.underlying_entry_price)
      : await resolveUnderlyingAt(row.underlying_symbol, openedAt);
    const S1 = row.underlying_exit_price && Number(row.underlying_exit_price) > 0
      ? Number(row.underlying_exit_price)
      : await resolveUnderlyingAt(row.underlying_symbol, closedAt);
    const IV0 = entryIv && entryIv > 0 ? entryIv : null;
    const IV1 = await resolveIVAt(row.underlying_symbol, K, row.option_type, expiry, closedAt, S1);

    const { entryMark, exitMark } = await lookupResearchMarks(row.instrument_id, openedAt, closedAt);

    const attribution = computeOptionLossAttribution({
      side: row.side as "LONG" | "SHORT",
      quantity,
      optionType: bsType,
      optionStrike: K,
      optionExpiry: expiry,
      openedAt,
      closedAt,
      actualEntryPrice: entryPrice,
      actualExitPrice: exitPrice,
      entryFees,
      exitFees,
      underlyingEntryPrice: S0,
      underlyingExitPrice: S1,
      entryIv: IV0,
      exitIv: IV1,
      researchEntryOptionPrice: entryMark?.price ?? null,
      researchExitOptionPrice: exitMark?.price ?? null,
      researchEntryBarTime: entryMark?.time ?? null,
      researchExitBarTime: exitMark?.time ?? null,
    });

    totGross += attribution.realizedGrossPnL;
    totNet += attribution.realizedNetPnL;
    if (attribution.deltaPSpot !== null) totUnder += attribution.deltaPSpot;
    if (attribution.deltaPTime !== null) totTime += attribution.deltaPTime;
    if (attribution.deltaPVol !== null) totVola += attribution.deltaPVol;

    const b = byReason.get(row.exit_reason) ?? { count: 0, gross: 0, net: 0, completedCount: 0 };
    b.count++;
    b.gross += attribution.realizedGrossPnL;
    b.net += attribution.realizedNetPnL;
    if (attribution.attributionStatus === "COMPLETED") b.completedCount++;
    byReason.set(row.exit_reason, b);

    console.log(
      row.id.slice(0, 36).padEnd(38) +
      row.exit_reason.padEnd(24) +
      attribution.attributionStatus.padEnd(26) +
      fmt(attribution.deltaPSpot).padStart(12) +
      fmt(attribution.deltaPTime).padStart(10) +
      fmt(attribution.deltaPVol).padStart(10) +
      fmt(attribution.attributionResidual).padStart(10) +
      fmt(attribution.realizedGrossPnL).padStart(12) +
      fmt(attribution.realizedNetPnL).padStart(12)
    );
  }

  console.log("-".repeat(150));
  console.log(
    `TOTAL (${rows.rows.length})`.padEnd(88) +
    fmt(totUnder).padStart(12) +
    fmt(totTime).padStart(10) +
    fmt(totVola).padStart(10) +
    "".padStart(10) +
    fmt(totGross).padStart(12) +
    fmt(totNet).padStart(12)
  );

  console.log("\nExit-reason breakdown:");
  for (const [reason, b] of [...byReason.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `  ${reason.padEnd(30)} ${String(b.count).padStart(5)} trades ` +
      `(${String(b.completedCount).padStart(5)} completed) ` +
      `  Gross: ${fmt(b.gross).padStart(10)}   Net: ${fmt(b.net).padStart(10)}`
    );
  }

  await pool.end();
}

run().catch(async (err) => {
  console.error("Error running loss attribution:", err);
  await pool.end();
  process.exit(1);
});
