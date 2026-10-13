/**
 * A volume profile on a fixed number of price rows, and how an entry sits against it.
 *
 * ## Why this exists next to `estimated_fixed_range_volume_profile.py`
 *
 * The first FRVP study (FRVP-MSP-P0-2026-10-12) cut the profile into 0.05-point bins and spread each
 * 1-minute bar's volume evenly over every bin its range touched. That conserves volume, but it makes
 * the density of a bar `volume / (range / tick)`, so a bar with almost no range piles its whole
 * volume into one or two bins. On BANKNIFTY 2026-10-05 the day's POC was one 180-contract bar with
 * zero range -- 0.03% of the day's volume -- and on 2026-10-07 a one-point post-close bar supplied 57%
 * of the POC bin. At that resolution the profile also had almost no low-volume nodes (0.29 per
 * session), because two neighbouring 0.05-point bins are nearly always equal.
 *
 * A fixed number of rows makes each row wide against a typical bar, so no single bar can make a
 * node, and a dip between two busy zones is a dip between rows rather than between ticks. That is
 * also how a trader draws a fixed-range profile. The row count is a design constant, not a tuned
 * parameter: it was set from how the profile looks, before any outcome was inspected.
 *
 * ## Volume from futures, price from the index
 *
 * Spot-index volume is a constituent aggregate and is not what traded. Futures volume is. But the
 * futures-to-index basis is large and moves (NIFTY about 77 points, BANKNIFTY about 241, with a
 * within-day range of 60-140 points), so mapping futures price levels onto the index with one basis
 * would misplace them by more than a row. So each minute's futures volume is spread over *that
 * minute's index* high-low range. The profile is then in the price space Sniper trades, with real
 * traded volume, and needs no basis at all.
 *
 * The full definition is frozen in `docs/2026-10-13-frvp-rows-observation-protocol.md`.
 */

export const VOLUME_PROFILE_ALGORITHM_VERSION = "frvp-rows48-v2";
export const VOLUME_PROFILE_ROWS = 48;
export const VALUE_AREA_FRACTION = 0.7;
/** A node is a local high only if it carries at least this share of the POC row's volume. */
export const HVN_MIN_SHARE_OF_POC = 0.5;
/** A node is a local low only if it holds less than this share of the quieter of the two busy sides. */
export const LVN_MAX_SHARE_OF_SIDE_PEAK = 0.5;

