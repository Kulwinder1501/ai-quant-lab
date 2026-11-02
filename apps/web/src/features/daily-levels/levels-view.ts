/**
 * What the daily levels page shows, as plain data: the ladder of zones around the previous close, the wording of each line, and whether
 * the sheet is for today. Kept out of the component so it is tested without a browser.
 */

export type LevelFamily = "PRIOR_DAY" | "PIVOT" | "RANGE_5D" | "RANGE_WEEK" | "ROUND_NUMBER" | "OI_WALL";

export interface SheetLevel {
  family: LevelFamily;
  key: string;
  label: string;
  price: number;
  note?: string;
}

export interface SheetZone {
  low: number;
  high: number;
  centre: number;
  levels: SheetLevel[];
  families: LevelFamily[];
  confluence: number;
  position: "ABOVE" | "BELOW" | "AT";
  distancePoints: number;
  distancePct: number;
}

export interface HistoryComparison {
  family: string;
  sessions: number;
  realResolved: number;
  placeboResolved: number;
  realBounceShare: number | null;
  placeboBounceShare: number | null;
  difference: number | null;
  lower: number | null;
  upper: number | null;
  sentence: string;
}

export const FAMILY_LABELS: Record<string, string> = {
  PRIOR_DAY: "Previous day",
  PIVOT: "Pivot",
  RANGE_5D: "5-day range",
  RANGE_WEEK: "Previous week",
  ROUND_NUMBER: "Round number",
  OI_WALL: "Option OI wall",
  ALL: "All levels",
  CONFLUENCE_2_PLUS_VS_1: "Zones where 2+ sources agree, against single-source zones",
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}

export type LadderRow =
  | { kind: "ZONE"; zone: SheetZone }
  | { kind: "REFERENCE"; price: number };

/**
 * Zones from the highest price down, with the previous close marked where it sits. A zone that contains the close is shown as a zone,
 * and the marker goes just after it.
 */
export function buildLadder(zones: readonly SheetZone[], referencePrice: number): LadderRow[] {
  const descending = [...zones].sort((a, b) => b.centre - a.centre);
  const rows: LadderRow[] = [];
  let placed = false;
  for (const zone of descending) {
    if (!placed && zone.centre < referencePrice && zone.position !== "AT") {
      rows.push({ kind: "REFERENCE", price: referencePrice });
      placed = true;
    }
    rows.push({ kind: "ZONE", zone });
    if (!placed && zone.position === "AT") {
      rows.push({ kind: "REFERENCE", price: referencePrice });
      placed = true;
    }
  }
  if (!placed) rows.push({ kind: "REFERENCE", price: referencePrice });
  return rows;
}

const points = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0, signDisplay: "exceptZero" });
const price = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatPrice(value: number): string {
  return price.format(value);
}

/** The zone as a price or a price range. */
export function formatZoneRange(zone: SheetZone): string {
  return zone.low === zone.high ? formatPrice(zone.low) : `${formatPrice(zone.low)} - ${formatPrice(zone.high)}`;
}

/** Distance of the zone's centre from the previous close, e.g. `+120 pts (+0.52%)`. */
export function formatDistance(zone: SheetZone): string {
  if (zone.position === "AT") return "at the close";
  const pct = `${zone.distancePct >= 0 ? "+" : ""}${zone.distancePct.toFixed(2)}%`;
  return `${points.format(zone.distancePoints)} pts (${pct})`;
}

/** How many different kinds of source meet in the zone. Two lines from one bar count as two kinds, which the page says in its note. */
export function confluenceText(zone: SheetZone): string {
  return zone.confluence <= 1 ? "single source" : `${zone.confluence} sources`;
}

