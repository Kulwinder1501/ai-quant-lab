/**
 * A LIVE, in-memory estimate of how much of today's futures volume traded at each price, split by which side of the
 * quote the last price sat on. Nothing here is stored: it is built from the ticks this process receives, so it starts
 * when the process starts and is gone when it stops. Pure apart from the clock the caller passes in.
 *
 * **This is an estimate, and every number is labelled as one.** The feed is a sampled snapshot (about 1.5 messages a
 * second per contract), not a trade tape. Measured on 2026-10-27: a message's last-traded quantity explains only
 * 15-38% of the volume that arrived between two messages, and 28-41% of volume arrived with the last price *inside*
 * the spread, where no side can be told. So:
 *
 * - Each volume advance between two messages is assigned, whole, to the later message's last price. When several
 *   trades happened in between, at several prices, this puts them all on one price.
 * - Its side is the quote of the SAME message: at or above the ask is "buy", at or below the bid is "sell", strictly
 *   between (or no two-sided quote) is "unknown". That is a rule with no ground truth, not a measurement of who
 *   initiated the trade. "Unknown" is reported as its own share, never folded into either side.
 * - Only advances that arrive in the regular session (09:15-15:30 IST) are counted. The volume counter is still
 *   followed outside it so the first in-session advance is not the whole pre-open volume.
 * - A counter that goes down (a reset, or a replayed message) is counted and skipped, never turned into negative volume.
 */

import { SESSION_CLOSE_MINUTE_IST, SESSION_OPEN_MINUTE_IST } from "./session-volume-profile.js";

/** The fields of a tick this needs; the live streamer's `Tick` satisfies it. */
export interface SideSplitTick {
  symbol: string;
  ltp: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
}

export type TradeSideGuess = "BUY" | "SELL" | "UNKNOWN";

/** The side of the quote the price sat on. UNKNOWN covers strictly inside the spread and a missing or crossed quote. */
export function guessSide(ltp: number, bid: number | null, ask: number | null): TradeSideGuess {
  if (bid === null || ask === null || !(bid > 0) || !(ask > 0) || ask < bid) return "UNKNOWN";
  if (ltp >= ask) return "BUY";
  if (ltp <= bid) return "SELL";
  return "UNKNOWN";
}

/** Futures tick size is 0.05, so a price is stored as a whole number of twentieths of a point. */
const PRICE_UNITS_PER_POINT = 20;
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

interface Cell {
  buy: number;
  sell: number;
  unknown: number;
}

interface SymbolState {
  /** The IST date this state belongs to; a new date starts it afresh. */
  date: string;
  previousVolume: number | null;
  cells: Map<number, Cell>;
  sinceMs: number | null;
  lastMs: number | null;
  messages: number;
  advances: number;
  counterResets: number;
}

export interface SideSplitRow {
  /** Inclusive lower edge, in index points. */
  low: number;
  /** Exclusive upper edge. */
  high: number;
  buy: number;
  sell: number;
  unknown: number;
}

export interface SideSplitSnapshot {
  symbol: string;
  rowPoints: number;
  /** Ascending by price. Only rows that hold volume. */
  rows: SideSplitRow[];
  totals: { buy: number; sell: number; unknown: number; total: number };
  /** unknown / total, or null with no volume. The part no side can be put on. */
  unknownShare: number | null;
  messages: number;
  advances: number;
  counterResets: number;
  /** When this process first counted volume for the symbol today, and the last time it did. ISO, or null. */
  since: string | null;
  last: string | null;
}

