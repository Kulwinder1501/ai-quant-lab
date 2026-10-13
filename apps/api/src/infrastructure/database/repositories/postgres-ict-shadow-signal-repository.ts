import type { Pool } from "pg";
import type { IctShadowSignal } from "../../../modules/strategy-engine/domain/ict-shadow-variant.js";
import type { ShadowResolution } from "../../../modules/strategy-engine/domain/ict-shadow-resolution.js";
import { ictShadowResolverVersion } from "../../../modules/strategy-engine/domain/ict-shadow-resolution.js";

export interface NewIctShadowSignal extends IctShadowSignal {
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly sourceCandleId: string;
  readonly barCloseTime: Date;
}

export interface UnresolvedIctShadowSignal {
  readonly id: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly side: "LONG" | "SHORT";
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly barCloseTime: Date;
}

export interface IctShadowSummaryRow {
  readonly variant: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly biasAligned: boolean;
  readonly signals: number;
  readonly settled: number;
  readonly targets: number;
  readonly stops: number;
  readonly sessionEnds: number;
  readonly unmeasurable: number;
  readonly meanR: number | null;
}

/** Append-and-settle store for `ict_shadow_signals`. It holds no account and opens nothing. */
export class PostgresIctShadowSignalRepository {
  constructor(private readonly database: Pick<Pool, "query">) {}

  /** Returns false when the signal was already recorded for this bar. */
  async insert(signal: NewIctShadowSignal): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO ict_shadow_signals (
         variant, instrument_id, timeframe, source_candle_id, bar_close_time, side,
         entry_price, stop_loss, target_price, risk_reward, setup_id,
         bias, htf_bias, bias_aligned, htf_aligned, live_would_fire, details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT ON CONSTRAINT ict_shadow_signals_one_per_bar DO NOTHING`,
      [
        signal.variant, signal.instrumentId, signal.timeframe, signal.sourceCandleId, signal.barCloseTime, signal.side,
        signal.entryPrice, signal.stopLoss, signal.targetPrice, signal.riskReward, signal.setupId,
        signal.bias, signal.htfBias, signal.biasAligned, signal.htfAligned, signal.liveWouldFire,
        JSON.stringify(signal.details),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listUnresolved(limit: number): Promise<UnresolvedIctShadowSignal[]> {
    const result = await this.database.query(
      `SELECT s.id, s.instrument_id, i.symbol, s.side, s.entry_price, s.stop_loss, s.target_price, s.bar_close_time
         FROM ict_shadow_signals s JOIN instruments i ON i.id = s.instrument_id
        WHERE s.outcome IS NULL
        ORDER BY s.bar_close_time ASC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      instrumentId: String(row.instrument_id),
      symbol: String(row.symbol),
      side: row.side as "LONG" | "SHORT",
      entryPrice: Number(row.entry_price),
      stopLoss: Number(row.stop_loss),
      targetPrice: Number(row.target_price),
      barCloseTime: row.bar_close_time as Date,
    }));
  }

  /** Writes a final resolution. A row that already has an outcome is never rewritten. */
  async recordResolution(id: string, resolution: ShadowResolution, resolvedAt: Date): Promise<boolean> {
    if (resolution.status === "RESOLVED") {
      const result = await this.database.query(
        `UPDATE ict_shadow_signals
            SET outcome = $2, r_multiple = $3, mae_r = $4, mfe_r = $5, minutes_to_resolution = $6,
                resolved_at = $7, resolver_version = $8
          WHERE id = $1 AND outcome IS NULL`,
        [id, resolution.outcome, resolution.rMultiple, resolution.maeR, resolution.mfeR,
          resolution.minutesToResolution, resolution.resolvedAt, ictShadowResolverVersion],
      );
      return (result.rowCount ?? 0) > 0;
    }
    if (resolution.status === "UNMEASURABLE") {
      const result = await this.database.query(
        `UPDATE ict_shadow_signals
            SET outcome = 'UNMEASURABLE', resolved_at = $2, resolver_version = $3,
                details = details || jsonb_build_object('unmeasurableReason', $4::text)
          WHERE id = $1 AND outcome IS NULL`,
        [id, resolvedAt, ictShadowResolverVersion, resolution.reason],
      );
      return (result.rowCount ?? 0) > 0;
    }
    return false;
  }

  /** The 1m bars for one instrument from `from` onward. Complete bars only. */
  async loadOneMinuteBars(instrumentId: string, from: Date, to: Date): Promise<Array<{
    id: string; openTime: Date; closeTime: Date; open: number; high: number; low: number; close: number;
  }>> {
    const result = await this.database.query(
      `SELECT id, open_time, close_time, open, high, low, close
         FROM candles
        WHERE instrument_id = $1 AND timeframe = '1m' AND is_complete = TRUE
          AND open_time >= $2 AND open_time < $3
        ORDER BY open_time ASC`,
      [instrumentId, from, to],
    );
    return result.rows.map((row) => ({
      id: String(row.id), openTime: row.open_time as Date, closeTime: row.close_time as Date,
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    }));
  }

  async summarise(): Promise<IctShadowSummaryRow[]> {
    const result = await this.database.query(
      `SELECT s.variant, i.symbol, s.timeframe, s.bias_aligned,
              COUNT(*) AS signals,
              COUNT(*) FILTER (WHERE s.outcome IN ('TARGET','STOP','SESSION_END')) AS settled,
              COUNT(*) FILTER (WHERE s.outcome = 'TARGET') AS targets,
              COUNT(*) FILTER (WHERE s.outcome = 'STOP') AS stops,
              COUNT(*) FILTER (WHERE s.outcome = 'SESSION_END') AS session_ends,
              COUNT(*) FILTER (WHERE s.outcome = 'UNMEASURABLE') AS unmeasurable,
              AVG(s.r_multiple) FILTER (WHERE s.outcome IN ('TARGET','STOP','SESSION_END')) AS mean_r
         FROM ict_shadow_signals s JOIN instruments i ON i.id = s.instrument_id
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3, 4`,
    );
    return result.rows.map((row) => ({
      variant: String(row.variant),
      symbol: String(row.symbol),
      timeframe: String(row.timeframe),
      biasAligned: Boolean(row.bias_aligned),
      signals: Number(row.signals),
      settled: Number(row.settled),
      targets: Number(row.targets),
      stops: Number(row.stops),
      sessionEnds: Number(row.session_ends),
      unmeasurable: Number(row.unmeasurable),
      meanR: row.mean_r === null ? null : Number(row.mean_r),
    }));
  }
}