export interface Freshness {
  state: "TODAY" | "UPCOMING" | "OLD";
  text: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A `YYYY-MM-DD` date as `Tue 3 Nov`, without time-zone drift (it is a calendar date, not an instant) and without depending on locale data. */
export function formatCalendarDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]}`;
}

/** Whether the sheet is for today (IST), a later session, or an older one that no longer applies. */
export function sheetFreshness(sessionDate: string, todayIst: string): Freshness {
  if (sessionDate === todayIst) return { state: "TODAY", text: `Sheet for today, ${formatCalendarDate(sessionDate)}.` };
  if (sessionDate > todayIst) return { state: "UPCOMING", text: `Sheet for the next session, ${formatCalendarDate(sessionDate)}.` };
  return { state: "OLD", text: `This is the sheet for ${formatCalendarDate(sessionDate)}, not today. A new one is built at 08:55 on trading days.` };
}

const percentPoints = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;

export function formatShare(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/** The difference and its 95% range in percentage points, or `n/a`. */
export function formatDifference(comparison: Pick<HistoryComparison, "difference" | "lower" | "upper">): string {
  if (comparison.difference === null || comparison.lower === null || comparison.upper === null) return "n/a";
  return `${percentPoints(comparison.difference)} (${percentPoints(comparison.lower)} to ${percentPoints(comparison.upper)})`;
}

/** Whether a comparison's interval excludes zero, so the page can mark the rare line that does. */
export function excludesZero(comparison: Pick<HistoryComparison, "lower" | "upper">): boolean {
  return comparison.lower !== null && comparison.upper !== null && (comparison.lower > 0 || comparison.upper < 0);
}

/** One horizontal line on the dashboard chart. */
export interface ChartLevel {
  price: number;
  label: string;
  /** Two or more kinds of source agree on this zone: drawn solid and heavier. */
  strong: boolean;
  /** `CLOSE` is the zone that holds the previous close; it is drawn neutral, the others take their colour from where they sit against price. */
  kind: "ZONE" | "CLOSE";
}

const SHORT_LABELS: Record<string, string> = {
  pdh: "PDH",
  pdl: "PDL",
  pdc: "Close",
  pivot: "P",
  "range-high": "5D high",
  "range-low": "5D low",
  "week-high": "Wk high",
  "week-low": "Wk low",
  "call-oi-wall": "Call OI",
  "put-oi-wall": "Put OI",
};

/** A short axis label for one line: `PDH`, `R2`, `S1`, `Call OI`, or the round number itself. */
export function levelShortLabel(level: Pick<SheetLevel, "key" | "label">): string {
  const known = SHORT_LABELS[level.key];
  if (known) return known;
  if (/^[rs][123]$/.test(level.key)) return level.key.toUpperCase();
  const round = /^round-(\d+)$/.exec(level.key);
  if (round) return new Intl.NumberFormat("en-IN").format(Number(round[1]));
  return level.label;
}

/** The first two short labels of a zone, then `+n` for the rest, e.g. `PDH · R1 +1`. */
export function zoneChartLabel(zone: Pick<SheetZone, "levels">): string {
  const labels = zone.levels.map(levelShortLabel);
  const shown = labels.slice(0, 2).join(" · ");
  return labels.length > 2 ? `${shown} +${labels.length - 2}` : shown;
}

export const CHART_LEVELS_PER_SIDE = 6;
export const CHART_LEVELS_MAX_DISTANCE_PCT = 3;

/**
 * The lines to draw on the chart: the zones nearest to the last price on each side, within a few percent of it (a line far outside the
 * visible range adds nothing), each at the centre of its zone. The zone holding the previous close is marked `CLOSE`. Ascending by price.
 */
export function chartLevelsFromZones(
  zones: readonly SheetZone[],
  lastPrice: number,
  options: { perSide?: number; maxDistancePct?: number } = {},
): ChartLevel[] {
  const perSide = options.perSide ?? CHART_LEVELS_PER_SIDE;
  const maxDistancePct = options.maxDistancePct ?? CHART_LEVELS_MAX_DISTANCE_PCT;
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return [];
  const near = zones
    .map((zone) => ({ zone, distance: Math.abs(zone.centre - lastPrice) }))
    .filter((entry) => (entry.distance / lastPrice) * 100 <= maxDistancePct)
    .sort((a, b) => a.distance - b.distance);
  const above = near.filter((entry) => entry.zone.centre > lastPrice).slice(0, perSide);
  const below = near.filter((entry) => entry.zone.centre <= lastPrice).slice(0, perSide);
  return [...above, ...below]
    .map(({ zone }): ChartLevel => ({
      price: zone.centre,
      label: zoneChartLabel(zone),
      strong: zone.confluence >= 2,
      kind: zone.levels.some((level) => level.key === "pdc") ? "CLOSE" : "ZONE",
    }))
    .sort((a, b) => a.price - b.price);
}