function istDateOf(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMinuteOfDay(ms: number): number {
  const local = (ms + IST_OFFSET_MS) % DAY_MS;
  return Math.floor(local / 60_000);
}

function inRegularSession(ms: number): boolean {
  const minute = istMinuteOfDay(ms);
  return minute >= SESSION_OPEN_MINUTE_IST && minute < SESSION_CLOSE_MINUTE_IST;
}

function freshState(date: string): SymbolState {
  return { date, previousVolume: null, cells: new Map(), sinceMs: null, lastMs: null, messages: 0, advances: 0, counterResets: 0 };
}

export class LiveSideSplit {
  private readonly states = new Map<string, SymbolState>();

  /** Records one tick. `receivedAt` is the receipt time in ms: the clock that says when *this process* heard the market. */
  record(tick: SideSplitTick, receivedAt: number = Date.now()): void {
    const volume = tick.volume;
    if (volume === null || !Number.isFinite(volume) || volume < 0) return;
    if (!Number.isFinite(tick.ltp) || tick.ltp <= 0) return;

    const date = istDateOf(receivedAt);
    let state = this.states.get(tick.symbol);
    if (!state || state.date !== date) {
      state = freshState(date);
      this.states.set(tick.symbol, state);
    }

    const previous = state.previousVolume;
    state.previousVolume = volume;
    if (previous === null) return;
    state.messages += 1;

    const advance = volume - previous;
    if (advance < 0) {
      state.counterResets += 1;
      return;
    }
    if (advance === 0 || !inRegularSession(receivedAt)) return;

    const key = Math.round(tick.ltp * PRICE_UNITS_PER_POINT);
    const cell = state.cells.get(key) ?? { buy: 0, sell: 0, unknown: 0 };
    const side = guessSide(tick.ltp, tick.bid, tick.ask);
    if (side === "BUY") cell.buy += advance;
    else if (side === "SELL") cell.sell += advance;
    else cell.unknown += advance;
    state.cells.set(key, cell);
    state.advances += 1;
    state.sinceMs ??= receivedAt;
    state.lastMs = receivedAt;
  }

  /** Starts listening to a streamer's `tick` events. Returns the function that stops. */
  attach(source: {
    on(event: "tick", listener: (tick: SideSplitTick) => void): unknown;
    off(event: "tick", listener: (tick: SideSplitTick) => void): unknown;
  }): () => void {
    const listener = (tick: SideSplitTick) => this.record(tick);
    source.on("tick", listener);
    return () => { source.off("tick", listener); };
  }

  /**
   * What has been counted today for `symbol`, rows `rowPoints` tall and aligned to multiples of it (the same rule the
   * stored-bar profile uses, so the two can be laid side by side). Null if the symbol has not been heard today.
   */
  snapshot(symbol: string, rowPoints: number, now: number = Date.now()): SideSplitSnapshot | null {
    const state = this.states.get(symbol);
    if (!state || state.date !== istDateOf(now) || !(rowPoints > 0)) return null;

    const byRow = new Map<number, Cell>();
    for (const [key, cell] of state.cells) {
      const row = Math.floor(key / PRICE_UNITS_PER_POINT / rowPoints);
      const into = byRow.get(row) ?? { buy: 0, sell: 0, unknown: 0 };
      into.buy += cell.buy;
      into.sell += cell.sell;
      into.unknown += cell.unknown;
      byRow.set(row, into);
    }
    const rows: SideSplitRow[] = [...byRow.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, cell]) => ({ low: row * rowPoints, high: (row + 1) * rowPoints, ...cell }));

    const totals = rows.reduce(
      (sum, row) => ({ buy: sum.buy + row.buy, sell: sum.sell + row.sell, unknown: sum.unknown + row.unknown }),
      { buy: 0, sell: 0, unknown: 0 },
    );
    const total = totals.buy + totals.sell + totals.unknown;
    return {
      symbol,
      rowPoints,
      rows,
      totals: { ...totals, total },
      unknownShare: total > 0 ? totals.unknown / total : null,
      messages: state.messages,
      advances: state.advances,
      counterResets: state.counterResets,
      since: state.sinceMs === null ? null : new Date(state.sinceMs).toISOString(),
      last: state.lastMs === null ? null : new Date(state.lastMs).toISOString(),
    };
  }
}

/** The wording the screen shows next to the numbers; one place, so the page and the API cannot drift apart. */
export const LIVE_SIDE_SPLIT_DEFINITIONS = {
  estimate:
    "An estimate from sampled live ticks, not a trade tape: the feed reports a last trade for only about a fifth to a third of the volume.",
  placement:
    "Each volume increase between two ticks is placed whole on the later tick's price, so trades that happened at several prices in between are counted at one.",
  sideRule:
    "Buy = last price at or above the ask; sell = at or below the bid; unknown = strictly inside the spread or no two-sided quote. A rule with no ground truth, not who initiated the trade.",
  scope:
    "Counted only since this server started hearing the contract today, in memory, regular session only. A restart resets it.",
} as const;
