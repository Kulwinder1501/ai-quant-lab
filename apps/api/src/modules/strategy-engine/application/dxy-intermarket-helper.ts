import type { Pool } from "pg";
import type { TradeSide } from "../domain/strategy.js";

export type DxyGateStatus = "CONFLUENT" | "CONTRADICTORY" | "NEUTRAL" | "UNAVAILABLE" | "STALE" | "INVALID";
export type DxyRefusalReason = "DXY_MISALIGNMENT" | "DXY_NO_CONFIRMATION" | "DXY_UNAVAILABLE" | "DXY_STALE" | "DXY_INVALID";

export interface DxyGateDecision {
  status: DxyGateStatus;
  eligible: boolean;
  refusalReason?: DxyRefusalReason;
  direction: "LONG" | "SHORT";
  evaluationInstant: string;
  candleTime: string;
  availableAt: string;
  syntheticDxy?: number;
  structuralTrend?: "BULLISH" | "BEARISH" | "NEUTRAL";
  volatilityState?: "EXPANDING" | "NOT_EXPANDING";
  componentCoverage: { instrument: string; candleTime: string; complete: boolean }[];
  calculationVersion: string;
}

export interface BuildDxyInputsOptions {
  proposalSide: TradeSide;
  proposalTimeframe: "5m" | "15m";
  candidateAt: string;
  dataCutoff: string;
  decisionAt: string;
}

interface DbCandleRow {
  instrument_id: string;
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  is_complete: boolean;
}

const COMPONENTS = [
  "EUR_USD",
  "USD_JPY",
  "GBP_USD",
  "USD_CAD",
  "USD_SEK",
  "USD_CHF"
] as const;

function calculateSyntheticDxy(
  eur: number,
  jpy: number,
  gbp: number,
  cad: number,
  sek: number,
  chf: number
): number {
  return 50.14348112 *
    Math.pow(eur, -0.576) *
    Math.pow(jpy, 0.136) *
    Math.pow(gbp, -0.119) *
    Math.pow(cad, 0.091) *
    Math.pow(sek, 0.042) *
    Math.pow(chf, 0.036);
}

