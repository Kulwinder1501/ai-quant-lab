import type { Pool } from "pg";
import type { TradeSide } from "../domain/strategy.js";
import {
  DxyIntermarketEvaluator,
  type DxyEvaluatorInputs,
  type DxyIntermarketPayload,
  type ConfirmedSwing,
  type Bar1m,
  type DxyStructure,
  type DxyLocation,
} from "../domain/dxy-intermarket-evaluator.js";
import { findConfirmedPivotAt, type CausalCandle } from "../../technical-analysis/domain/ict/causal-pivot.js";

export interface BuildDxyInputsOptions {
  proposalSide: TradeSide;
  proposalTimeframe: "5m" | "15m";
  candidateAt: string;
  dataCutoff: string;
  decisionAt: string;
}

interface DbCandleRow {
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

function computeEma(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = new Array(prices.length);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  result[period - 1] = sum / period;

  for (let i = period; i < prices.length; i++) {
    result[i] = prices[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function computeAtr14(candles: { high: number; low: number; close: number }[]): number {
  if (candles.length < 15) return 2.5; // Fallback
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
  }
  const last14 = trs.slice(-14);
  return last14.reduce((sum, v) => sum + v, 0) / last14.length;
}

function extractPivots(candles: DbCandleRow[], pivotLength = 2): ConfirmedSwing[] {
  const causalCandles: CausalCandle[] = candles.map((c, idx) => ({
    id: `bar-${idx}`,
    openTime: new Date(c.close_time), // Available at bar close
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));

  const swings: ConfirmedSwing[] = [];
  for (let i = pivotLength; i < causalCandles.length; i++) {
    const pair = findConfirmedPivotAt(causalCandles, i, pivotLength);
    if (pair.high) {
      swings.push({
        type: "HIGH",
        price: pair.high.price,
        swingAt: pair.high.time.toISOString(),
        confirmedAt: pair.high.confirmedAtTime.toISOString(),
      });
    }
    if (pair.low) {
      swings.push({
        type: "LOW",
        price: pair.low.price,
        swingAt: pair.low.time.toISOString(),
        confirmedAt: pair.low.confirmedAtTime.toISOString(),
      });
    }
  }
  return swings;
}

export async function buildAndEvaluateDxyIntermarket(
  db: Pool,
  options: BuildDxyInputsOptions
): Promise<DxyIntermarketPayload> {
  const { proposalSide, proposalTimeframe, candidateAt, dataCutoff, decisionAt } = options;

  // 1. Get instrument IDs
  const dxyInstRes = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE exchange = 'TWELVEDATA' AND symbol = 'DXY' LIMIT 1`
  );
  const xauInstRes = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE symbol IN ('XAU_USD', 'XAU/USD') LIMIT 1`
  );

  const dxyId = dxyInstRes.rows[0]?.id;
  const xauId = xauInstRes.rows[0]?.id;

  if (!dxyId || !xauId) {
    // Missing instruments -> fallback unavailable payload
    const evaluator = new DxyIntermarketEvaluator();
    return evaluator.evaluate({
      proposalSide,
      proposalTimeframe,
      candidateAt,
      dataCutoff,
      decisionAt,
    });
  }

  // 2. Fetch completed DXY candles <= dataCutoff
  const dxyCandlesRes = await db.query<DbCandleRow>(
    `SELECT open_time, close_time, open, high, low, close, volume
     FROM candles
     WHERE instrument_id = $1 AND timeframe = $2 AND close_time <= $3 AND is_complete = TRUE
     ORDER BY close_time ASC LIMIT 100`,
    [dxyId, proposalTimeframe, dataCutoff]
  );

  // 3. Fetch completed XAU candles <= dataCutoff
  const xauCandlesRes = await db.query<DbCandleRow>(
    `SELECT open_time, close_time, open, high, low, close, volume
     FROM candles
     WHERE instrument_id = $1 AND timeframe = $2 AND close_time <= $3 AND is_complete = TRUE
     ORDER BY close_time ASC LIMIT 100`,
    [xauId, proposalTimeframe, dataCutoff]
  );

  // 4. Fetch XAU 1m bars starting around decisionAt for outcome evaluation
  const xau1mRes = await db.query<DbCandleRow>(
    `SELECT open_time, close_time, open, high, low, close, volume
     FROM candles
     WHERE instrument_id = $1 AND timeframe = '1m' AND open_time >= $2
     ORDER BY open_time ASC LIMIT 30`,
    [xauId, decisionAt]
  );

  const dxyCandles = dxyCandlesRes.rows;
  const xauCandles = xauCandlesRes.rows;

  const dxyCloses = dxyCandles.map((c) => Number(c.close));
  const xauCloses = xauCandles.map((c) => Number(c.close));

  // Compute DXY EMA 20 & 50
  const ema20Arr = computeEma(dxyCloses, 20);
  const ema50Arr = computeEma(dxyCloses, 50);

  const latestDxyCandle = dxyCandles[dxyCandles.length - 1];
  const dxyCandleAvailableAt = latestDxyCandle ? new Date(latestDxyCandle.close_time).toISOString() : undefined;

  let dxyEma20Val: number | undefined = undefined;
  let dxyEma50Val: number | undefined = undefined;
  let dxyEma20Slope: number | undefined = undefined;

  if (ema20Arr.length > 0 && ema50Arr.length > 0) {
    const lastEma20 = ema20Arr[ema20Arr.length - 1];
    const prevEma20 = ema20Arr[ema20Arr.length - 2] ?? lastEma20;
    dxyEma20Val = lastEma20;
    dxyEma50Val = ema50Arr[ema50Arr.length - 1];
    dxyEma20Slope = lastEma20 - prevEma20;
  }

  // Compute DXY ROC3 & ROC5
  let dxyRoc3Val: number | undefined = undefined;
  let dxyRoc5Val: number | undefined = undefined;
  if (dxyCloses.length >= 6) {
    const curr = dxyCloses[dxyCloses.length - 1];
    const c3 = dxyCloses[dxyCloses.length - 4];
    const c5 = dxyCloses[dxyCloses.length - 6];
    if (c3 > 0) dxyRoc3Val = (curr - c3) / c3;
    if (c5 > 0) dxyRoc5Val = (curr - c5) / c5;
  }

  // Compute ATR14
  const xauAtr = computeAtr14(xauCandles.map((c) => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) })));
  const dxyAtr = computeAtr14(dxyCandles.map((c) => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) })));

  // Extract Swings
  const xauSwings = extractPivots(xauCandles, 2);
  const dxySwings = extractPivots(dxyCandles, 2);

  // Format 1m bars
  const xau1mBars: Bar1m[] = xau1mRes.rows.map((r) => ({
    openAt: new Date(r.open_time).toISOString(),
    closeAt: new Date(r.close_time).toISOString(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));

  const latestXauCandle = xauCandles[xauCandles.length - 1];
  const xauCandleAvailableAt = latestXauCandle ? new Date(latestXauCandle.close_time).toISOString() : undefined;

  const inputs: DxyEvaluatorInputs = {
    proposalSide,
    proposalTimeframe,
    candidateAt,
    dataCutoff,
    decisionAt,

    dxyCandleAvailableAt,
    dxyEma20: dxyEma20Val !== undefined && dxyCandleAvailableAt ? { value: dxyEma20Val, availableAt: dxyCandleAvailableAt } : undefined,
    dxyEma50: dxyEma50Val !== undefined && dxyCandleAvailableAt ? { value: dxyEma50Val, availableAt: dxyCandleAvailableAt } : undefined,
    dxyEma20Slope,
    dxyRoc3: dxyRoc3Val !== undefined && dxyCandleAvailableAt ? { value: dxyRoc3Val, availableAt: dxyCandleAvailableAt } : undefined,
    dxyRoc5: dxyRoc5Val !== undefined && dxyCandleAvailableAt ? { value: dxyRoc5Val, availableAt: dxyCandleAvailableAt } : undefined,

    dxyStructure: dxyCandleAvailableAt ? { event: "NONE", confirmedAt: dxyCandleAvailableAt } : undefined,
    dxyLocation: dxyCandleAvailableAt ? { location: "OPEN_SPACE", availableAt: dxyCandleAvailableAt } : undefined,

    xauCandleAvailableAt,
    xauATR14: xauCandleAvailableAt ? { value: xauAtr, availableAt: xauCandleAvailableAt } : undefined,
    dxyATR14: dxyCandleAvailableAt ? { value: dxyAtr, availableAt: dxyCandleAvailableAt } : undefined,

    xauSwings,
    dxySwings,

    xau1mBars,
  };

  const evaluator = new DxyIntermarketEvaluator();
  return evaluator.evaluate(inputs);
}
