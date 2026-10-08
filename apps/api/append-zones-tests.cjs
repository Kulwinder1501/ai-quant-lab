const fs = require('fs');

const testContent = `
  describe("FVG and OB Lifecycle Integrity / Independent Invalidation", () => {
    it("invalidates untouched FVG if price completely gaps through it (gap-through invalidation)", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      // C0-C2 form a Bullish FVG [100, 105]
      const candles: CausalCandle[] = [
        makeCandle(0, 95, 100, 90, 98),
        makeCandle(1, 98, 122, 97, 120),
        makeCandle(2, 115, 125, 105, 123),
      ];

      for (let i = 0; i <= 2; i++) {
        const s = structTracker.processCandle(candles, i);
        ledger.processCandle(candles, i, s);
      }

      // C3 gaps completely below 100. High = 95, so touches = false.
      const c3 = makeCandle(3, 94, 95, 85, 90);
      candles.push(c3);
      const s3 = structTracker.processCandle(candles, 3);
      const snap3 = ledger.processCandle(candles, 3, s3);

      // Active FVGs should be 0 (the inverted gap becomes BEARISH and bornThisBar).
      const oldFvg = snap3.activeFvgs.find(f => f.id === "fvg-bullish-2");
      expect(oldFvg).toBeUndefined();
      expect(snap3.lastZoneEvent?.event).toBe("INVERTED");
    });

    it("evaluates touch and failure correctly on the same candle without leaking intermediate state", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      // FVG [100, 105]
      const candles: CausalCandle[] = [
        makeCandle(0, 95, 100, 90, 98),
        makeCandle(1, 98, 122, 97, 120),
        makeCandle(2, 115, 125, 105, 123),
      ];
      for (let i = 0; i <= 2; i++) {
        ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }

      // C3 touches the FVG (high = 104) and then closes below it (close = 95)
      const c3 = makeCandle(3, 102, 104, 94, 95);
      candles.push(c3);
      const snap3 = ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));

      // It must be INVERTED and completely removed from activeFvgs.
      const oldFvg = snap3.activeFvgs.find(f => f.id === "fvg-bullish-2");
      expect(oldFvg).toBeUndefined();
    });

    it("does not invalidate if price wicks through but closes inside (wick-through without close-through)", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      // FVG [100, 105]
      const candles: CausalCandle[] = [
        makeCandle(0, 95, 100, 90, 98),
        makeCandle(1, 98, 122, 97, 120),
        makeCandle(2, 115, 125, 105, 123),
      ];
      for (let i = 0; i <= 2; i++) {
        ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }

      // C3 wicks below 100 (low = 90) but closes at 102
      const c3 = makeCandle(3, 110, 110, 90, 102);
      candles.push(c3);
      const snap3 = ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));

      // Must NOT be inverted.
      const oldFvg = snap3.activeFvgs.find(f => f.id === "fvg-bullish-2");
      expect(oldFvg).toBeDefined();
      expect(oldFvg?.state).not.toBe("INVALIDATED");
    });

    it("proves a terminal state cannot resurrect (monotonic lifecycle)", () => {
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      // FVG [100, 105]
      const candles: CausalCandle[] = [
        makeCandle(0, 95, 100, 90, 98),
        makeCandle(1, 98, 122, 97, 120),
        makeCandle(2, 115, 125, 105, 123),
      ];
      for (let i = 0; i <= 2; i++) {
        ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }

      // C3 closes below 100 -> INVERTED
      const c3 = makeCandle(3, 110, 110, 90, 95);
      candles.push(c3);
      ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));

      // C4 moves back above FVG (closes at 110)
      const c4 = makeCandle(4, 95, 115, 95, 110);
      candles.push(c4);
      const snap4 = ledger.processCandle(candles, 4, structTracker.processCandle(candles, 4));

      // The original bullish FVG must remain DEAD and not appear in activeFvgs
      const oldFvg = snap4.activeFvgs.find(f => f.id === "fvg-bullish-2");
      expect(oldFvg).toBeUndefined();
    });

    it("proves candidate selection drops the stale FVG completely in integration simulation (Historical Gold Incident Replay)", () => {
      // Simulate incident where FVG at CE 4317.65 survived to price 4137
      const ledger = new IctZoneLedger(1.5, 0.5);
      const structTracker = new IctStructureTracker(2);

      // Create a bullish gap: C0 high=4310, C1 jumps, C2 low=4325. FVG=[4310, 4325], CE=4317.5
      const candles: CausalCandle[] = [
        makeCandle(0, 4300, 4310, 4290, 4305),
        makeCandle(1, 4310, 4340, 4308, 4335),
        makeCandle(2, 4330, 4350, 4325, 4345),
      ];
      let lastSnap!: any;
      for (let i = 0; i <= 2; i++) {
        lastSnap = ledger.processCandle(candles, i, structTracker.processCandle(candles, i));
      }
      
      expect(lastSnap.activeFvgs.find((f: any) => f.id === "fvg-bullish-2")).toBeDefined();

      // Price crashes down to ~4137 over several candles
      const c3 = makeCandle(3, 4345, 4345, 4200, 4210);
      candles.push(c3);
      lastSnap = ledger.processCandle(candles, 3, structTracker.processCandle(candles, 3));
      
      // FVG must drop out immediately upon closing < 4310
      expect(lastSnap.activeFvgs.find((f: any) => f.id === "fvg-bullish-2")).toBeUndefined();

      // Continue to 4137
      const c4 = makeCandle(4, 4210, 4220, 4130, 4137);
      candles.push(c4);
      lastSnap = ledger.processCandle(candles, 4, structTracker.processCandle(candles, 4));

      expect(lastSnap.activeFvgs.find((f: any) => f.id === "fvg-bullish-2")).toBeUndefined();
    });
  });
});
`;

let fileContent = fs.readFileSync('apps/api/src/modules/technical-analysis/domain/ict/zones.test.ts', 'utf-8');
fileContent = fileContent.replace(/}\);\s*$/, testContent);
fs.writeFileSync('apps/api/src/modules/technical-analysis/domain/ict/zones.test.ts', fileContent);