export async function buildAndEvaluateDxyIntermarket(
  db: Pool,
  options: BuildDxyInputsOptions
): Promise<DxyGateDecision> {
  const { proposalSide, proposalTimeframe, dataCutoff, decisionAt } = options;
  const version = "synth-dxy-ice-v1";
  
  const fail = (
    status: DxyGateStatus, 
    refusal: DxyRefusalReason, 
    coverage: any[] = []
  ): DxyGateDecision => ({
    status,
    eligible: false,
    refusalReason: refusal,
    direction: proposalSide,
    evaluationInstant: decisionAt,
    candleTime: "",
    availableAt: "",
    componentCoverage: coverage,
    calculationVersion: version
  });

  // 1. Get instrument IDs for OANDA components
  const instRes = await db.query<{ id: string; symbol: string }>(
    `SELECT id, symbol FROM instruments WHERE exchange = 'OANDA' AND symbol = ANY($1)`,
    [COMPONENTS]
  );
  
  if (instRes.rows.length !== COMPONENTS.length) {
    return fail("UNAVAILABLE", "DXY_UNAVAILABLE");
  }
  
  const idToSymbol = new Map(instRes.rows.map(r => [r.id, r.symbol]));
  const ids = instRes.rows.map(r => r.id);

  // 2. Fetch recent 15m candles (Approx 40 days = 3840 candles)
  // Ensure we only look at candles that closed <= dataCutoff (strictly no look-ahead)
  const candlesRes = await db.query<DbCandleRow>(
    `SELECT instrument_id, open_time, close_time, open, high, low, close, is_complete
     FROM candles
     WHERE instrument_id = ANY($1) AND timeframe = '15m' AND close_time <= $2
     ORDER BY close_time DESC LIMIT 30000`,
    [ids, dataCutoff]
  );

  // Group by open_time
  const candlesByTime = new Map<number, Record<string, DbCandleRow>>();
  for (const row of candlesRes.rows) {
    const timeMs = row.open_time.getTime();
    if (!candlesByTime.has(timeMs)) candlesByTime.set(timeMs, {});
    candlesByTime.get(timeMs)![idToSymbol.get(row.instrument_id)!] = row;
  }

  // Sort times ascending
  const times = Array.from(candlesByTime.keys()).sort((a, b) => a - b);
  
  if (times.length === 0) {
    return fail("UNAVAILABLE", "DXY_UNAVAILABLE");
  }

  // Build synchronous DXY series
  const dxySeries: { time: number; closeTime: number; close: number; open: number; high: number; low: number; complete: boolean }[] = [];
  
  // Track coverage for the most recent evaluated candle
  const latestCoverage: { instrument: string; candleTime: string; complete: boolean }[] = [];

  for (const t of times) {
    const group = candlesByTime.get(t)!;
    let hasAll = true;
    let allComplete = true;
    let maxCloseTime = 0;
    
    for (const sym of COMPONENTS) {
      if (!group[sym]) {
        hasAll = false;
        break;
      }
      if (!group[sym].is_complete) {
        allComplete = false;
      }
      maxCloseTime = Math.max(maxCloseTime, group[sym].close_time.getTime());
    }
    
    if (t === times[times.length - 1]) {
      for (const sym of COMPONENTS) {
        latestCoverage.push({
          instrument: sym,
          candleTime: new Date(t).toISOString(),
          complete: group[sym]?.is_complete ?? false
        });
      }
    }

    if (!hasAll) continue;

    // Use strictly midpoint M15 close (which is what `close` is when using OANDA generic candles without specific bid/ask selection in the old pipeline)
    const o = calculateSyntheticDxy(
      Number(group.EUR_USD.open), Number(group.USD_JPY.open), Number(group.GBP_USD.open), 
      Number(group.USD_CAD.open), Number(group.USD_SEK.open), Number(group.USD_CHF.open)
    );
    const h = calculateSyntheticDxy(
      Number(group.EUR_USD.high), Number(group.USD_JPY.high), Number(group.GBP_USD.high), 
      Number(group.USD_CAD.high), Number(group.USD_SEK.high), Number(group.USD_CHF.high)
    );
    const l = calculateSyntheticDxy(
      Number(group.EUR_USD.low), Number(group.USD_JPY.low), Number(group.GBP_USD.low), 
      Number(group.USD_CAD.low), Number(group.USD_SEK.low), Number(group.USD_CHF.low)
    );
    const c = calculateSyntheticDxy(
      Number(group.EUR_USD.close), Number(group.USD_JPY.close), Number(group.GBP_USD.close), 
      Number(group.USD_CAD.close), Number(group.USD_SEK.close), Number(group.USD_CHF.close)
    );
    
    dxySeries.push({
      time: t,
      closeTime: maxCloseTime,
      open: o, high: Math.max(o, h, l, c), low: Math.min(o, h, l, c), close: c,
      complete: allComplete
    });
  }

  if (dxySeries.length === 0) {
    return fail("UNAVAILABLE", "DXY_UNAVAILABLE", latestCoverage);
  }

  const currentDxy = dxySeries[dxySeries.length - 1];
  
  if (!currentDxy.complete) {
    return fail("STALE", "DXY_STALE", latestCoverage);
  }
  
  if (currentDxy.closeTime > new Date(decisionAt).getTime()) {
     // Strict temporal invariant: availableAt <= evaluationInstant
     return fail("INVALID", "DXY_INVALID", latestCoverage);
  }
  
  // 3. Calculate 50 SMA (Structural Trend)
  const closes = dxySeries.map(d => d.close);
  let trend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (closes.length >= 50) {
    const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    if (currentDxy.close > sma50) trend = "BULLISH";
    else if (currentDxy.close < sma50) trend = "BEARISH";
  } else {
    return fail("INVALID", "DXY_INVALID", latestCoverage); 
  }
  
  // 4. Calculate Rolling 20-day Yang-Zhang Volatility 
  const dailyBars = new Map<string, { o: number; h: number; l: number; c: number }>();
  for (const d of dxySeries) {
    const dateStr = new Date(d.time).toISOString().split("T")[0];
    if (!dailyBars.has(dateStr)) {
      dailyBars.set(dateStr, { o: d.open, h: d.high, l: d.low, c: d.close });
    } else {
      const b = dailyBars.get(dateStr)!;
      b.h = Math.max(b.h, d.high);
      b.l = Math.min(b.l, d.low);
      b.c = d.close;
    }
  }
  
  const dailyArr = Array.from(dailyBars.values());
  let volatilityState: "EXPANDING" | "NOT_EXPANDING" = "NOT_EXPANDING";
  
  if (dailyArr.length > 21) {
    const N = 20;
    const yzVols: number[] = [];
    
    for (let endIdx = 20; endIdx < dailyArr.length; endIdx++) {
      const window = dailyArr.slice(endIdx - 20, endIdx + 1);
      const oVars: number[] = [];
      const cVars: number[] = [];
      const rsVars: number[] = [];
      for (let i = 1; i <= 20; i++) {
        const today = window[i];
        const prev = window[i-1];
        oVars.push(Math.pow(Math.log(today.o / prev.c), 2));
        cVars.push(Math.pow(Math.log(today.c / today.o), 2));
        rsVars.push(Math.log(today.h / today.o) * Math.log(today.h / today.c) + Math.log(today.l / today.o) * Math.log(today.l / today.c));
      }
      const oVarN = oVars.reduce((a, b) => a + b, 0) / N;
      const cVarN = cVars.reduce((a, b) => a + b, 0) / N;
      const rsVarN = rsVars.reduce((a, b) => a + b, 0) / N;
      const k = 0.34 / (1.34 + (N + 1) / (N - 1));
      yzVols.push(Math.sqrt(oVarN + k * cVarN + (1 - k) * rsVarN));
    }
    
    if (yzVols.length > 0) {
      const currentYz = yzVols[yzVols.length - 1];
      const prevYzVols = yzVols.slice(0, -1);
      if (prevYzVols.length > 0) {
         const sorted = [...prevYzVols].sort((a, b) => a - b);
         const mid = Math.floor(sorted.length / 2);
         const medianYz = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;
         if (currentYz > medianYz) {
            volatilityState = "EXPANDING";
         }
      } else {
         volatilityState = "EXPANDING";
      }
    }
  }

  let status: DxyGateStatus = "NEUTRAL";
  let refusalReason: DxyRefusalReason | undefined = "DXY_NO_CONFIRMATION";
  
  if (volatilityState !== "EXPANDING") {
    status = "NEUTRAL";
    refusalReason = "DXY_NO_CONFIRMATION";
  } else {
    if (proposalSide === "LONG") {
      if (trend === "BEARISH") {
        status = "CONFLUENT";
        refusalReason = undefined;
      } else {
        status = "CONTRADICTORY";
        refusalReason = "DXY_MISALIGNMENT";
      }
    } else if (proposalSide === "SHORT") {
      if (trend === "BULLISH") {
        status = "CONFLUENT";
        refusalReason = undefined;
      } else {
        status = "CONTRADICTORY";
        refusalReason = "DXY_MISALIGNMENT";
      }
    }
  }

  return {
    status,
    eligible: status === "CONFLUENT",
    refusalReason,
    direction: proposalSide,
    evaluationInstant: decisionAt,
    candleTime: new Date(currentDxy.time).toISOString(),
    availableAt: new Date(currentDxy.closeTime).toISOString(),
    syntheticDxy: currentDxy.close,
    structuralTrend: trend,
    volatilityState: volatilityState,
    componentCoverage: latestCoverage,
    calculationVersion: version
  };
}
