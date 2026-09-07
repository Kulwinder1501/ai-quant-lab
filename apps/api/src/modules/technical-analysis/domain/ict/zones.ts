import type { CausalCandle, ConfirmedPivot } from "./causal-pivot.js";
import type { IctStructureSnapshot } from "./structure.js";

export type ZoneLifecycleState = "FRESH" | "TOUCHED" | "PARTIALLY_FILLED" | "CONSUMED" | "INVALIDATED" | "INVERTED";

export interface FairValueGap {
  readonly id: string;
  readonly type: "BULLISH" | "BEARISH";
  readonly top: number;
  readonly bottom: number;
  readonly midpoint: number; // Consequent Encroachment (CE)
  readonly createdAtBarIndex: number;
  readonly createdAtBarTime: Date;
  readonly candle1Index: number;
  readonly candle3Index: number;
  fillPercentage: number;
  state: ZoneLifecycleState;
  invertedAtBarIndex: number | null;
}

export interface OrderBlock {
  readonly id: string;
  readonly type: "BULLISH" | "BEARISH";
  readonly top: number;
  readonly bottom: number;
  readonly meanThreshold: number; // 50% of the OB body/range
  readonly createdAtBarIndex: number;
  readonly createdAtBarTime: Date;
  readonly obCandleIndex: number;
  readonly displacementCandleIndex: number;
  readonly attachedFvgId: string | null;
  readonly isExtreme: boolean;
  readonly isIdmAdjacent: boolean;
  state: ZoneLifecycleState;
}

export interface IctZoneSnapshot {
  readonly activeFvgs: readonly FairValueGap[];
  readonly activeObs: readonly OrderBlock[];
  readonly lastZoneEvent: {
    readonly zoneId: string;
    readonly zoneKind: "FVG" | "OB";
    readonly event: "CREATED" | "TOUCHED" | "PARTIALLY_FILLED" | "CONSUMED" | "INVALIDATED" | "INVERTED";
    readonly barIndex: number;
  } | null;
}

export class IctZoneLedger {
  private fvgs: FairValueGap[] = [];
  private obs: OrderBlock[] = [];
  private lastEvent: IctZoneSnapshot["lastZoneEvent"] = null;

  constructor(
    private readonly displacementThreshold: number = 1.5,
    private readonly meanThresholdFraction: number = 0.5
  ) {}

