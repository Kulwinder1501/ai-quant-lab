import { describe, expect, it } from "vitest";
import type { GreeksStrikeInput } from "./build-greeks-by-strike";
import type { StrikeRow } from "./live-chain";
import {
  buildSkew,
  daysToExpiryOf,
  formatPoints,
  historySentence,
  ivAtDelta,
  skewSentence,
  type Skew,
  type SessionSkew,
} from "./iv-skew";

/** Synthetic legs, hand-built for the arithmetic below (not a recorded chain). */
const leg = (iv: number | null, delta: number | null) => ({
  impliedVolatility: iv, impliedVolatilityRefusal: iv === null ? "NO_SOLUTION" : null, delta, gamma: null, theta: null, vega: null, vendorGreeks: null,
});

/** call (delta, IV) and put (delta, IV) by strike; the put's delta is negative, as stored. */
function chain(rows: Array<[number, [number | null, number | null], [number | null, number | null]]>): GreeksStrikeInput[] {
  return rows.map(([strikePrice, [cd, ci], [pd, pi]]) => ({ strikePrice, call: leg(ci, cd), put: leg(pi, pd) }));
}

const smile = chain([
  [90, [0.85, 0.20], [-0.12, 0.23]],
  [100, [0.65, 0.18], [-0.20, 0.21]],
  [110, [0.45, 0.16], [-0.32, 0.19]],
  [120, [0.30, 0.15], [-0.55, 0.17]],
  [130, [0.18, 0.14], [-0.75, 0.16]],
]);

describe("ivAtDelta", () => {
  it("interpolates linearly in delta between the two contracts that straddle it", () => {
    // Calls 0.30 (IV 0.15) and 0.18 (IV 0.14): at 0.25, 5/12 of the way, so 0.15 - (5/12)(0.01) = 0.1458333.
    const call = ivAtDelta(smile, "call", 0.25);
    expect(call.iv).toBeCloseTo(0.1458333, 6);
    expect(call.between).toEqual([120, 130]);
    // Puts |0.20| (IV 0.21) and |0.32| (IV 0.19): 5/12 of the way, 0.21 - (5/12)(0.02) = 0.2016667.
    expect(ivAtDelta(smile, "put", 0.25).iv).toBeCloseTo(0.2016667, 6);
    // Call 0.5 between 0.65 (0.18) and 0.45 (0.16): 3/4 of the way, 0.18 - 0.015 = 0.165.
    expect(ivAtDelta(smile, "call", 0.5).iv).toBeCloseTo(0.165, 9);
  });

  it("returns a contract that sits exactly on the target, and refuses when two do", () => {
    const exact = chain([[100, [0.4, 0.17], [-0.3, 0.2]], [110, [0.25, 0.16], [-0.4, 0.19]], [120, [0.1, 0.15], [-0.6, 0.18]]]);
    expect(ivAtDelta(exact, "call", 0.25)).toMatchObject({ iv: 0.16, between: [110, 110] });
    const twice = chain([[100, [0.25, 0.17], [-0.3, 0.2]], [110, [0.25, 0.16], [-0.4, 0.19]]]);
    expect(ivAtDelta(twice, "call", 0.25).refusal).toContain("hit exactly by more than one call");
  });

  it("refuses, and says how far the stored deltas reach, when none straddles the target", () => {
    const shallow = chain([[100, [0.85, 0.2], [-0.12, 0.23]], [110, [0.45, 0.16], [-0.2, 0.21]]]);
    const call = ivAtDelta(shallow, "call", 0.25);
    expect(call.iv).toBeNull();
    expect(call.refusal).toBe("No two solved calls straddle call |delta| 0.25: the stored call deltas reach 0.45 to 0.85.");
  });

  it("refuses when more than one pair straddles it, because delta is not monotone in strike", () => {
    // 0.30, 0.20, 0.28, 0.18: 0.25 lies between the first and second, the second and third, and the third and fourth.
    const zigzag = chain([[100, [0.3, 0.17], [-0.3, 0.2]], [110, [0.2, 0.16], [-0.4, 0.19]], [120, [0.28, 0.15], [-0.5, 0.18]], [130, [0.18, 0.14], [-0.6, 0.17]]]);
    expect(ivAtDelta(zigzag, "call", 0.25).refusal).toContain("straddled by more than one pair of calls");
  });

  it("refuses a stretch wider than 0.20 of delta, and a contract with no solved IV widens the stretch rather than being filled in", () => {
    // Without the 120 call, 0.25 lies between 110 (0.45) and 130 (0.18): 0.27 apart.
    const missing = chain([
      [100, [0.65, 0.18], [-0.2, 0.21]], [110, [0.45, 0.16], [-0.32, 0.19]], [120, [null, null], [-0.55, 0.17]], [130, [0.18, 0.14], [-0.75, 0.16]],
    ]);
    const call = ivAtDelta(missing, "call", 0.25);
    expect(call.iv).toBeNull();
    expect(call.refusal).toBe("The calls straddling call |delta| 0.25 (110 and 130) are 0.27 of delta apart, wider than the 0.20 allowed.");
  });

  it("refuses a side with fewer than two solved contracts", () => {
    expect(ivAtDelta(chain([[100, [0.4, 0.17], [-0.3, 0.2]]]), "call", 0.25).refusal).toContain("Fewer than two solved calls");
    expect(ivAtDelta([], "put", 0.25).iv).toBeNull();
  });
});

