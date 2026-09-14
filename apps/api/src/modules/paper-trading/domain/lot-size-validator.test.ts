import { describe, expect, it } from "vitest";
import {
  lotsToQuantity,
  nearestValidQuantity,
  quantityToLots,
  validateQuantity,
} from "./lot-size-validator.js";

describe("lot-size-validator", () => {
  it("accepts NIFTY multiples of 75 and rejects others", () => {
    expect(() => validateQuantity(75, 75)).not.toThrow();
    expect(() => validateQuantity(150, 75)).not.toThrow();
    expect(() => validateQuantity(50, 75)).toThrow(/lot size 75/);
  });

  it("accepts BANKNIFTY multiples of 15 and rejects others", () => {
    expect(() => validateQuantity(15, 15)).not.toThrow();
    expect(() => validateQuantity(10, 15)).toThrow(/lot size 15/);
  });

  it("converts lots ↔ quantity", () => {
    expect(lotsToQuantity(2, 75)).toBe(150);
    expect(quantityToLots(150, 75)).toBe(2);
  });

  it("snaps desired size to the nearest lot multiple", () => {
    expect(nearestValidQuantity(40, 75)).toBe(75);
    expect(nearestValidQuantity(100, 75)).toBe(75);
    expect(nearestValidQuantity(120, 75)).toBe(150);
    expect(nearestValidQuantity(0, 15)).toBe(15);
  });

  it("rejects zero, negative, and non-integer inputs", () => {
    expect(() => validateQuantity(0, 75)).toThrow();
    expect(() => validateQuantity(-75, 75)).toThrow();
    expect(() => validateQuantity(75.5, 75)).toThrow();
    expect(() => lotsToQuantity(0, 75)).toThrow();
  });
});
