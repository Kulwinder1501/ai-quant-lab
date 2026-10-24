/**
 * A volume-by-price profile of one futures session, estimated from 1-minute bars. Pure.
 *
 * **This is an estimate, and the response says so.** No feed available here publishes traded volume at each price (see
 * the footprint investigation: the feed's last-trade quantity covers only 31-43% of volume, and there are no trade
 * prints). A bar says how much traded in a minute and between which two prices; it does not say where inside that
 * range. The profile therefore *assumes* a bar's volume was spread evenly across its high-low range. Volume is
 * conserved exactly, but where it sits within a bar is not observed, so:
 *
 * - The profile cannot resolve price better than a typical bar's range. `profileSensitivity` makes that visible by
 *   building the same profile from 5-minute bars and reporting how much of the volume lands in the same rows and how far
 *   the POC and value area move. Large shifts mean the levels are only as good as the shift.
 * - A zero-range bar puts its whole volume in the row holding its price. With rows several points tall this is one
 *   row's worth of a minute's volume, not a spike; it is the failure the first FRVP study hit at 0.05-point bins.
 *
 * Price space is the futures contract's own, the same prices the depth views show, and volume is the bar's reported volume
 * in units (every bar volume on the checked days is an exact multiple of the lot size: contracts x lot size, not lots).
 *
 * This module is a display profile. It is deliberately separate from `fixed-row-volume-profile.ts`, whose constants and
 * definitions are frozen for a pre-registered study (48 rows, index price space) and must not be changed to suit a view. In
 * particular no high- or low-volume nodes are computed here: their thresholds belong to that study.
 *
 * Definitions, all stated again in `SESSION_PROFILE_DEFINITIONS` for the screen:
 * - Rows are `rowPoints` index points tall, aligned to multiples of `rowPoints`; a price belongs to `floor(price / rowPoints)`.
 * - POC: the row with the most volume; a tie goes to the row nearest the session VWAP.
 * - Value area: from the POC, repeatedly add the two rows above or the two rows below, whichever pair holds more volume
 *   (a tie goes up), until the included rows hold at least 70% of the volume. VAH is the top edge of the highest included
 *   row and VAL the bottom edge of the lowest.
 * - VWAP: sum of (high + low + close) / 3 x volume over sum of volume, an approximation from bars.
 */

export const VALUE_AREA_FRACTION = 0.7;

/** Regular cash-hours session of the index futures: 09:15 up to 15:30 IST, 375 one-minute bars. */
export const SESSION_OPEN_MINUTE_IST = 9 * 60 + 15;
export const SESSION_CLOSE_MINUTE_IST = 15 * 60 + 30;
export const EXPECTED_SESSION_MINUTES = SESSION_CLOSE_MINUTE_IST - SESSION_OPEN_MINUTE_IST;

/** A session with fewer bars than this share of the expected minutes is partial (still in progress, or a data hole). */
export const COMPLETE_SESSION_MIN_BAR_SHARE = 0.96;

const IST_OFFSET_MS = 330 * 60_000;