describe("buildSkew", () => {
  it("gives the risk reversal and butterfly in volatility points", () => {
    const skew = buildSkew(smile);
    // Risk reversal: (0.1458333 - 0.2016667) x 100 = -5.5833.
    expect(skew.riskReversal).toBeCloseTo(-5.58333, 4);
    // Butterfly: ((0.1458333 + 0.2016667) / 2 - 0.165) x 100 = 0.875.
    expect(skew.butterfly).toBeCloseTo(0.875, 6);
  });

  it("has a risk reversal without a butterfly when only the middle is missing, and neither when a wing is", () => {
    const noMiddle = chain([
      [100, [0.6, 0.18], [-0.2, 0.21]], [110, [0.55, 0.17], [-0.32, 0.19]], [120, [0.3, 0.15], [-0.55, 0.17]], [130, [0.18, 0.14], [-0.75, 0.16]],
    ]);
    const partial = buildSkew(noMiddle);
    expect(partial.middle.iv).toBeNull();
    expect(partial.riskReversal).not.toBeNull();
    expect(partial.butterfly).toBeNull();
    const noPutWing = buildSkew(chain([[100, [0.6, 0.18], [-0.9, 0.21]], [110, [0.3, 0.15], [-0.95, 0.19]], [120, [0.18, 0.14], [-0.99, 0.17]]]));
    expect(noPutWing.riskReversal).toBeNull();
    expect(noPutWing.butterfly).toBeNull();
  });
});

describe("formatting and sentences", () => {
  it("signs a value after rounding it, so a value that shows as 0.00 has no sign", () => {
    expect(formatPoints(-5.5833)).toBe("-5.58");
    expect(formatPoints(0.875 + 0.0001)).toBe("+0.88");
    expect(formatPoints(0.004)).toBe("0.00");
    expect(formatPoints(-0.004)).toBe("0.00");
    expect(formatPoints(null)).toBe("–");
  });

  it("states the two wings and the difference, or why the risk reversal cannot be computed", () => {
    expect(skewSentence(buildSkew(smile))).toBe("The 25-delta call is priced at 14.58 volatility points, 5.58 points below the 25-delta put at 20.17: a risk reversal of -5.58.");
    const shallow = chain([[100, [0.85, 0.2], [-0.12, 0.23]], [110, [0.45, 0.16], [-0.2, 0.21]]]);
    const sentence = skewSentence(buildSkew(shallow));
    expect(sentence).toContain("The 25-delta risk reversal cannot be computed.");
    expect(sentence).toContain("No two solved puts straddle put |delta| 0.25: the stored put deltas reach 0.12 to 0.20.");
  });
});

