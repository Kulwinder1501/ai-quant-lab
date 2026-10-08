const fs = require('fs');
const { IctStructureStrategy } = require('./src/modules/strategy-engine/domain/ict-structure-strategy.js');
const { IctStructureTracker } = require('./src/modules/technical-analysis/domain/ict/structure.js');
const { IctZoneLedger } = require('./src/modules/technical-analysis/domain/ict/zones.js');

function alignedLongSnapshot(overrides = {}) {
  return {
    atr14: 2.0,
    coverage: {
      structure: "COMPLETE", bias: "COMPLETE", zones: "COMPLETE",
      sessionLevels: "COMPLETE", liquidity: "COMPLETE", htf: "COMPLETE",
    },
    htfBias: "BULLISH",
    bias: { bias: "BULLISH", dailyTemplate: "OLHC", dealingRange: { equilibrium: 5000 } },
    structure: { trend: "BULLISH", lastHL: { price: 4290 } },
    zones: { activeObs: [], activeFvgs: [] },
    sessionLevels: { levels: { pdh: 5000, pdl: 90 }, lastSweepEvent: null },
    liquidity: {
      alignmentStatus: "ALIGNED_LONG",
      primaryTarget: { kind: "ERL_PDH", price: 5000 },
      intermediateTarget: 4800,
      invalidationLevel: 4290,
    },
    ...overrides,
  };
}

function makeContext(ictSnapshot, close = 100) {
  const snap = ictSnapshot ? { atr14: 2.0, ...ictSnapshot } : undefined;
  return {
    candle: {
      id: "c-test-1", instrumentId: "inst-1", timeframe: "5m",
      openTime: new Date("2026-01-06T03:45:00.000Z"),
      closeTime: new Date("2026-01-06T03:50:00.000Z"),
      open: 98, high: 101, low: 97, close, volume: 500, tickSize: 0.05,
    },
    indicators: [], patterns: [], priceActionEvents: [], ictSnapshot: snap,
  };
}

function evaluateWithRange(low, high) {
  const snap = alignedLongSnapshot({
    zones: {
      activeObs: [],
      activeFvgs: [{ id: "fvg-1", type: "BULLISH", midpoint: 4317, fillPercentage: 0.1, isExtreme: true, isIdmAdjacent: false }],
    },
  });
  const ctx = makeContext(snap, low);
  ctx.candle = { ...ctx.candle, low, high, open: high, close: low };
  const proposals = new IctStructureStrategy().evaluate(ctx, {});
  console.dir(proposals, { depth: null });
  return proposals.length > 0;
}

console.log("Running evaluateWithRange(4317, 4350):");
evaluateWithRange(4317, 4350);
