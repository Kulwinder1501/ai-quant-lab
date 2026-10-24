import { describe, expect, it } from "vitest";
import { buildContractCost, type CostLeg } from "./contract-cost";
import { buildImpliedMove } from "./implied-move";
import { buildStrikeLadder, ladderNotes, moneynessOf, type LadderStrike } from "./strike-ladder";

/** Synthetic chain, hand-built for the arithmetic (not recorded from the API). Spot 54,300. */
const SPOT = 54_300;

const leg = (bid: number | null, ask: number | null): CostLeg => ({ bid, ask, impliedVolatility: 0.15, delta: 0.5, gamma: 0.0004, theta: -12, daysToExpiry: 4 });

const strikes: LadderStrike[] = [
  { strikePrice: 54_600, call: leg(200, 206), put: leg(380, 386) },
  { strikePrice: 54_000, call: leg(380, 386), put: leg(100, 104) },
  { strikePrice: 54_300, call: leg(330, 336), put: leg(310, 316) },
  { strikePrice: 54_900, call: leg(0, 90), put: null },
];

const implied = buildImpliedMove({ spot: SPOT, atmStrike: 54_300, atmCall: null, atmPut: null, atmIv: 0.15, daysToExpiry: 4 });
const ladder = (side: "CE" | "PE") => buildStrikeLadder({ side, strikes, spot: SPOT, atmStrike: 54_300 }, implied);

describe("moneynessOf", () => {
  it("puts the ATM strike first, then a call below the index or a put above it in the money", () => {
    expect(moneynessOf("CE", 54_300, SPOT, 54_300)).toBe("ATM");
    expect(moneynessOf("CE", 54_000, SPOT, 54_300)).toBe("ITM");
    expect(moneynessOf("CE", 54_600, SPOT, 54_300)).toBe("OTM");
    expect(moneynessOf("PE", 54_000, SPOT, 54_300)).toBe("OTM");
    expect(moneynessOf("PE", 54_600, SPOT, 54_300)).toBe("ITM");
  });

  it("calls everything not at the money out of the money when there is no spot to compare with", () => {
    expect(moneynessOf("CE", 54_000, null, null)).toBe("OTM");
  });
});

describe("buildStrikeLadder", () => {
  it("lists the strikes in order whatever order they arrive in", () => {
    expect(ladder("CE").map((row) => row.strike)).toEqual([54_000, 54_300, 54_600, 54_900]);
  });

  it("gives each call its breakeven and the move it needs, by hand: strike plus ask, less the index", () => {
    const rows = ladder("CE");
    // 54,000 at 386: breakeven 54,386, 86 above the index (it is 300 in the money, so only the time value is needed).
    expect(rows[0]!.cost.breakevenAtExpiry).toBe(54_386);
    expect(rows[0]!.cost.neededMove!.points).toBe(86);
    // 54,300 at 336: 54,636, 336 above.
    expect(rows[1]!.cost.breakevenAtExpiry).toBe(54_636);
    expect(rows[1]!.cost.neededMove!.points).toBe(336);
    // 54,600 at 206: 54,806, 506 above.
    expect(rows[2]!.cost.breakevenAtExpiry).toBe(54_806);
    expect(rows[2]!.cost.neededMove!.points).toBe(506);
    expect(rows.map((row) => row.moneyness)).toEqual(["ITM", "ATM", "OTM", "OTM"]);
  });

  it("reads the put legs for puts: strike minus ask, and the index has to fall to it", () => {
    const rows = ladder("PE");
    // 54,000 put at 104: breakeven 53,896, 404 below the index.
    expect(rows[0]!.cost.breakevenAtExpiry).toBe(53_896);
    expect(rows[0]!.cost.neededMove).toMatchObject({ points: 404, direction: "down" });
    // 54,600 put at 386: breakeven 54,214, 86 below.
    expect(rows[2]!.cost.breakevenAtExpiry).toBe(54_214);
    expect(rows.map((row) => row.moneyness)).toEqual(["OTM", "ATM", "ITM", "ITM"]);
  });

  it("is exactly the single-contract card for the same contract", () => {
    const row = ladder("CE")[1]!;
    expect(row.cost).toEqual(buildContractCost({ optionType: "CE", strike: 54_300, spot: SPOT, leg: leg(330, 336) }, implied));
  });

  it("keeps a contract with no two-sided quote, or no contract at all, as a row with nothing derived", () => {
    const callRows = ladder("CE");
    expect(callRows[3]!.cost.quote).toBeNull();                 // zero bid
    expect(callRows[3]!.cost.breakevenAtExpiry).toBeNull();
    const putRows = ladder("PE");
    expect(putRows[3]!.cost.quote).toBeNull();                  // no put stored at 54,900
    expect(putRows).toHaveLength(4);
  });
});

describe("ladderNotes", () => {
  it("is silent when every strike is quoted", () => {
    expect(ladderNotes(ladder("CE").slice(0, 3))).toEqual([]);
  });

  it("counts the strikes without a two-sided quote", () => {
    expect(ladderNotes(ladder("CE")).map((note) => note.text)).toEqual([
      "1 of the 4 strikes have no two-sided quote (a positive bid and an ask) and show no derived figures: an unquoted contract is unknown, not cheap.",
    ]);
  });

  it("warns about an ask below intrinsic value", () => {
    const crossed = buildStrikeLadder({ side: "CE", strikes: [{ strikePrice: 53_900, call: leg(385, 390), put: null }], spot: SPOT, atmStrike: 54_300 }, implied);
    expect(ladderNotes(crossed)).toEqual([{ tone: "warn", text: "1 strike has an ask below intrinsic value (a stale or crossed quote), so its hurdle is not meaningful." }]);
  });
});
