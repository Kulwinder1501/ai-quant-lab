const fs = require('fs');

const testContent = `
describe("IctStructureStrategy reached() OHLC-range intersection", () => {
  // Test matrix for reached() function, reproducing the 4317.65 incident protections.
  // We test whether a LONG proposal is generated when an FVG with CE=4317 is present.
  
  function evaluateWithRange(low: number, high: number): boolean {
    const snap = alignedLongSnapshot({
      zones: {
        activeObs: [],
        activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 4317, fillPercentage: 0.1, isExtreme: true, isIdmAdjacent: false }],
      },
    });
    // Replace candle in context to mock the range
    const ctx = makeContext(snap, low);
    ctx.candle = { ...ctx.candle, low, high, close: low }; // Close at low just for safety
    const proposals = new IctStructureStrategy().evaluate(ctx, {});
    return proposals.length > 0;
  }

  it("rejects when entire candle is below the level (4130 to 4145 vs 4317)", () => {
    expect(evaluateWithRange(4130, 4145)).toBe(false);
  });

  it("rejects when candle wicks just under the level (4200 to 4316 vs 4317)", () => {
    expect(evaluateWithRange(4200, 4316)).toBe(false);
  });

  it("approves when candle crosses the level (4300 to 4330 vs 4317)", () => {
    expect(evaluateWithRange(4300, 4330)).toBe(true);
  });

  it("approves when candle sits exactly on the level with its low (4317 to 4350 vs 4317)", () => {
    expect(evaluateWithRange(4317, 4350)).toBe(true);
  });

  it("rejects when entire candle is above the level (4318 to 4400 vs 4317)", () => {
    expect(evaluateWithRange(4318, 4400)).toBe(false);
  });

  it("approves when candle sits exactly on the level with its high (4300 to 4317 vs 4317)", () => {
    expect(evaluateWithRange(4300, 4317)).toBe(true);
  });
});
`;

fs.appendFileSync('apps/api/src/modules/strategy-engine/domain/ict-structure-strategy.test.ts', testContent);
