/**
 * Types and pure drawing and wording rules for the volume profile. No React.
 *
 * The API (`/api/v1/volume-profile`) builds an ESTIMATED profile from 1-minute futures bars: each bar's volume is spread
 * evenly over its high-low range, so where inside a minute the volume traded is assumed, not observed. This module turns
 * that into coordinates and sentences, and keeps four promises:
 *
 * - **It says "estimated".** The word is on the screen wherever the profile is, not only in a footnote.
 * - **The resolution check is shown, not buried.** The same session rebuilt from 5-minute bars tells how far the POC and
 *   the value-area edges move; a level that moves a lot is called not well resolved, in words.
 * - **A partial or patchy session says so.** Missing minutes, zero-volume minutes and set-aside post-close bars are counted
 *   beside the picture.
 * - **A profile is not a forecast.** A POC or value-area edge describes where volume was estimated to trade; the text does
 *   not call any of them support, resistance or a target.
 */

export interface ProfileRowView {
  low: number;
  high: number;
  volume: number;
  inValueArea: boolean;
  isPoc: boolean;
}

export interface ProfileLevels {
  poc: number;
  vah: number;
  val: number;
}

export interface SensitivityView {
  comparedWithBarMinutes: number;
  agreement: number;
  pocShiftPoints: number;
  vahShiftPoints: number;
  valShiftPoints: number;
}

export interface QualityView {
  expectedMinutes: number;
  barsUsed: number;
  barsWithVolume: number;
  zeroVolumeBars: number;
  missingMinutes: number;
  outsideSessionBarsExcluded: number;
  complete: boolean;
}

export interface PreviousSessionView extends ProfileLevels {
  sessionDate: string;
  symbol: string;
  high: number;
  low: number;
  close: number;
  totalVolume: number;
  complete: boolean;
}

export interface ProfileSessionListing {
  sessionDate: string;
  symbol: string;
  bars: number;
  barsWithVolume: number;
  firstAt: string;
  lastAt: string;
  complete: boolean;
}

export interface VolumeProfileAvailable {
  available: true;
  underlying: string;
  contract: { symbol: string; providerSymbol: string; expiryDate: string; lotSize: number };
  sessionDate: string;
  inProgress: boolean;
  rowPoints: number;
  rowPointsChoices: number[];
  estimated: true;
  volumeUnit: string;
  session: { open: number; high: number; low: number; close: number; firstBarAt: string; lastBarAt: string } | null;
  profile: ProfileLevels & {
    rowPoints: number;
    rows: ProfileRowView[];
    totalVolume: number;
    valueAreaShare: number;
    vwap: number | null;
  };
  quality: QualityView;
  sensitivity: SensitivityView | null;
  previousSession: PreviousSessionView | null;
  /** `[epochMs, close]` for each regular-session minute. */
  closes: Array<[number, number]>;
  availableSessions: ProfileSessionListing[];
  definitions: Record<string, string>;
  source: string;
}

export interface VolumeProfileUnavailable {
  available: false;
  underlying: string;
  sessionDate?: string;
  frontMonth?: string;
  reason: string;
  availableSessions?: ProfileSessionListing[];
}

export type VolumeProfilePayload = VolumeProfileAvailable | VolumeProfileUnavailable;

export function volumeProfileQuery(input: { underlying: string; sessionDate: string; rowPoints: number | null }): string {
  const params = new URLSearchParams({ underlying: input.underlying });
  if (input.sessionDate) params.set("date", input.sessionDate);
  if (input.rowPoints !== null) params.set("rowPoints", String(input.rowPoints));
  return params.toString();
}

export interface DrawnRow {
  /** Top edge and height as fractions of the price range (0 at the top). */
  y: number;
  height: number;
  /** Bar length as a fraction of the largest row, 0-1. */
  width: number;
  volume: number;
  share: number;
  low: number;
  high: number;
  inValueArea: boolean;
  isPoc: boolean;
}

export interface ProfileGeometry {
  /** The price span of the drawing: the profile's rows from lowest bottom edge to highest top edge. */
  priceLow: number;
  priceHigh: number;
  rows: DrawnRow[];
  /** The closes as a line: x is the fraction of the 09:15-15:30 session, y the fraction of the price range. */
  closeLine: Array<{ x: number; y: number }>;
}

const SESSION_START_MINUTE_IST = 9 * 60 + 15;
const SESSION_MINUTES = 375;
const IST_OFFSET_MS = 330 * 60_000;

/** The price span and the rows' bars, and the closes as a line over the session clock. Empty when there are no rows. */
export function buildProfileGeometry(payload: VolumeProfileAvailable): ProfileGeometry {
  const rows = payload.profile.rows;
  if (rows.length === 0) return { priceLow: 0, priceHigh: 0, rows: [], closeLine: [] };
  const priceLow = rows[0]!.low;
  const priceHigh = rows[rows.length - 1]!.high;
  const span = priceHigh - priceLow;
  const largest = Math.max(...rows.map((row) => row.volume));
  const total = payload.profile.totalVolume;

  const drawn: DrawnRow[] = rows.map((row) => ({
    y: (priceHigh - row.high) / span,
    height: (row.high - row.low) / span,
    width: largest > 0 ? row.volume / largest : 0,
    volume: row.volume,
    share: total > 0 ? row.volume / total : 0,
    low: row.low,
    high: row.high,
    inValueArea: row.inValueArea,
    isPoc: row.isPoc,
  }));

  const closeLine = payload.closes.map(([at, close]) => {
    const minuteOfDay = Math.floor((at + IST_OFFSET_MS) / 60_000) % (24 * 60);
    return {
      x: Math.min(1, Math.max(0, (minuteOfDay - SESSION_START_MINUTE_IST) / SESSION_MINUTES)),
      y: (priceHigh - close) / span,
    };
  });
  return { priceLow, priceHigh, rows: drawn, closeLine };
}

