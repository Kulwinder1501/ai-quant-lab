import { istSessionDate } from "../../../platform/calendar/trading-session.js";
import type { CausalCandle } from "./causal-pivot.js";

export interface SessionReferenceLevels {
  readonly sessionDate: string;
  readonly priorSessionDate: string;
  readonly pdh: number;
  readonly pdl: number;
  readonly pdc: number;
  readonly pdo: number;
  readonly eq: number;
}

export interface SessionSweepEvent {
  readonly barIndex: number;
  readonly barTime: Date;
  readonly levelType: "PDH" | "PDL";
  readonly levelPrice: number;
  readonly eventType: "SWEEP" | "ACCEPTANCE";
  readonly penetrationBps: number;
  readonly reclaimDistanceBps: number;
}

export interface SessionLevelsSnapshot {
  readonly levels: SessionReferenceLevels | null;
  readonly lastSweepEvent: SessionSweepEvent | null;
  readonly currentSessionHigh: number;
  readonly currentSessionLow: number;
  readonly currentSessionOpen: number;
  readonly currentSessionDate: string;
}

interface InternalSessionAcc {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  firstBarIndex: number;
  candleCount: number;
}

export class IctSessionLevelTracker {
  private activeLevels: SessionReferenceLevels | null = null;
  private currentAcc: InternalSessionAcc | null = null;
  private priorAcc: InternalSessionAcc | null = null;
  private lastSweep: SessionSweepEvent | null = null;

  processCandle(
    candles: readonly CausalCandle[],
    currentIndex: number
  ): SessionLevelsSnapshot {
    const current = candles[currentIndex];
    const barDate = istSessionDate(current.openTime);

    this.lastSweep = null;

    if (!this.currentAcc) {
      this.currentAcc = {
        date: barDate,
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        firstBarIndex: currentIndex,
        candleCount: 1,
      };
    } else if (this.currentAcc.date !== barDate) {
      this.priorAcc = { ...this.currentAcc };
      this.activeLevels = {
        sessionDate: barDate,
        priorSessionDate: this.priorAcc.date,
        pdh: this.priorAcc.high,
        pdl: this.priorAcc.low,
        pdc: this.priorAcc.close,
        pdo: this.priorAcc.open,
        eq: (this.priorAcc.high + this.priorAcc.low) / 2,
      };

      this.currentAcc = {
        date: barDate,
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        firstBarIndex: currentIndex,
        candleCount: 1,
      };
    } else {
      this.currentAcc.high = Math.max(this.currentAcc.high, current.high);
      this.currentAcc.low = Math.min(this.currentAcc.low, current.low);
      this.currentAcc.close = current.close;
      this.currentAcc.candleCount++;
    }

    if (this.activeLevels) {
      const { pdh, pdl } = this.activeLevels;

      if (current.high > pdh) {
        const penetrationBps = ((current.high - pdh) / pdh) * 10000;
        if (current.close <= pdh) {
          const reclaimDistanceBps = ((pdh - current.close) / pdh) * 10000;
          this.lastSweep = {
            barIndex: currentIndex,
            barTime: current.openTime,
            levelType: "PDH",
            levelPrice: pdh,
            eventType: "SWEEP",
            penetrationBps: Number(penetrationBps.toFixed(4)),
            reclaimDistanceBps: Number(reclaimDistanceBps.toFixed(4)),
          };
        } else {
          this.lastSweep = {
            barIndex: currentIndex,
            barTime: current.openTime,
            levelType: "PDH",
            levelPrice: pdh,
            eventType: "ACCEPTANCE",
            penetrationBps: Number(penetrationBps.toFixed(4)),
            reclaimDistanceBps: 0,
          };
        }
      } else if (current.low < pdl) {
        const penetrationBps = ((pdl - current.low) / pdl) * 10000;
        if (current.close >= pdl) {
          const reclaimDistanceBps = ((current.close - pdl) / pdl) * 10000;
          this.lastSweep = {
            barIndex: currentIndex,
            barTime: current.openTime,
            levelType: "PDL",
            levelPrice: pdl,
            eventType: "SWEEP",
            penetrationBps: Number(penetrationBps.toFixed(4)),
            reclaimDistanceBps: Number(reclaimDistanceBps.toFixed(4)),
          };
        } else {
          this.lastSweep = {
            barIndex: currentIndex,
            barTime: current.openTime,
            levelType: "PDL",
            levelPrice: pdl,
            eventType: "ACCEPTANCE",
            penetrationBps: Number(penetrationBps.toFixed(4)),
            reclaimDistanceBps: 0,
          };
        }
      }
    }

    return {
      levels: this.activeLevels,
      lastSweepEvent: this.lastSweep,
      currentSessionHigh: this.currentAcc.high,
      currentSessionLow: this.currentAcc.low,
      currentSessionOpen: this.currentAcc.open,
      currentSessionDate: this.currentAcc.date,
    };
  }
}

export function buildSessionReferenceLevelsMap(
  candles: readonly CausalCandle[]
): Map<string, SessionReferenceLevels> {
  const sessions = new Map<string, { open: number; high: number; low: number; close: number }>();
  for (const c of candles) {
    const d = istSessionDate(c.openTime);
    const existing = sessions.get(d);
    if (!existing) {
      sessions.set(d, { open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
    }
  }

  const sortedDates = Array.from(sessions.keys()).sort();
  const result = new Map<string, SessionReferenceLevels>();

  for (let i = 1; i < sortedDates.length; i++) {
    const priorDate = sortedDates[i - 1];
    const curDate = sortedDates[i];
    const prior = sessions.get(priorDate)!;
    result.set(curDate, {
      sessionDate: curDate,
      priorSessionDate: priorDate,
      pdh: prior.high,
      pdl: prior.low,
      pdc: prior.close,
      pdo: prior.open,
      eq: (prior.high + prior.low) / 2,
    });
  }

  return result;
}
