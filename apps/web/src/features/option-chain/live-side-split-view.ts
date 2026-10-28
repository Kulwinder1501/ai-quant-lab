import { formatIstTime } from "./oi-format";

/**
 * The live, ESTIMATED split of today's futures volume at each price by the side of the quote the last price sat on.
 * Everything here is a view of the API's `/volume-profile/live-side-split` response; the wording that says what the
 * numbers are and are not comes from the API (`definitions`) so the page and the server cannot drift apart.
 */

export interface LiveSideSplitDefinitions {
  estimate: string;
  placement: string;
  sideRule: string;
  scope: string;
}

export interface LiveSideSplitRow {
  low: number;
  high: number;
  buy: number;
  sell: number;
  unknown: number;
}

export interface LiveSideSplitAvailable {
  available: true;
  underlying: string;
  sessionDate: string;
  symbol: string;
  estimated: true;
  rowPoints: number;
  /** Ascending by price. */
  rows: LiveSideSplitRow[];
  totals: { buy: number; sell: number; unknown: number; total: number };
  unknownShare: number | null;
  messages: number;
  advances: number;
  counterResets: number;
  since: string | null;
  last: string | null;
  definitions: LiveSideSplitDefinitions;
}

export interface LiveSideSplitUnavailable {
  available: false;
  reason: string;
  definitions?: LiveSideSplitDefinitions;
}

export type LiveSideSplitPayload = LiveSideSplitAvailable | LiveSideSplitUnavailable;

export function liveSideSplitQuery(input: { underlying: string; rowPoints: number | null }): string {
  const params = new URLSearchParams({ underlying: input.underlying });
  if (input.rowPoints !== null) params.set("rowPoints", String(input.rowPoints));
  return params.toString();
}

export interface SplitBar {
  key: string;
  /** `low–high` in index points. */
  label: string;
  total: number;
  /** The whole bar's length as a percent of the busiest row's, so rows compare with each other. */
  lengthPct: number;
  /** Each part as a percent of THIS row's own volume; the three add to 100. */
  buyPct: number;
  sellPct: number;
  unknownPct: number;
}

/**
 * One bar per row, highest price first (the way a price axis reads). Lengths are relative to the busiest row; the
 * three parts of a bar are shares of that row, with "unknown" always drawn as its own part and never folded into a side.
 */
export function buildSplitBars(payload: LiveSideSplitAvailable): SplitBar[] {
  const busiest = payload.rows.reduce((largest, row) => Math.max(largest, row.buy + row.sell + row.unknown), 0);
  return [...payload.rows]
    .sort((a, b) => b.low - a.low)
    .map((row) => {
      const total = row.buy + row.sell + row.unknown;
      return {
        key: String(row.low),
        label: `${row.low}–${row.high}`,
        total,
        lengthPct: busiest > 0 ? (total / busiest) * 100 : 0,
        buyPct: total > 0 ? (row.buy / total) * 100 : 0,
        sellPct: total > 0 ? (row.sell / total) * 100 : 0,
        unknownPct: total > 0 ? (row.unknown / total) * 100 : 0,
      };
    });
}

/** Whole-number percent text, never "0%" for a share that exists but is under half a percent. */
export function percentText(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "—";
  const percent = share * 100;
  if (percent > 0 && percent < 0.5) return "<1%";
  return `${Math.round(percent)}%`;
}

/** The one line above the bars: what was counted, since when, and how much has no side. */
export function splitHeadline(payload: LiveSideSplitAvailable): string {
  const since = payload.since === null ? null : formatIstTime(Date.parse(payload.since));
  const last = payload.last === null ? null : formatIstTime(Date.parse(payload.last));
  const parts = [
    `${payload.underlying} futures ${payload.symbol}`,
    since === null ? "counting not started" : `counted since ${since} IST${last !== null && last !== since ? ` (last ${last})` : ""}`,
    `${payload.totals.total.toLocaleString("en-IN")} units`,
    `side unknown for ${percentText(payload.unknownShare)}`,
  ];
  return parts.join(" · ");
}

/** Buy, sell and unknown as shares of everything counted. They add to 100 up to rounding. */
export function totalsText(payload: LiveSideSplitAvailable): string {
  const { buy, sell, unknown, total } = payload.totals;
  if (total <= 0) return "";
  return `buy ${percentText(buy / total)} · sell ${percentText(sell / total)} · unknown ${percentText(unknown / total)}`;
}