export interface FuturesBar {
  /** Start of the bar. */
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ProfileRow {
  /** Bottom and top edge of the row, in index points. */
  low: number;
  high: number;
  volume: number;
  inValueArea: boolean;
  isPoc: boolean;
}

export interface SessionProfile {
  rowPoints: number;
  rows: ProfileRow[];
  totalVolume: number;
  /** Midpoint of the POC row. */
  poc: number;
  /** Top edge of the highest value-area row. */
  vah: number;
  /** Bottom edge of the lowest value-area row. */
  val: number;
  /** Share of the volume inside the value area (at least 0.7 unless the whole profile is smaller). */
  valueAreaShare: number;
  vwap: number | null;
}

export interface SessionSummary {
  open: number;
  high: number;
  low: number;
  close: number;
  firstBarAt: string;
  lastBarAt: string;
}

export interface SessionBarQuality {
  expectedMinutes: number;
  /** Regular-session bars received. */
  barsUsed: number;
  /** Of those, bars with volume above zero. */
  barsWithVolume: number;
  /** Bars that traded nothing: a flat, zero-volume minute is a genuine no-trade minute, not a hole. */
  zeroVolumeBars: number;
  /** Expected minutes with no bar at all. */
  missingMinutes: number;
  /** Bars outside 09:15-15:30 IST (the post-close auction minutes), not used. */
  outsideSessionBarsExcluded: number;
  /** The session is complete enough to treat its profile as the day's. */
  complete: boolean;
}

/** Minutes since midnight IST of an instant. */
function istMinuteOfDay(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Splits bars into the regular session and the rest. Bars are expected to belong to one IST day. */
export function selectRegularSessionBars(bars: readonly FuturesBar[]): { regular: FuturesBar[]; excluded: number } {
  const regular = bars
    .filter((bar) => {
      const minute = istMinuteOfDay(bar.openTime);
      return minute >= SESSION_OPEN_MINUTE_IST && minute < SESSION_CLOSE_MINUTE_IST;
    })
    .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  return { regular, excluded: bars.length - regular.length };
}

/** `expectedMinutes` is the length of what the bars should cover: the whole session, or the chosen range of it. */
/**
 * A window of the regular session, in minutes since midnight IST: `fromMinute` inclusive, `toMinute` exclusive. Its edges lie
 * on 5-minute marks so that the 5-minute bars the resolution check rebuilds the profile from never straddle an edge.
 */
export interface SessionRange {
  fromMinute: number;
  toMinute: number;
}

export const RANGE_STEP_MINUTES = 5;
/** Shorter than this a profile is a handful of bars; it is refused rather than drawn. */
export const MIN_RANGE_MINUTES = 15;

export const FULL_SESSION_RANGE: SessionRange = { fromMinute: SESSION_OPEN_MINUTE_IST, toMinute: SESSION_CLOSE_MINUTE_IST };

export function isFullSession(range: SessionRange): boolean {
  return range.fromMinute === SESSION_OPEN_MINUTE_IST && range.toMinute === SESSION_CLOSE_MINUTE_IST;
}

/** `HH:MM` (24-hour, IST) as minutes since midnight, or null when it is not a real clock time. */
export function parseClockMinute(text: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export function formatClockMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Why a range cannot be used, or null when it can. */
export function rangeProblem(range: SessionRange): string | null {
  if (range.fromMinute < SESSION_OPEN_MINUTE_IST || range.toMinute > SESSION_CLOSE_MINUTE_IST) {
    return `The range must lie within the regular session, ${formatClockMinute(SESSION_OPEN_MINUTE_IST)}-${formatClockMinute(SESSION_CLOSE_MINUTE_IST)} IST.`;
  }
  if (range.fromMinute % RANGE_STEP_MINUTES !== 0 || range.toMinute % RANGE_STEP_MINUTES !== 0) {
    return `The range edges must be multiples of ${RANGE_STEP_MINUTES} minutes.`;
  }
  if (range.toMinute - range.fromMinute < MIN_RANGE_MINUTES) {
    return `The range must be at least ${MIN_RANGE_MINUTES} minutes long.`;
  }
  return null;
}

/** The bars that opened in the range: from inclusive, to exclusive. Expects regular-session bars. */
export function selectBarsInRange(regular: readonly FuturesBar[], range: SessionRange): FuturesBar[] {
  return regular.filter((bar) => {
    const minute = istMinuteOfDay(bar.openTime);
    return minute >= range.fromMinute && minute < range.toMinute;
  });
}

export function assessBarQuality(
  regular: readonly FuturesBar[],
  outsideExcluded: number,
  expectedMinutes = EXPECTED_SESSION_MINUTES,
): SessionBarQuality {
  const distinctMinutes = new Set(regular.map((bar) => Math.floor(bar.openTime.getTime() / 60_000)));
  const zeroVolumeBars = regular.filter((bar) => !(bar.volume > 0)).length;
  return {
    expectedMinutes,
    barsUsed: regular.length,
    barsWithVolume: regular.length - zeroVolumeBars,
    zeroVolumeBars,
    missingMinutes: Math.max(0, expectedMinutes - distinctMinutes.size),
    outsideSessionBarsExcluded: outsideExcluded,
    complete: distinctMinutes.size >= expectedMinutes * COMPLETE_SESSION_MIN_BAR_SHARE,
  };
}

export function summariseSession(regular: readonly FuturesBar[]): SessionSummary | null {
  if (regular.length === 0) return null;
  const first = regular[0]!;
  const last = regular[regular.length - 1]!;
  return {
    open: first.open,
    high: Math.max(...regular.map((bar) => bar.high)),
    low: Math.min(...regular.map((bar) => bar.low)),
    close: last.close,
    firstBarAt: first.openTime.toISOString(),
    lastBarAt: last.openTime.toISOString(),
  };
}

/** Rolls 1-minute bars up to `minutes`-minute bars on epoch-aligned boundaries (IST is a whole number of 5-minute steps). */
export function aggregateBars(bars: readonly FuturesBar[], minutes: number): FuturesBar[] {
  const spanMs = minutes * 60_000;
  const groups = new Map<number, FuturesBar[]>();
  for (const bar of [...bars].sort((a, b) => a.openTime.getTime() - b.openTime.getTime())) {
    const key = Math.floor(bar.openTime.getTime() / spanMs) * spanMs;
    const group = groups.get(key);
    if (group) group.push(bar); else groups.set(key, [bar]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([key, group]) => ({
    openTime: new Date(key),
    open: group[0]!.open,
    high: Math.max(...group.map((bar) => bar.high)),
    low: Math.min(...group.map((bar) => bar.low)),
    close: group[group.length - 1]!.close,
    volume: group.reduce((sum, bar) => sum + bar.volume, 0),
  }));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds the profile, or null when no bar carries volume. Every bar's volume is placed in rows in proportion to how much
 * of the bar's range each row covers; a bar with no range goes wholly to the row holding its price.
 */
export function buildSessionProfile(bars: readonly FuturesBar[], rowPoints: number): SessionProfile | null {
  if (!(rowPoints > 0)) throw new Error("rowPoints must be positive.");
  const traded = bars.filter((bar) => bar.volume > 0);
  if (traded.length === 0) return null;

  const lowestRow = Math.floor(Math.min(...traded.map((bar) => bar.low)) / rowPoints);
  const highestRow = Math.floor(Math.max(...traded.map((bar) => bar.high)) / rowPoints);
  const volumes = new Array<number>(highestRow - lowestRow + 1).fill(0);

  let weightedPrice = 0;
  let totalVolume = 0;
  for (const bar of traded) {
    totalVolume += bar.volume;
    weightedPrice += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    const range = bar.high - bar.low;
    if (!(range > 0)) {
      volumes[Math.floor(bar.close / rowPoints) - lowestRow]! += bar.volume;
      continue;
    }
    const firstRow = Math.floor(bar.low / rowPoints);
    const lastRow = Math.floor(bar.high / rowPoints);
    for (let row = firstRow; row <= lastRow; row += 1) {
      const overlap = Math.min(bar.high, (row + 1) * rowPoints) - Math.max(bar.low, row * rowPoints);
      if (overlap > 0) volumes[row - lowestRow]! += (bar.volume * overlap) / range;
    }
  }
  const vwap = totalVolume > 0 ? weightedPrice / totalVolume : null;

  // POC: most volume; a tie goes to the row nearest the VWAP.
  let pocIndex = 0;
  const distanceToVwap = (index: number) => Math.abs((lowestRow + index + 0.5) * rowPoints - (vwap ?? 0));
  volumes.forEach((volume, index) => {
    const best = volumes[pocIndex]!;
    if (volume > best || (volume === best && distanceToVwap(index) < distanceToVwap(pocIndex))) pocIndex = index;
  });

  // Value area: grow from the POC by the heavier pair of neighbouring rows until 70% of the volume is inside.
  let lo = pocIndex;
  let hi = pocIndex;
  let included = volumes[pocIndex]!;
  const target = VALUE_AREA_FRACTION * totalVolume;
  while (included < target && (lo > 0 || hi < volumes.length - 1)) {
    const up = (volumes[hi + 1] ?? 0) + (volumes[hi + 2] ?? 0);
    const down = (volumes[lo - 1] ?? 0) + (volumes[lo - 2] ?? 0);
    const canGoUp = hi < volumes.length - 1;
    const canGoDown = lo > 0;
    if (canGoUp && (!canGoDown || up >= down)) {
      for (let step = 0; step < 2 && hi < volumes.length - 1; step += 1) { hi += 1; included += volumes[hi]!; }
    } else {
      for (let step = 0; step < 2 && lo > 0; step += 1) { lo -= 1; included += volumes[lo]!; }
    }
  }

  const rows: ProfileRow[] = volumes.map((volume, index) => ({
    low: (lowestRow + index) * rowPoints,
    high: (lowestRow + index + 1) * rowPoints,
    volume: round2(volume),
    inValueArea: index >= lo && index <= hi,
    isPoc: index === pocIndex,
  }));

  return {
    rowPoints,
    rows,
    totalVolume,
    poc: (lowestRow + pocIndex + 0.5) * rowPoints,
    vah: (lowestRow + hi + 1) * rowPoints,
    val: (lowestRow + lo) * rowPoints,
    valueAreaShare: included / totalVolume,
    vwap: vwap === null ? null : round2(vwap),
  };
}

export interface ProfileSensitivity {
  /** The coarser bars the comparison profile was built from. */
  comparedWithBarMinutes: number;
  /** Share of the day's volume that lands in the same rows under both constructions (1 = identical). */
  agreement: number;
  /** Comparison minus main, in index points. */
  pocShiftPoints: number;
  vahShiftPoints: number;
  valShiftPoints: number;
}

/**
 * How much the profile depends on the bar size it was built from. The same session is rebuilt from `minutes`-minute bars
 * (default 5): where the volume sits inside a bar is assumed, and a coarser bar makes that assumption cover five times the
 * range. A level that moves a lot between the two is not resolved by the data.
 */
export function profileSensitivity(
  bars: readonly FuturesBar[],
  main: SessionProfile,
  minutes = 5,
): ProfileSensitivity | null {
  const coarse = buildSessionProfile(aggregateBars(bars, minutes), main.rowPoints);
  if (coarse === null) return null;
  const share = (profile: SessionProfile) => {
    const byLow = new Map<number, number>();
    for (const row of profile.rows) byLow.set(row.low, row.volume / profile.totalVolume);
    return byLow;
  };
  const a = share(main);
  const b = share(coarse);
  let overlap = 0;
  for (const [low, value] of a) overlap += Math.min(value, b.get(low) ?? 0);
  return {
    comparedWithBarMinutes: minutes,
    agreement: Math.min(1, overlap),
    pocShiftPoints: coarse.poc - main.poc,
    vahShiftPoints: coarse.vah - main.vah,
    valShiftPoints: coarse.val - main.val,
  };
}

/** How many sessions a composite profile may span. */
export const COMPOSITE_DAY_CHOICES = [1, 3, 5, 10] as const;

export interface CompositeSelection {
  /** The sessions used, oldest first; the last is the requested date. */
  dates: string[];
  /** The next older stored session belongs to a different contract, so the composite stopped there. */
  stoppedAtRoll: boolean;
}

/**
 * The sessions a composite of `days` sessions ending at `date` is built from, all of the same contract.
 *
 * `listings` are the stored sessions (any order), each under the contract that was front month on it. Going back from the
 * requested date, sessions are taken one after another while they belong to `symbol`; the first one that belongs to another
 * contract ends the walk, because a roll changes which market the volume is from and its prices carry a basis. A day with no
 * stored bar is simply not in `listings`: the composite uses the stored days, and the caller reports how many it got.
 */
export function chooseCompositeSessions(
  listings: ReadonlyArray<{ sessionDate: string; symbol: string }>,
  date: string,
  symbol: string,
  days: number,
): CompositeSelection {
  const older = listings
    .filter((listing) => listing.sessionDate < date)
    .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));
  const dates = [date];
  let stoppedAtRoll = false;
  for (const listing of older) {
    if (dates.length >= days) break;
    if (listing.symbol !== symbol) { stoppedAtRoll = true; break; }
    dates.push(listing.sessionDate);
  }
  return { dates: dates.reverse(), stoppedAtRoll };
}

export const SESSION_PROFILE_DEFINITIONS = {
  estimate: "Estimated, not observed. Each 1-minute bar's volume is spread evenly across the bar's high-low range; where inside a bar the volume traded is not known. Volume is conserved exactly.",
  rows: "Rows are rowPoints index points tall and aligned to multiples of rowPoints. A bar with no range puts its volume in the row holding its price.",
  poc: "Point of control: the row with the most volume (the row's midpoint). A tie goes to the row nearest the session VWAP.",
  valueArea: "From the POC, repeatedly add the two rows above or the two rows below, whichever pair holds more volume (a tie goes up), until at least 70% of the volume is inside. VAH is the top edge of the highest row inside, VAL the bottom edge of the lowest.",
  vwap: "Sum of (high + low + close) / 3 x volume over sum of volume, over the regular session. An approximation from bars.",
  resolution: "The same session rebuilt from 5-minute bars: agreement is the share of volume landing in the same rows under both, and the shifts are how far the POC, VAH and VAL move. A level that moves a lot is not resolved by the data.",
  volume: "The bar volume Fyers reports, in units (contracts x lot size). Every bar volume checked was an exact multiple of the lot size.",
  session: "Regular session, 09:15 up to 15:30 IST. The post-close minutes (15:30 onwards) are not used.",
  composite: "With days above 1 the profile adds up the bars of the last N stored sessions of the same contract (the same window of each), as one profile. It stops at a contract roll, and a day with no stored bar is not in it: the page says how many sessions it got. VWAP is over all of them. Prices are the contract's own, so a trend across the days widens the profile, and a profile of several days is not the same thing as one day's.",
  range: "An optional window of the session, from inclusive to exclusive, on 5-minute marks and at least 15 minutes long. The profile, VWAP, value area and resolution check use only the bars that opened in the window; the previous-session levels are always the whole previous session.",
  notSignal: "A profile describes where volume was estimated to trade; a POC or value-area edge is not a level price must respect.",
} as const;
