/**
 * A run that completed but did not collect everything, written down where the run history can see it. Pure.
 *
 * One option-chain run covers several underlyings and exits 0 whenever any of them succeeds, so a run in which one underlying
 * failed is recorded as COMPLETED with nothing to say so. That hid the NIFTY50 gap of 2026-09-30 to 2026-10-05 for six days: every
 * run "completed" while no NIFTY50 chain was being stored. The status is deliberately unchanged (a run that stored three of four
 * chains is not a failed run, and a FAILED status would start the Fyers cooldown machinery against a healthy broker). Instead the
 * collector prints one short line naming the failed underlyings, the scheduler keeps that line against the COMPLETED run, and the
 * data-coverage view reads it back.
 *
 * The note is the text `PARTIAL ` followed by a small JSON object, bounded in size, so that the run table's `error_details` column
 * (which for a FAILED run holds the failure text) holds a machine-readable note for a COMPLETED one.
 */

export interface PartialFailure {
  underlyingSymbol: string;
  reason: string;
}

export const PARTIAL_NOTE_PREFIX = "PARTIAL ";
export const PARTIAL_LINE_MESSAGE = "Option-chain collection partial";

/** Bounds, so a note cannot grow with the provider's error text. */
const MAX_FAILURES = 10;
const MAX_REASON_CHARS = 200;

function bounded(failures: readonly PartialFailure[]): PartialFailure[] {
  return failures.slice(0, MAX_FAILURES).map((failure) => ({
    underlyingSymbol: failure.underlyingSymbol,
    reason: failure.reason.length > MAX_REASON_CHARS ? `${failure.reason.slice(0, MAX_REASON_CHARS)}…` : failure.reason,
  }));
}

/**
 * The line the collector prints when it stored at least one chain and also had failures. Null when nothing failed, and null when
 * nothing at all was stored (that is a failed run, which the exit code already reports with its own text).
 */
export function partialRunLine(result: { chains: readonly unknown[]; failures: readonly PartialFailure[] }): string | null {
  if (result.failures.length === 0 || result.chains.length === 0) return null;
  return JSON.stringify({ level: "warn", message: PARTIAL_LINE_MESSAGE, failures: bounded(result.failures) });
}

/** The note to keep against a completed run, from the end of the collector's output; null when it printed no partial line. */
export function partialFailureNote(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{") || !line.includes(PARTIAL_LINE_MESSAGE)) continue;
    try {
      const parsed = JSON.parse(line) as { message?: unknown; failures?: unknown };
      if (parsed.message !== PARTIAL_LINE_MESSAGE || !Array.isArray(parsed.failures)) continue;
      const failures = parsed.failures.filter(
        (entry): entry is PartialFailure => typeof entry?.underlyingSymbol === "string" && typeof entry?.reason === "string",
      );
      if (failures.length === 0) return null;
      return `${PARTIAL_NOTE_PREFIX}${JSON.stringify({ failures: bounded(failures) })}`;
    } catch {
      // A line cut off by the capture's tail is not a note; keep looking at earlier lines.
    }
  }
  return null;
}

/** The failures in a stored note, or null when the text is not a partial-run note. */
export function parsePartialNote(note: string | null): PartialFailure[] | null {
  if (note === null || !note.startsWith(PARTIAL_NOTE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(note.slice(PARTIAL_NOTE_PREFIX.length)) as { failures?: unknown };
    if (!Array.isArray(parsed.failures)) return null;
    return parsed.failures.filter(
      (entry): entry is PartialFailure => typeof entry?.underlyingSymbol === "string" && typeof entry?.reason === "string",
    );
  } catch {
    return null;
  }
}

/**
 * The underlying a failure belongs to. A tradable-expiry failure is reported as `NIFTY50 (tradable expiry 2026-10-27)`, which is the
 * same underlying's second book failing, not a different underlying.
 */
export function baseUnderlying(underlyingSymbol: string): string {
  const cut = underlyingSymbol.indexOf(" (");
  return cut === -1 ? underlyingSymbol : underlyingSymbol.slice(0, cut);
}
