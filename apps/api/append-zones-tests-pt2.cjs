const fs = require('fs');

const testContent = `
  describe("Bearish FVG Lifecycle Symmetry", () => {
    it("invalidates untouched Bearish FVG if price completely gaps above it (gap-through invalidation)", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      // Bearish FVG [110, 115]
      const candles: CausalCandle[] = [
        makeCandle(0, 120, 125, 115, 118),
        makeCandle(1, 118, 118, 95, 98),
        makeCandle(2, 100, 110, 90, 95),
      ];
      for (let i = 0; i <= 2; i++) {
        ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }

      // C3 gaps completely above 115. Low = 120, so touches = false.
      const c3 = makeCandle(3, 125, 130, 120, 128);
      candles.push(c3);
      const snap3 = ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));

      const oldFvg = snap3.activeFvgs.find(f => f.id === "fvg-bearish-2");
      expect(oldFvg).toBeUndefined();
    });

    it("evaluates touch and failure correctly on the same candle", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      const candles: CausalCandle[] = [
        makeCandle(0, 120, 125, 115, 118),
        makeCandle(1, 118, 118, 95, 98),
        makeCandle(2, 100, 110, 90, 95),
      ];
      for (let i = 0; i <= 2; i++) {
        ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }

      // C3 touches (low = 112) and closes above (close = 118)
      const c3 = makeCandle(3, 112, 125, 112, 118);
      candles.push(c3);
      const snap3 = ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));

      const oldFvg = snap3.activeFvgs.find(f => f.id === "fvg-bearish-2");
      expect(oldFvg).toBeUndefined();
    });
  });

  describe("Order Block Lifecycle Integrity", () => {
    it("invalidates untouched Bullish OB if price completely gaps below its Mean Threshold", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      // C0 is the OB candle [94, 106]. MT = 100
      const candles: CausalCandle[] = [
        makeCandle(0, 105, 106, 94, 95),
        makeCandle(1, 95, 126, 94, 125),
        makeCandle(2, 120, 130, 110, 128),
      ];
      for (let i = 0; i <= 2; i++) {
        ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }

      // C3 gaps completely below 106 (OB top), so touches = false. And closes below MT (100).
      const c3 = makeCandle(3, 90, 95, 80, 90);
      candles.push(c3);
      const snap3 = ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));

      const ob = snap3.activeObs.find(o => o.id === "ob-bullish-3");
      expect(ob).toBeUndefined();
    });

    it("does not invalidate OB if it wicks below MT but closes above it", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      const candles: CausalCandle[] = [
        makeCandle(0, 105, 106, 94, 95),
        makeCandle(1, 95, 126, 94, 125),
        makeCandle(2, 120, 130, 110, 128),
      ];
      for (let i = 0; i <= 2; i++) {
        ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }

      // C3 wicks below 100 (MT) to 90, but closes above MT at 102.
      const c3 = makeCandle(3, 110, 110, 90, 102);
      candles.push(c3);
      const snap3 = ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));

      const ob = snap3.activeObs.find(o => o.id === "ob-bullish-3");
      expect(ob).toBeDefined();
      expect(ob?.state).not.toBe("INVALIDATED");
    });
  });
});
`;

let fileContent = fs.readFileSync('apps/api/src/modules/technical-analysis/domain/ict/zones.test.ts', 'utf-8');
fileContent = fileContent.replace(/}\);\s*$/, testContent);
fs.writeFileSync('apps/api/src/modules/technical-analysis/domain/ict/zones.test.ts', fileContent);