export interface ProfileBar {
  /** The index bar's range for the minute, carrying that minute's futures volume. */
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumeProfile {
  algorithmVersion: string;
  rowCount: number;
  rowWidth: number;
  /** Lowest price in the profile, the bottom edge of row 0. */
  low: number;
  high: number;
  rowVolumes: number[];
  totalVolume: number;
  poc: number;
  vah: number;
  val: number;
  hvns: number[];
  lvns: number[];
  vwap: number;
  /** The volume-weighted mean of the row centres: where the bulk of the volume sits in the range. */
  volumeCentroid: number;
}

export type ProfilePosition = "INSIDE_VALUE" | "ABOVE_VAH" | "BELOW_VAL";
export type TradeDirection = "LONG" | "SHORT";

export interface ProfileLevel {
  level: number;
  /** Absolute distance from the entry, in index points. */
  distance: number;
}

export interface EntryAgainstProfile {
  position: ProfilePosition;
  /** Entry minus POC, in index points: positive when the entry is above it. */
  fromPoc: number;
  poc: number;
  vah: number;
  val: number;
  rowWidth: number;
  lvnAhead: ProfileLevel | null;
  lvnBehind: ProfileLevel | null;
  hvnAhead: ProfileLevel | null;
  /** True when the nearest LVN ahead lies before the nearest HVN ahead, i.e. open road to the dip. */
  lvnBeforeHvn: boolean | null;
}

/** Row volumes are sums of float fractions, so equal in theory is equal only to within rounding. */
function sameVolume(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function rowCentre(low: number, rowWidth: number, index: number): number {
  return low + (index + 0.5) * rowWidth;
}

/**
 * Builds the profile, or returns null when the bars cannot make one (no volume, or no price range
 * at all). Bars with no volume are skipped; a bar whose high equals its low puts its volume in the
 * one row that holds the price.
 */
export function buildFixedRowVolumeProfile(
  bars: readonly ProfileBar[],
  rowCount: number = VOLUME_PROFILE_ROWS,
): VolumeProfile | null {
  const usable = bars.filter((bar) =>
    bar.volume > 0 && Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high >= bar.low);
  if (usable.length === 0 || rowCount < 3) return null;

  const low = Math.min(...usable.map((bar) => bar.low));
  const high = Math.max(...usable.map((bar) => bar.high));
  if (!(high > low)) return null;

  const rowWidth = (high - low) / rowCount;
  const rowVolumes = new Array<number>(rowCount).fill(0);
  let notional = 0;
  let totalVolume = 0;

  for (const bar of usable) {
    const first = Math.min(rowCount - 1, Math.max(0, Math.floor((bar.low - low) / rowWidth)));
    if (bar.high === bar.low) {
      rowVolumes[first]! += bar.volume;
    } else {
      const span = bar.high - bar.low;
      const last = Math.min(rowCount - 1, Math.max(0, Math.floor((bar.high - low) / rowWidth)));
      for (let row = first; row <= last; row += 1) {
        const rowBottom = low + row * rowWidth;
        const overlap = Math.min(bar.high, rowBottom + rowWidth) - Math.max(bar.low, rowBottom);
        if (overlap > 0) rowVolumes[row]! += bar.volume * (overlap / span);
      }
    }
    notional += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    totalVolume += bar.volume;
  }
  if (totalVolume <= 0) return null;

  const vwap = notional / totalVolume;
  let centroidNotional = 0;
  for (let row = 0; row < rowCount; row += 1) centroidNotional += rowVolumes[row]! * rowCentre(low, rowWidth, row);
  const pocRow = pointOfControlRow(rowVolumes, low, rowWidth, vwap);
  const { valRow, vahRow } = valueAreaRows(rowVolumes, pocRow, totalVolume);
  const { hvnRows, lvnRows } = findNodes(rowVolumes, pocRow);

  return {
    algorithmVersion: VOLUME_PROFILE_ALGORITHM_VERSION,
    rowCount,
    rowWidth,
    low,
    high,
    rowVolumes,
    totalVolume,
    poc: rowCentre(low, rowWidth, pocRow),
    val: low + valRow * rowWidth,
    vah: low + (vahRow + 1) * rowWidth,
    hvns: hvnRows.map((row) => rowCentre(low, rowWidth, row)),
    lvns: lvnRows.map((row) => rowCentre(low, rowWidth, row)),
    vwap,
    volumeCentroid: centroidNotional / totalVolume,
  };
}

/** The busiest row; a tie goes to the row nearest the session VWAP, then the lower one. */
function pointOfControlRow(rowVolumes: readonly number[], low: number, rowWidth: number, vwap: number): number {
  const peak = Math.max(...rowVolumes);
  let best = -1;
  for (let row = 0; row < rowVolumes.length; row += 1) {
    if (!sameVolume(rowVolumes[row]!, peak)) continue;
    if (best < 0 || Math.abs(rowCentre(low, rowWidth, row) - vwap) < Math.abs(rowCentre(low, rowWidth, best) - vwap)) {
      best = row;
    }
  }
  return best;
}

/**
 * The market-profile convention: from the POC row, compare the next two rows above with the next two
 * below, take the larger pair, and repeat until the area holds 70% of the volume. With one row left
 * on a side that row is the pair.
 */
function valueAreaRows(
  rowVolumes: readonly number[],
  pocRow: number,
  totalVolume: number,
): { valRow: number; vahRow: number } {
  const target = VALUE_AREA_FRACTION * totalVolume;
  let lower = pocRow;
  let upper = pocRow;
  let running = rowVolumes[pocRow]!;
  const last = rowVolumes.length - 1;

  while (running < target && (lower > 0 || upper < last)) {
    const upPair = upper < last ? rowVolumes[upper + 1]! + (upper + 1 < last ? rowVolumes[upper + 2]! : 0) : -1;
    const downPair = lower > 0 ? rowVolumes[lower - 1]! + (lower - 1 > 0 ? rowVolumes[lower - 2]! : 0) : -1;
    // A tie goes to the lower side, as in the first study.
    if (upPair > downPair) {
      upper = Math.min(last, upper + 2);
      running += upPair;
    } else {
      lower = Math.max(0, lower - 2);
      running += downPair;
    }
  }
  return { valRow: lower, vahRow: upper };
}

/**
 * High nodes are local maxima carrying at least half the POC row's volume, the POC's own zone
 * included: for "what is on the road ahead" the busiest zone is the biggest obstacle of all. Low nodes are interior local minima holding under half the volume of the quieter of the
 * two busiest sides, so a dip only counts if there is real volume both above and below it. A run of
 * equal rows is one node, placed at its middle.
 */
function findNodes(rowVolumes: readonly number[], pocRow: number): { hvnRows: number[]; lvnRows: number[] } {
  const pocVolume = rowVolumes[pocRow]!;
  const hvnRows: number[] = [];
  const lvnRows: number[] = [];
  const last = rowVolumes.length - 1;

  for (let start = 0; start <= last; ) {
    let end = start;
    while (end < last && sameVolume(rowVolumes[end + 1]!, rowVolumes[start]!)) end += 1;
    const volume = rowVolumes[start]!;
    const middle = Math.floor((start + end) / 2);
    const leftOf = start > 0 ? rowVolumes[start - 1]! : null;
    const rightOf = end < last ? rowVolumes[end + 1]! : null;

    const isLocalMax = (leftOf === null || volume > leftOf && !sameVolume(volume, leftOf))
      && (rightOf === null || volume > rightOf && !sameVolume(volume, rightOf));
    const isLocalMin = leftOf !== null && rightOf !== null && volume < leftOf && volume < rightOf;

    if (isLocalMax && volume >= HVN_MIN_SHARE_OF_POC * pocVolume) hvnRows.push(middle);
    if (isLocalMin) {
      const peakBelow = Math.max(...rowVolumes.slice(0, start));
      const peakAbove = Math.max(...rowVolumes.slice(end + 1));
      if (volume < LVN_MAX_SHARE_OF_SIDE_PEAK * Math.min(peakBelow, peakAbove)) lvnRows.push(middle);
    }
    start = end + 1;
  }
  return { hvnRows, lvnRows };
}

function nearest(levels: readonly number[], entry: number, direction: TradeDirection, ahead: boolean): ProfileLevel | null {
  const up = direction === "LONG" === ahead;
  const candidates = levels
    .filter((level) => (up ? level > entry : level < entry))
    .map((level) => ({ level, distance: Math.abs(level - entry) }));
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] ?? null;
}

/**
 * Describes where an entry sits against a prior-session profile. Everything here is known at the
 * decision: the profile is a completed earlier session and `entry` is the index price now.
 */
export function describeEntryAgainstProfile(
  profile: VolumeProfile,
  entry: number,
  direction: TradeDirection,
): EntryAgainstProfile {
  const position: ProfilePosition = entry > profile.vah ? "ABOVE_VAH" : entry < profile.val ? "BELOW_VAL" : "INSIDE_VALUE";
  const lvnAhead = nearest(profile.lvns, entry, direction, true);
  const hvnAhead = nearest(profile.hvns, entry, direction, true);
  return {
    position,
    fromPoc: entry - profile.poc,
    poc: profile.poc,
    vah: profile.vah,
    val: profile.val,
    rowWidth: profile.rowWidth,
    lvnAhead,
    lvnBehind: nearest(profile.lvns, entry, direction, false),
    hvnAhead,
    lvnBeforeHvn: lvnAhead === null ? null : hvnAhead === null ? true : lvnAhead.distance < hvnAhead.distance,
  };
}

/**
 * The shape a trader reads off a profile. The sources agree on what the shapes mean and give no
 * numbers for any of them, so the numbers below are this lab's own and are frozen in
 * `docs/2026-10-13-frvp-rows-observation-protocol.md` (Amendment 1):
 *
 * - `P`: the POC is in the upper third of the range. A fast move up, then acceptance high; a thin tail
 *   below.
 * - `b`: the POC is in the lower third. A fast move down, then acceptance low; a thin tail above.
 * - `D`: the POC is in the middle third. Balance.
 *
 * Every description consulted says the larger *concentration* sits high or low in the range, and none
 * gives a number. The POC is the proxy used, because it is what a trader reads off the chart. A first
 * version used the volume-weighted centre of the profile instead and was dropped: drawn against the 14
 * real sessions it called almost every day D, including days that are plainly top- or bottom-heavy to
 * the eye (BANKNIFTY 2026-10-05, 2026-10-12). The centre's position is still recorded
 * (`centroidPosition`) so the two can be compared later.
 * - `B`: double distribution -- two comparable humps with a thin neck between them: a second peak a
 *   quarter of the range or more from the POC holding at least 60% of its volume, and a dip between
 *   them under 40% of that second peak, in the middle band of the range. Checked first, because it is
 *   the more specific shape. A first version called any dip with a node on each side a B and labelled
 *   6 of 14 sessions that way, including clear P and b days; a double distribution is rare and obvious.
 *
 * Where the POC sits is the whole of P, b and D. That is blunt on purpose: it is the rule that can be
 * stated before looking at an outcome, and it matches how the shapes are described.
 */
export type ProfileShape = "P" | "b" | "D" | "B";

/** The POC's position within the range: 0 at the bottom, 1 at the top. */
export const SHAPE_THIRD = 1 / 3;
/** The dip between two humps only makes a double distribution inside this band of the range. */
export const DOUBLE_DISTRIBUTION_BAND: readonly [number, number] = [0.25, 0.75];
/** The second hump must lie at least this share of the rows away from the POC. */
export const DOUBLE_DISTRIBUTION_MIN_SEPARATION = 0.25;
/** The second hump must hold at least this share of the POC row's volume. */
export const DOUBLE_DISTRIBUTION_MIN_SECOND_PEAK = 0.6;
/** The neck must hold less than this share of the second hump's volume. */
export const DOUBLE_DISTRIBUTION_MAX_NECK = 0.4;

/** Row counts a shape is re-read at; if it changes with any of them it is not a stable reading. */
export const SHAPE_STABILITY_ROWS: readonly number[] = [24, 32, 64];

export interface ProfileShapeReading {
  shape: ProfileShape;
  /** POC position within the range, 0-1. */
  pocPosition: number;
  /** Position of the volume-weighted centre within the range, 0-1; recorded, not used to classify. */
  centroidPosition: number;
}

function hasDoubleDistribution(profile: VolumeProfile): boolean {
  const rows = profile.rowVolumes;
  const pocRow = Math.min(rows.length - 1, Math.max(0, Math.floor((profile.poc - profile.low) / profile.rowWidth)));
  const minimumGap = Math.ceil(DOUBLE_DISTRIBUTION_MIN_SEPARATION * rows.length);

  let secondRow = -1;
  for (let row = 0; row < rows.length; row += 1) {
    if (Math.abs(row - pocRow) < minimumGap) continue;
    if (secondRow < 0 || rows[row]! > rows[secondRow]!) secondRow = row;
  }
  if (secondRow < 0) return false;
  const secondPeak = rows[secondRow]!;
  if (secondPeak < DOUBLE_DISTRIBUTION_MIN_SECOND_PEAK * rows[pocRow]!) return false;

  const from = Math.min(pocRow, secondRow) + 1;
  const to = Math.max(pocRow, secondRow) - 1;
  if (to < from) return false;
  let neckRow = from;
  for (let row = from; row <= to; row += 1) if (rows[row]! < rows[neckRow]!) neckRow = row;
  if (rows[neckRow]! >= DOUBLE_DISTRIBUTION_MAX_NECK * secondPeak) return false;

  // The neck is the middle of the thin stretch, not its first row: a long flat gap between two humps is
  // centred between them, however close its first row sits to one of them.
  let neckLeft = neckRow;
  let neckRight = neckRow;
  while (neckLeft > from && sameVolume(rows[neckLeft - 1]!, rows[neckRow]!)) neckLeft -= 1;
  while (neckRight < to && sameVolume(rows[neckRight + 1]!, rows[neckRow]!)) neckRight += 1;
  const neckPosition = (Math.floor((neckLeft + neckRight) / 2) + 0.5) / rows.length;
  return neckPosition >= DOUBLE_DISTRIBUTION_BAND[0] && neckPosition <= DOUBLE_DISTRIBUTION_BAND[1];
}

export function classifyProfileShape(profile: VolumeProfile): ProfileShapeReading {
  const range = profile.high - profile.low;
  const pocPosition = (profile.poc - profile.low) / range;
  const centroidPosition = (profile.volumeCentroid - profile.low) / range;

  if (hasDoubleDistribution(profile)) return { shape: "B", pocPosition, centroidPosition };

  if (pocPosition >= 1 - SHAPE_THIRD) return { shape: "P", pocPosition, centroidPosition };
  if (pocPosition <= SHAPE_THIRD) return { shape: "b", pocPosition, centroidPosition };
  return { shape: "D", pocPosition, centroidPosition };
}
