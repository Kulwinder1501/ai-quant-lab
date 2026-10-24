/**
 * How a session's POC and value area develop through the day. Pure.
 *
 * At each checkpoint (every `stepMinutes` from 09:15) the volume profile is rebuilt from the bars that opened before it, with
 * the same rows and the same definitions as the session profile (`buildSessionProfile`), so the last checkpoint of a complete
 * session is exactly that session's profile. It is therefore the same ESTIMATE as the profile (each bar's volume spread evenly
 * over its range), and two further limits belong to it:
 *
 * - **Early checkpoints rest on little.** The 09:30 profile is fifteen minutes of bars; its POC and value area are what those
 *   minutes did, not where the day's volume will sit. Every point carries the bars and volume it stands on and the share of
 *   the checkpoint window that has bars.
 * - **A move smaller than the resolution is not a move.** The profile cannot place the POC better than about two rows
 *   (see `profileSensitivity`), so a shift between checkpoints is reported in points and left to the screen to call within or
 *   beyond that resolution.
 *
 * A checkpoint with no new bar since the previous one has no new information and is reported as such (`newBars: 0`), not drawn as
 * a flat continuation: a session in progress, or a hole in the stored bars, must not look like a market that stood still.
 */
import {
  SESSION_CLOSE_MINUTE_IST,
  SESSION_OPEN_MINUTE_IST,
  buildSessionProfile,
  type FuturesBar,
} from "./session-volume-profile.js";

export const DEVELOPING_STEP_CHOICES = [15, 30, 60] as const;

const IST_OFFSET_MS = 330 * 60_000;

export interface DevelopingPoint {
  /** The checkpoint: bars that opened before this minute (minutes since midnight IST) are in the profile. */
  atMinute: number;
  /** Bars (distinct minutes) in the profile so far, and how many were expected from the open to the checkpoint. */
  barsUsed: number;
  expectedBars: number;
  /** Bars that opened since the previous checkpoint. Zero means no new information. */
  newBars: number;
  /** Null levels: nothing had traded by then, or no bar was stored. */
  totalVolume: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  vwap: number | null;
  /** Close of the last bar in the profile. */
  lastClose: number | null;
  /** The profile covers every minute from the open to the checkpoint. */
  complete: boolean;
}

function minuteOfDay(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** The profile's levels at each checkpoint. Expects regular-session bars of one day. */
export function developingProfile(regular: readonly FuturesBar[], rowPoints: number, stepMinutes: number): DevelopingPoint[] {
  if (!Number.isInteger(stepMinutes) || stepMinutes <= 0) throw new Error("stepMinutes must be a positive whole number.");
  const ordered = [...regular].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const points: DevelopingPoint[] = [];
  let previousBars = 0;
  for (let at = SESSION_OPEN_MINUTE_IST + stepMinutes; ; at += stepMinutes) {
    const checkpoint = Math.min(at, SESSION_CLOSE_MINUTE_IST);
    // A repeated minute is counted once, the first, so a duplicated row cannot inflate the profile.
    const seen = new Set<number>();
    const included: FuturesBar[] = [];
    for (const bar of ordered) {
      const minute = minuteOfDay(bar.openTime);
      if (minute >= checkpoint || minute < SESSION_OPEN_MINUTE_IST || seen.has(minute)) continue;
      seen.add(minute);
      included.push(bar);
    }
    const profile = buildSessionProfile(included, rowPoints);
    const last = included[included.length - 1];
    points.push({
      atMinute: checkpoint,
      barsUsed: included.length,
      expectedBars: checkpoint - SESSION_OPEN_MINUTE_IST,
      newBars: included.length - previousBars,
      totalVolume: profile?.totalVolume ?? null,
      poc: profile?.poc ?? null,
      vah: profile?.vah ?? null,
      val: profile?.val ?? null,
      vwap: profile?.vwap ?? null,
      lastClose: last?.close ?? null,
      complete: included.length === checkpoint - SESSION_OPEN_MINUTE_IST,
    });
    previousBars = included.length;
    if (checkpoint >= SESSION_CLOSE_MINUTE_IST) break;
  }
  return points;
}

export const DEVELOPING_VALUE_DEFINITIONS = {
  what: "The session's volume profile rebuilt at each checkpoint from the bars that opened before it, with the same rows and definitions as the session profile. The last checkpoint of a complete session is that session's profile.",
  estimate: "Estimated, not observed, like the profile: each bar's volume is spread evenly over its high-low range.",
  early: "Early checkpoints rest on few minutes: they show what those minutes did, not where the day's volume will sit.",
  resolution: "The profile cannot place the POC better than about two rows, so a shift smaller than that between checkpoints is within the resolution, not a move.",
  noNewInformation: "A checkpoint with no new bar since the previous one is left blank: a session in progress, or a hole in the stored bars, must not read as a market that stood still.",
  notSignal: "Where value developed describes the session so far; it is not support, resistance or a forecast.",
} as const;
