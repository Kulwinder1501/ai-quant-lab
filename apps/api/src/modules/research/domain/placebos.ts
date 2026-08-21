import { createSeededRandom } from "./information-coefficient.js";

/**
 * Label-destroying transforms whose measured IC must be indistinguishable from zero.
 *
 * A placebo is the only cheap defence against the failure mode that has repeatedly bitten this
 * project: a pipeline that reports an edge which is really an artefact of alignment, ordering or
 * leakage. If a feature scores just as well after its relationship to the return has been
 * destroyed, then the score is measuring the harness, not the market.
 *
 * ## Why four, and why they are not interchangeable
 *
 * Each one destroys a *different* thing, so each catches a different bug. Running only one is close
 * to running none.
 *
 * - **Sign flip** destroys directional content while preserving magnitude and timing exactly. A
 *   surviving IC means the score is driven by *when* the feature is large rather than by which way
 *   it points — which is how a volatility proxy masquerades as a directional signal.
 * - **Block permutation** preserves short-range autocorrelation inside each block and destroys
 *   alignment between blocks. A surviving IC means an autocorrelated feature is being scored against
 *   an autocorrelated return and the correlation is a property of both series' persistence rather
 *   than of any relationship. This is the placebo most likely to fire on order-flow data, because
 *   both book imbalance and short-horizon returns are strongly autocorrelated.
 * - **Circular shift** moves the feature far from its return while keeping the series otherwise
 *   completely intact — same values, same order, same distribution. A surviving IC is close to proof
 *   of an alignment or off-by-one bug in the joining code.
 * - **Wrong day, matched time of day** keeps the intraday profile and swaps which day it came from.
 *   A surviving IC means the score reflects time-of-day seasonality — the open being volatile, the
 *   pre-close being directional — rather than anything the feature knows. Intraday NSE data has a
 *   strong U-shaped profile, so this is a live risk rather than a theoretical one.
 *
 * All of them are seeded. A placebo that cannot be reproduced cannot be argued about, and an
 * unreproducible band is worse than none because it invites re-rolling until the real signal clears.
 */

export interface TimestampedValue {
  readonly at: Date;
  readonly value: number;
}

/** Randomly negates each value. Magnitudes and positions are untouched. */
export function signFlipped(values: readonly number[], seed: number): number[] {
  const random = createSeededRandom(seed);
  return values.map((value) => (random() < 0.5 ? -value : value));
}

/**
 * Splits the series into contiguous blocks and permutes the blocks.
 *
 * Within-block structure survives; between-block alignment does not. A trailing partial block is
 * kept and permuted with the rest — dropping it would shorten the placebo relative to the real
 * series and make the two ICs incomparable on sample size alone.
 */
export function blockPermuted(values: readonly number[], blockSize: number, seed: number): number[] {
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new Error("blockSize must be a positive integer.");
  }
  if (values.length === 0) return [];

  const blocks: number[][] = [];
  for (let start = 0; start < values.length; start += blockSize) {
    blocks.push(values.slice(start, Math.min(start + blockSize, values.length)));
  }

  const random = createSeededRandom(seed);
  // Fisher-Yates, so every ordering is equally likely.
  for (let index = blocks.length - 1; index > 0; index -= 1) {
    const swapWith = Math.min(index, Math.floor(random() * (index + 1)));
    const held = blocks[index]!;
    blocks[index] = blocks[swapWith]!;
    blocks[swapWith] = held;
  }

  return blocks.flat();
}

/**
 * Rotates the series by `shift` positions, wrapping around.
 *
 * The shift should be large relative to the feature's autocorrelation length, or the rotated series
 * still overlaps its own structure and the placebo is weaker than it looks.
 */
export function circularShifted(values: readonly number[], shift: number): number[] {
  if (values.length === 0) return [];
  const length = values.length;
  // Normalise into [0, length) so a negative or oversized shift behaves rather than producing holes.
  const offset = ((Math.trunc(shift) % length) + length) % length;
  if (offset === 0) return [...values];
  return [...values.slice(offset), ...values.slice(0, offset)];
}

/** IST minutes since midnight, bucketed. NSE sessions never cross midnight IST, so this is stable. */
function timeOfDayBucket(at: Date, bucketMinutes: number): number {
  const istMinutes = Math.floor((at.getTime() + (5 * 60 + 30) * 60_000) / 60_000) % (24 * 60);
  return Math.floor(istMinutes / bucketMinutes);
}

function istDay(at: Date): string {
  return new Date(at.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

/**
 * Permutes values only among observations sharing a time-of-day bucket, across different days.
 *
 * Returns values in the original observation order, so the result stays aligned with whatever return
 * series the caller is scoring against. Buckets holding observations from fewer than two distinct
 * days are left untouched: there is no other day to swap with, and inventing one would fabricate
 * data rather than shuffle it.
 */
export function wrongDayMatchedTime(
  observations: readonly TimestampedValue[],
  seed: number,
  bucketMinutes = 15,
): number[] {
  if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1) {
    throw new Error("bucketMinutes must be a positive integer.");
  }

  const byBucket = new Map<number, number[]>();
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    if (!(observation.at instanceof Date) || Number.isNaN(observation.at.getTime())) continue;
    const bucket = timeOfDayBucket(observation.at, bucketMinutes);
    const members = byBucket.get(bucket);
    if (members) members.push(index);
    else byBucket.set(bucket, [index]);
  }

  const random = createSeededRandom(seed);
  const result = observations.map((observation) => observation.value);

  for (const members of byBucket.values()) {
    const distinctDays = new Set(members.map((index) => istDay(observations[index]!.at)));
    if (members.length < 2 || distinctDays.size < 2) continue;

    const pool = members.map((index) => observations[index]!.value);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swapWith = Math.min(index, Math.floor(random() * (index + 1)));
      const held = pool[index]!;
      pool[index] = pool[swapWith]!;
      pool[swapWith] = held;
    }
    for (let slot = 0; slot < members.length; slot += 1) {
      result[members[slot]!] = pool[slot]!;
    }
  }

  return result;
}
