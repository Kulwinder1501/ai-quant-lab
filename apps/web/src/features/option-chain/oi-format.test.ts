import { describe, expect, it } from "vitest";
import { compactUnits, formatIstTime, istDateKey, oiAxisFormatter, signedCompact } from "./oi-format";

describe("compactUnits", () => {
  it("uses Indian-numbering shorthand", () => {
    expect(compactUnits(950)).toBe("950");
    expect(compactUnits(12_500)).toBe("12.5k");
    expect(compactUnits(2_500_000)).toBe("25.00L");
    expect(compactUnits(74_599_470)).toBe("7.46Cr");
  });

  it("shows a missing value as an em dash, distinct from zero", () => {
    expect(compactUnits(null)).toBe("—");
    expect(compactUnits(Number.NaN)).toBe("—");
    expect(compactUnits(0)).toBe("0");
  });
});

describe("signedCompact", () => {
  it("puts an explicit plus on gains and leaves losses and zero alone", () => {
    expect(signedCompact(1_500)).toBe("+1.5k");
    expect(signedCompact(-1_500)).toBe("-1.5k");
    expect(signedCompact(0)).toBe("0");
    expect(signedCompact(null)).toBe("—");
  });
});

describe("formatIstTime", () => {
  it("renders the IST clock for a UTC instant", () => {
    expect(formatIstTime(Date.parse("2026-10-12T03:53:00.000Z"))).toBe("09:23");
    // 20:00Z is 01:30 IST the next day.
    expect(formatIstTime(Date.parse("2026-10-12T20:00:00.000Z"))).toBe("01:30");
    expect(formatIstTime(Number.NaN)).toBe("—");
  });
});

describe("istDateKey", () => {
  it("returns the IST calendar day, including across the UTC date line", () => {
    expect(istDateKey(Date.parse("2026-10-12T03:53:00.000Z"))).toBe("2026-10-12");
    // 20:00Z on the 12th is already 01:30 IST on the 13th.
    expect(istDateKey(Date.parse("2026-10-12T20:00:00.000Z"))).toBe("2026-10-13");
  });
});

describe("oiAxisFormatter", () => {
  it("uses a single unit for every tick, so one scale is never written two ways", () => {
    const format = oiAxisFormatter(14_000_000, false);
    expect([14_000_000, 10_500_000, 7_000_000, 3_500_000].map(format)).toEqual(["1.40Cr", "1.05Cr", "0.70Cr", "0.35Cr"]);
    expect(format(0)).toBe("0");
  });

  it("scales down to lakhs, thousands and plain numbers with the magnitude on screen", () => {
    expect(oiAxisFormatter(450_000, false)(250_000)).toBe("2.50L");
    expect(oiAxisFormatter(45_000, false)(25_000)).toBe("25.00k");
    expect(oiAxisFormatter(900, false)(250)).toBe("250");
  });

  it("puts an explicit plus on gains for signed axes and leaves losses with their minus", () => {
    const format = oiAxisFormatter(12_000_000, true);
    expect(format(4_000_000)).toBe("+0.40Cr");
    expect(format(-4_000_000)).toBe("-0.40Cr");
    expect(oiAxisFormatter(12_000_000, false)(4_000_000)).toBe("0.40Cr");
    // Below one crore on screen, the same value is written in lakhs: the unit follows the axis maximum.
    expect(oiAxisFormatter(8_000_000, true)(4_000_000)).toBe("+40.00L");
  });

  it("drops decimals once the scaled value reaches three digits", () => {
    expect(oiAxisFormatter(1_500_000_000, false)(1_200_000_000)).toBe("120Cr");
  });
});
