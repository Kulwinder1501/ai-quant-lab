/**
 * NSE F&O lot-size helpers. Quantity is absolute units; a "lot" is `lotSize` units.
 */

function assertPositiveIntegerLotSize(lotSize: number): void {
  if (!Number.isInteger(lotSize) || lotSize <= 0) {
    throw new Error("Lot size must be a positive integer.");
  }
}

/** Throws when quantity is not a positive multiple of the instrument lot size. */
export function validateQuantity(quantity: number, lotSize: number): void {
  assertPositiveIntegerLotSize(lotSize);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive integer number of units.");
  }
  if (quantity % lotSize !== 0) {
    throw new Error(
      `Quantity ${quantity} is not a multiple of lot size ${lotSize}. Use ${lotsToQuantity(1, lotSize)} units (1 lot) or another lot multiple.`,
    );
  }
}

/** Snaps a desired unit count to the nearest positive lot multiple (ties round up). */
export function nearestValidQuantity(desired: number, lotSize: number): number {
  assertPositiveIntegerLotSize(lotSize);
  if (!Number.isFinite(desired) || desired <= 0) {
    return lotSize;
  }
  const lots = Math.max(1, Math.round(desired / lotSize));
  return lots * lotSize;
}

/** Converts a lot count into absolute quantity. */
export function lotsToQuantity(lots: number, lotSize: number): number {
  assertPositiveIntegerLotSize(lotSize);
  if (!Number.isInteger(lots) || lots <= 0) {
    throw new Error("Lot count must be a positive integer.");
  }
  return lots * lotSize;
}

/** Absolute units → whole lots (throws if not an exact multiple). */
export function quantityToLots(quantity: number, lotSize: number): number {
  validateQuantity(quantity, lotSize);
  return quantity / lotSize;
}
