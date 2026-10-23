/**
 * Display formatting shared by the open-interest charts. Pure.
 *
 * Open interest runs to crores, so values use Indian-numbering shorthand. A missing value is an em dash
 * and never "0": the two mean different things and a chart must not blur them.
 */

export function compactUnits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

/** As `compactUnits`, with an explicit plus sign on gains so direction does not rely on colour. */
export function signedCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${compactUnits(value)}`;
}

/** `HH:MM` on the IST clock for an epoch-millisecond instant. India has no daylight saving. */
export function formatIstTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "—";
  return new Date(epochMs).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

/**
 * The IST calendar day (`YYYY-MM-DD`) of an instant. Used to tell the live session from a historical
 * one: snapshot age only means "delay" for today's session.
 */
export function istDateKey(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * A tick formatter that uses ONE unit for the whole axis, chosen from the largest magnitude shown.
 *
 * `compactUnits` picks a unit per value, which on a single axis produced 1.40Cr, 1.05Cr, 70.00L, 35.00L:
 * the same scale written in two units, which reads as unevenly spaced ticks. Zero is a bare "0".
 */
export function oiAxisFormatter(maxAbs: number, signed: boolean): (value: number) => string {
  const [divisor, suffix] = maxAbs >= 1e7 ? [1e7, "Cr"] : maxAbs >= 1e5 ? [1e5, "L"] : maxAbs >= 1e3 ? [1e3, "k"] : [1, ""];
  return (value: number): string => {
    if (!Number.isFinite(value)) return "—";
    if (value === 0) return "0";
    const scaled = value / divisor;
    const text = divisor === 1 || Math.abs(scaled) >= 100 ? scaled.toFixed(0) : scaled.toFixed(2);
    return `${signed && value > 0 ? "+" : ""}${text}${suffix}`;
  };
}
