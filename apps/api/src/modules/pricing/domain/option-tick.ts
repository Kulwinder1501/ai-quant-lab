/**
 * NSE quotes option premiums in 5-paise steps, so 0.05 is the lowest price at which a
 * live contract can actually trade.
 *
 * Shared because entry and evaluation were applying it inconsistently: the entry mapper
 * floored its premiums here while the live mark did not, so a position could be opened at
 * 0.05 and later marked — and exited — at a premium no exchange would quote.
 */
export const OPTION_TICK_SIZE = 0.05;

/**
 * Floors a **live** premium to the lowest tradable quote.
 *
 * Deliberately not applied at or after expiry. A contract that expires out of the money
 * settles at zero, and zero is the true number there; forcing it to 0.05 would invent
 * value in exactly the case where the option is worthless, and would also make a
 * worthless expiry look like a 5-paise sale rather than a lapse.
 */
export function floorLivePremiumToTick(premium: number, timeToExpiryYears: number): number {
  if (!Number.isFinite(premium) || premium < 0) {
    throw new Error("Premium must be zero or a positive finite number.");
  }
  if (timeToExpiryYears <= 0) {
    return premium;
  }
  return Math.max(OPTION_TICK_SIZE, premium);
}