describe("daysToExpiryOf", () => {
  const legWith = (daysToExpiry: number | null) => ({ daysToExpiry }) as unknown as NonNullable<StrikeRow["call"]>;
  it("reads the first leg that carries it, and is null when none does", () => {
    const rows: StrikeRow[] = [
      { strikePrice: 100, isAtm: false, call: null, put: legWith(null) },
      { strikePrice: 110, isAtm: true, call: legWith(null), put: legWith(4.05) },
    ];
    expect(daysToExpiryOf(rows)).toBe(4.05);
    expect(daysToExpiryOf([{ strikePrice: 100, isAtm: false, call: legWith(null), put: null }])).toBeNull();
    expect(daysToExpiryOf([])).toBeNull();
  });
});

describe("historySentence", () => {
  const skewWith = (riskReversal: number | null): Skew => ({
    put25: { iv: null, between: null, refusal: null }, call25: { iv: null, between: null, refusal: null }, middle: { iv: null, between: null, refusal: null },
    riskReversal, butterfly: null,
  });
  /** Newest first. `tenors` are the days to expiry of each session, in the same order. */
  const sessions = (values: Array<number | null>, tenors: Array<number | null>): SessionSkew[] => values.map((value, index) => ({
    sessionDate: `2026-10-${String(30 - index).padStart(2, "0")}`, observedAt: "x", expiryDate: "2026-11-03", daysToExpiry: tenors[index] ?? null, skew: skewWith(value), error: null,
  }));

  it("compares the newest session only with earlier ones within two days of its tenor, and says it is not a test", () => {
    // Newest -3.00 at 4.0 days. Within two days: 5 (1 away), 3 (1 away), 6 (2 away, inclusive). The 12-day session is left out.
    const sentence = historySentence(sessions([-3, -5.5, -5.4, -5.7, -1], [4, 5, 3, 6, 12]));
    expect(sentence).toBe(
      "The newest session's risk reversal (-3.00 volatility points, 4.00 days to expiry) is outside the range of the 3 earlier sessions within 2 days of that tenor (-5.70 to -5.40). This flags a change, it does not test one: 4 sessions are not a distribution.",
    );
    expect(historySentence(sessions([-5.5, -5.5, -5.4, -5.7, -1], [4, 5, 3, 6, 12]))).toContain("is inside the range of the 3 earlier sessions within 2 days");
  });

  it("says there are too few at a similar tenor rather than comparing across tenors", () => {
    // 6.5 days is 2.5 from 4.0, outside the window: only the 5- and 3-day sessions are comparable.
    expect(historySentence(sessions([-3, -5.5, -5.4, -5.7, -5.6], [4, 5, 3, 6.5, 6.5]))).toBe(
      "Only 2 of the 4 earlier sessions with a risk reversal are within 2 days of the newest session's 4.00 days to expiry; at least 3 are needed before it can be said whether the skew moves. Skew depends on tenor, so sessions at other tenors are not compared.",
    );
    // A monthly expiry counting down: 4, 5, 6.05, 8.05, 11.19 days. Only the 5-day session is within two days of 4.
    expect(historySentence(sessions([-0.24, -1.25, -0.93, -1.24, -1.81], [4, 5, 6.05, 8.05, 11.19]))).toContain("Only 1 of the 4 earlier sessions with a risk reversal is within 2 days");
  });

  it("does not compare when the newest session does not carry its tenor, and ignores earlier ones that do not", () => {
    expect(historySentence(sessions([-3, -5.5, -5.4, -5.7], [null, 5, 3, 6]))).toBe("The newest session does not carry its days to expiry, so it cannot be matched to earlier sessions on tenor and is not compared.");
    expect(historySentence(sessions([-3, -5.5, -5.4, -5.7, -5.6], [4, null, 3, 6, 5]))).toContain("of the 3 earlier sessions within 2 days");
  });

  it("skips sessions without a risk reversal and needs four with one", () => {
    expect(historySentence(sessions([-3, null, -5.4, -5.7], [4, 5, 3, 6]))).toBe("3 of the 4 sessions have a risk reversal; at least 4 are needed before it can be said whether the skew moves.");
    expect(historySentence([])).toContain("0 of the 0 sessions");
  });

  it("does not count a session whose chain could not be read", () => {
    const failed: SessionSkew = { sessionDate: "2026-10-29", observedAt: "x", expiryDate: null, daysToExpiry: null, skew: null, error: "HTTP 500" };
    expect(historySentence([failed, ...sessions([-5, -5, -5], [4, 5, 3])])).toContain("3 of the 4 sessions");
  });
});
