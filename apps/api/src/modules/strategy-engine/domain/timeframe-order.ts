/**
 * Ordering over timeframe labels, so "higher timeframe" can be checked rather than assumed.
 *
 * Higher-timeframe confluence is only meaningful if the attached bar is genuinely slower than the
 * bar being decided. Without an ordering the check degrades to a string compare, under which "5m"
 * is not equal to "5m" only by luck of spelling, and "15m" < "5m" lexicographically -- so a 15m
 * signal would happily accept a 5m "higher" timeframe. Both mistakes are silent: they produce a
 * confluence score that looks computed and means nothing.
 */

/** Milliseconds in one bar of `timeframe`, or null when the label is not one we understand. */
export function timeframeMilliseconds(timeframe: string): number | null {
  const match = /^(\d+)(m|h|d)$/.exec(timeframe.trim());
  if (!match) return null;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return null;
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return magnitude * unit;
}

/**
 * True when `candidate` is strictly slower than `base`.
 *
 * Strict on purpose. An equal timeframe is not confluence -- it is the same bar wearing a second
 * hat, and scoring a signal against itself manufactures agreement out of nothing. An unparseable
 * label returns false rather than throwing: the caller's contract is that a timeframe it cannot
 * place is simply not attached, which keeps a new label inert instead of crashing idea generation.
 */
export function isStrictlyHigherTimeframe(base: string, candidate: string): boolean {
  const baseMs = timeframeMilliseconds(base);
  const candidateMs = timeframeMilliseconds(candidate);
  if (baseMs === null || candidateMs === null) return false;
  return candidateMs > baseMs;
}