  processCandle(
    candles: readonly CausalCandle[],
    currentIndex: number,
    structure: IctStructureSnapshot
  ): IctZoneSnapshot {
    this.lastEvent = null;
    const current = candles[currentIndex];

    // 1. Detect 3-bar Fair Value Gap on current bar (currentIndex = candle 3)
    let newlyCreatedFvg: FairValueGap | null = null;
    if (currentIndex >= 2) {
      const c1 = candles[currentIndex - 2];
      const c2 = candles[currentIndex - 1];
      const c3 = current;

      // Bullish FVG: Low of candle 3 > High of candle 1
      if (c3.low > c1.high) {
        const top = c3.low;
        const bottom = c1.high;
        const fvg: FairValueGap = {
          id: `fvg-bullish-${currentIndex}`,
          type: "BULLISH",
          top,
          bottom,
          midpoint: (top + bottom) / 2,
          createdAtBarIndex: currentIndex,
          createdAtBarTime: c3.openTime,
          candle1Index: currentIndex - 2,
          candle3Index: currentIndex,
          fillPercentage: 0,
          state: "FRESH",
          invertedAtBarIndex: null,
        };
        this.fvgs.push(fvg);
        newlyCreatedFvg = fvg;
        this.lastEvent = {
          zoneId: fvg.id,
          zoneKind: "FVG",
          event: "CREATED",
          barIndex: currentIndex,
        };
      }
      // Bearish FVG: High of candle 3 < Low of candle 1
      else if (c3.high < c1.low) {
        const top = c1.low;
        const bottom = c3.high;
        const fvg: FairValueGap = {
          id: `fvg-bearish-${currentIndex}`,
          type: "BEARISH",
          top,
          bottom,
          midpoint: (top + bottom) / 2,
          createdAtBarIndex: currentIndex,
          createdAtBarTime: c3.openTime,
          candle1Index: currentIndex - 2,
          candle3Index: currentIndex,
          fillPercentage: 0,
          state: "FRESH",
          invertedAtBarIndex: null,
        };
        this.fvgs.push(fvg);
        newlyCreatedFvg = fvg;
        this.lastEvent = {
          zoneId: fvg.id,
          zoneKind: "FVG",
          event: "CREATED",
          barIndex: currentIndex,
        };
      }
    }

    // 2. Detect Order Block
    if (currentIndex >= 2 && newlyCreatedFvg) {
      const displacementIndex = currentIndex - 1;
      const obIndex = currentIndex - 2;
      const displacementCandle = candles[displacementIndex];
      const obCandle = candles[obIndex];

      const body = Math.abs(displacementCandle.close - displacementCandle.open);
      const prevBody = Math.abs(obCandle.close - obCandle.open) || 1;

      if (body >= prevBody * this.displacementThreshold) {
        const isBullishDisplacement = displacementCandle.close > displacementCandle.open;
        const wasBearish = obCandle.close < obCandle.open;
        const wasBullish = obCandle.close > obCandle.open;

        if (isBullishDisplacement && wasBearish && newlyCreatedFvg.type === "BULLISH") {
          const top = obCandle.high;
          const bottom = obCandle.low;
          const ob: OrderBlock = {
            id: `ob-bullish-${currentIndex}`,
            type: "BULLISH",
            top,
            bottom,
            meanThreshold: bottom + (top - bottom) * this.meanThresholdFraction,
            createdAtBarIndex: currentIndex,
            createdAtBarTime: current.openTime,
            obCandleIndex: obIndex,
            displacementCandleIndex: displacementIndex,
            attachedFvgId: newlyCreatedFvg.id,
            isExtreme: structure.lastHL ? obCandle.low <= structure.lastHL.price : true,
            isIdmAdjacent: structure.idm ? Math.abs(obCandle.low - structure.idm.price) / obCandle.low < 0.005 : false,
            state: "FRESH",
          };
          this.obs.push(ob);
          this.lastEvent = {
            zoneId: ob.id,
            zoneKind: "OB",
            event: "CREATED",
            barIndex: currentIndex,
          };
        } else if (!isBullishDisplacement && wasBullish && newlyCreatedFvg.type === "BEARISH") {
          const top = obCandle.high;
          const bottom = obCandle.low;
          const ob: OrderBlock = {
            id: `ob-bearish-${currentIndex}`,
            type: "BEARISH",
            top,
            bottom,
            meanThreshold: bottom + (top - bottom) * this.meanThresholdFraction,
            createdAtBarIndex: currentIndex,
            createdAtBarTime: current.openTime,
            obCandleIndex: obIndex,
            displacementCandleIndex: displacementIndex,
            attachedFvgId: newlyCreatedFvg.id,
            isExtreme: structure.lastLH ? obCandle.high >= structure.lastLH.price : true,
            isIdmAdjacent: structure.idm ? Math.abs(obCandle.high - structure.idm.price) / obCandle.high < 0.005 : false,
            state: "FRESH",
          };
          this.obs.push(ob);
          this.lastEvent = {
            zoneId: ob.id,
            zoneKind: "OB",
            event: "CREATED",
            barIndex: currentIndex,
          };
        }
      }
    }

    // 3. Update FVG Lifecycle
    for (const fvg of this.fvgs) {
      if (fvg.state === "INVALIDATED" || fvg.state === "CONSUMED") continue;
      if (fvg.createdAtBarIndex === currentIndex) continue;

      const gapHeight = fvg.top - fvg.bottom;
      if (gapHeight <= 0) continue;

      if (fvg.type === "BULLISH") {
        if (current.low <= fvg.top && current.high >= fvg.bottom) {
          const penetration = Math.max(0, fvg.top - current.low);
          const pct = Math.min(1.0, penetration / gapHeight);
          fvg.fillPercentage = Math.max(fvg.fillPercentage, pct);

          if (current.close < fvg.bottom) {
            fvg.state = "INVERTED";
            fvg.invertedAtBarIndex = currentIndex;
            this.lastEvent = {
              zoneId: fvg.id,
              zoneKind: "FVG",
              event: "INVERTED",
              barIndex: currentIndex,
            };
          } else if (fvg.fillPercentage >= 1.0) {
            fvg.state = "CONSUMED";
          } else if (fvg.fillPercentage > 0) {
            fvg.state = "PARTIALLY_FILLED";
          }
        }
      } else if (fvg.type === "BEARISH") {
        if (current.high >= fvg.bottom && current.low <= fvg.top) {
          const penetration = Math.max(0, current.high - fvg.bottom);
          const pct = Math.min(1.0, penetration / gapHeight);
          fvg.fillPercentage = Math.max(fvg.fillPercentage, pct);

          if (current.close > fvg.top) {
            fvg.state = "INVERTED";
            fvg.invertedAtBarIndex = currentIndex;
            this.lastEvent = {
              zoneId: fvg.id,
              zoneKind: "FVG",
              event: "INVERTED",
              barIndex: currentIndex,
            };
          } else if (fvg.fillPercentage >= 1.0) {
            fvg.state = "CONSUMED";
          } else if (fvg.fillPercentage > 0) {
            fvg.state = "PARTIALLY_FILLED";
          }
        }
      }
    }

    // 4. Update Order Block Lifecycle
    for (const ob of this.obs) {
      if (ob.state === "INVALIDATED" || ob.state === "CONSUMED") continue;
      // Do not update on the bar the OB candle itself formed, but allow on subsequent bars
      if (ob.createdAtBarIndex === currentIndex) continue;

      if (ob.type === "BULLISH") {
        if (current.low <= ob.top) {
          if (current.close < ob.meanThreshold) {
            ob.state = "INVALIDATED";
            this.lastEvent = {
              zoneId: ob.id,
              zoneKind: "OB",
              event: "INVALIDATED",
              barIndex: currentIndex,
            };
          } else {
            ob.state = "TOUCHED";
            this.lastEvent = {
              zoneId: ob.id,
              zoneKind: "OB",
              event: "TOUCHED",
              barIndex: currentIndex,
            };
          }
        }
      } else if (ob.type === "BEARISH") {
        if (current.high >= ob.bottom) {
          if (current.close > ob.meanThreshold) {
            ob.state = "INVALIDATED";
            this.lastEvent = {
              zoneId: ob.id,
              zoneKind: "OB",
              event: "INVALIDATED",
              barIndex: currentIndex,
            };
          } else {
            ob.state = "TOUCHED";
            this.lastEvent = {
              zoneId: ob.id,
              zoneKind: "OB",
              event: "TOUCHED",
              barIndex: currentIndex,
            };
          }
        }
      }
    }

    return {
      activeFvgs: this.fvgs.filter((f) => f.state !== "INVALIDATED" && f.state !== "CONSUMED"),
      activeObs: this.obs.filter((o) => o.state !== "INVALIDATED" && o.state !== "CONSUMED"),
      lastZoneEvent: this.lastEvent,
    };
  }
}