/** Vertical position (fraction of the range, 0 at the top) of a price, or null when it falls outside the drawing. */
export function priceFraction(geometry: Pick<ProfileGeometry, "priceLow" | "priceHigh">, price: number): number | null {
  const span = geometry.priceHigh - geometry.priceLow;
  if (!(span > 0) || price < geometry.priceLow || price > geometry.priceHigh) return null;
  return (geometry.priceHigh - price) / span;
}

/** The row under a vertical position (fraction of the range, 0 at the top), or null outside it. */
export function rowAtFraction(rows: readonly DrawnRow[], fraction: number): DrawnRow | null {
  if (fraction < 0 || fraction >= 1) return null;
  return rows.find((row) => fraction >= row.y && fraction < row.y + row.height) ?? null;
}

function units(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

export function describeRow(row: DrawnRow): string {
  const tags = [row.isPoc ? "point of control" : null, row.inValueArea ? "inside the value area" : null].filter(Boolean);
  return `${row.low}–${row.high}: ${units(row.volume)} units, ${(row.share * 100).toFixed(1)}% of the session (estimated)`
    + `${tags.length > 0 ? `, ${tags.join(", ")}` : ""}.`;
}

export interface ResolutionNote {
  text: string;
  /** `warn` when the levels move a lot between bar sizes. */
  tone: "ok" | "warn";
}

function signed(points: number): string {
  const rounded = Math.round(points);
  return rounded === 0 ? "does not move" : `moves ${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} pts`;
}

/**
 * How well the data resolves the levels: the session rebuilt from coarser bars, in words. A level that moves by more than
 * two rows between bar sizes (or a profile that agrees on under 80% of the volume) is called not well resolved.
 */
export function describeResolution(sensitivity: SensitivityView | null, rowPoints: number): ResolutionNote | null {
  if (sensitivity === null) return null;
  const limit = 2 * rowPoints;
  const loose = [
    Math.abs(sensitivity.pocShiftPoints) > limit ? "POC" : null,
    Math.abs(sensitivity.vahShiftPoints) > limit ? "VAH" : null,
    Math.abs(sensitivity.valShiftPoints) > limit ? "VAL" : null,
  ].filter((name): name is string => name !== null);
  const text = `Rebuilt from ${sensitivity.comparedWithBarMinutes}-minute bars, ${(sensitivity.agreement * 100).toFixed(0)}% of the volume lands in the same rows; `
    + `the POC ${signed(sensitivity.pocShiftPoints)}, VAH ${signed(sensitivity.vahShiftPoints)}, VAL ${signed(sensitivity.valShiftPoints)}.`
    + `${loose.length > 0 ? ` ${loose.join(" and ")} ${loose.length > 1 ? "are" : "is"} not well resolved by 1-minute bars: read ${loose.length > 1 ? "them" : "it"} as a zone, not a price.` : ""}`;
  return { text, tone: loose.length > 0 || sensitivity.agreement < 0.8 ? "warn" : "ok" };
}

export interface ProfileNote {
  tone: "info" | "warn";
  text: string;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
}

/** What the picture stands on, in words. Quiet for a clean, complete session. */
export function qualityNotes(payload: VolumeProfileAvailable): ProfileNote[] {
  const { quality, session } = payload;
  const notes: ProfileNote[] = [];
  if (!quality.complete) {
    notes.push({
      tone: "warn",
      text: `Partial session: ${quality.barsUsed} of ${quality.expectedMinutes} regular minutes are stored`
        + `${session ? ` (last bar ${clock(session.lastBarAt)} IST)` : ""}. The profile covers only those minutes`
        + `${payload.inProgress ? " and will change as the session continues" : ""}.`,
    });
  } else if (quality.missingMinutes > 0) {
    notes.push({
      tone: "info",
      text: quality.missingMinutes === 1
        ? "1 regular minute has no bar and adds nothing to the profile."
        : `${quality.missingMinutes} regular minutes have no bar and add nothing to the profile.`,
    });
  }
  if (quality.zeroVolumeBars > 0) {
    notes.push({
      tone: "info",
      text: quality.zeroVolumeBars === 1
        ? "1 minute traded nothing (flat, zero volume) and adds nothing."
        : `${quality.zeroVolumeBars} minutes traded nothing (flat, zero volume) and add nothing.`,
    });
  }
  if (quality.outsideSessionBarsExcluded > 0) {
    notes.push({ tone: "info", text: `${quality.outsideSessionBarsExcluded} bars outside 09:15–15:30 IST (the post-close minutes) were set aside.` });
  }
  return notes;
}

/** The previous session's levels as a sentence, or null. Says whether that day was complete. */
export function previousSessionSentence(previous: PreviousSessionView | null): string | null {
  if (previous === null) return null;
  return `Previous session ${previous.sessionDate} (${previous.symbol.replace(/FUT$/, " future")}): POC ${previous.poc.toLocaleString("en-IN")}, `
    + `value area ${previous.val.toLocaleString("en-IN")}–${previous.vah.toLocaleString("en-IN")}, `
    + `range ${previous.low.toLocaleString("en-IN")}–${previous.high.toLocaleString("en-IN")}`
    + `${previous.complete ? "" : " (partial day)"}. Same row height; also estimated.`;
}

export function profileSessionLabel(session: ProfileSessionListing): string {
  return `${session.sessionDate} · ${clock(session.firstAt)}–${clock(session.lastAt)} IST${session.complete ? "" : " · partial"}`;
}
