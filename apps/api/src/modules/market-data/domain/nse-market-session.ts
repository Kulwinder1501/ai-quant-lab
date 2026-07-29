import type { HistoricalTimeframe } from "./historical-data-provider.js";

const istOffsetMs = 5.5 * 60 * 60_000;
const sessionOpenMinutes = 9 * 60 + 15;
const sessionCloseMinutes = 15 * 60 + 30;

export interface NseSessionWindow {
  opensAt: Date;
  closesAt: Date;
}

export interface CandleWindow extends NseSessionWindow {
  openTime: Date;
  closeTime: Date;
}

function localDateKey(value: Date): string {
  const ist = new Date(value.getTime() + istOffsetMs);
  return ist.toISOString().slice(0, 10);
}

function sessionWindow(value: Date): NseSessionWindow {
  const ist = new Date(value.getTime() + istOffsetMs);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();
  return {
    opensAt: new Date(Date.UTC(year, month, day, 3, 45)),
    closesAt: new Date(Date.UTC(year, month, day, 10, 0)),
  };
}

const intradayDurationMs: Partial<Record<HistoricalTimeframe, number>> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
};

/** NSE cash-session rules. Holiday exceptions are injected rather than guessed. */
export class NseMarketSession {
  private readonly holidays: Set<string>;

  constructor(holidays: Iterable<string> = []) {
    this.holidays = new Set(holidays);
  }

  getSession(value: Date): NseSessionWindow | null {
    const ist = new Date(value.getTime() + istOffsetMs);
    const weekday = ist.getUTCDay();
    if (weekday === 0 || weekday === 6 || this.holidays.has(localDateKey(value))) {
      return null;
    }
    return sessionWindow(value);
  }

  isOpen(value: Date): boolean {
    const session = this.getSession(value);
    return session !== null && value >= session.opensAt && value < session.closesAt;
  }

  candleWindow(value: Date, timeframe: HistoricalTimeframe): CandleWindow | null {
    const session = this.getSession(value);
    if (!session || value < session.opensAt || value >= session.closesAt) {
      return null;
    }
    if (timeframe === "1d") {
      return { ...session, openTime: session.opensAt, closeTime: session.closesAt };
    }
    const duration = intradayDurationMs[timeframe];
    if (!duration) {
      throw new Error(`Unsupported live timeframe ${timeframe}.`);
    }
    const elapsed = value.getTime() - session.opensAt.getTime();
    const openTime = new Date(session.opensAt.getTime() + Math.floor(elapsed / duration) * duration);
    const closeTime = new Date(Math.min(openTime.getTime() + duration, session.closesAt.getTime()));
    return { ...session, openTime, closeTime };
  }
}
