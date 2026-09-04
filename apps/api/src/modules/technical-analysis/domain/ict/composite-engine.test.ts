import { describe, it, expect } from "vitest";
import { IctCompositeEngine } from "./composite-engine.js";
import { ICT_STATE_ENGINE_VERSION } from "./config.js";
import type { CausalCandle } from "./causal-pivot.js";

function makeIstCandle(
  dateStr: string,
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number
): CausalCandle {
  const [y, m, d] = dateStr.split("-").map(Number);
  const istMinutes = hour * 60 + minute;
  const utcMinutes = istMinutes - 330;
  const date = new Date(Date.UTC(y, m - 1, d, 0, utcMinutes));
  return {
    id: `c-${dateStr}-${hour}-${minute}`,
    openTime: date,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

describe("IctCompositeEngine", () => {
  it("processes candles sequentially and computes full 4-pillar snapshot", () => {
    const engine = new IctCompositeEngine();
    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105),
      makeIstCandle("2026-01-05", 9, 20, 105, 112, 104, 108),
      makeIstCandle("2026-01-06", 9, 15, 106, 107, 93, 97), // Sweeps PDL (95) and reclaims at 97
    ];

    let snap: any;
    for (let i = 0; i < candles.length; i++) {
      snap = engine.processCandle(candles, i);
    }

    expect(snap.engineVersion).toBe(ICT_STATE_ENGINE_VERSION);
    expect(snap.configHash).toHaveLength(64);
    expect(snap.barIndex).toBe(2);
    expect(snap.sessionLevels.levels).not.toBeNull();
    expect(snap.sessionLevels.levels?.pdh).toBe(112);
    expect(snap.sessionLevels.levels?.pdl).toBe(95);
    expect(snap.bias.bias).toBe("BULLISH"); // PDL swept and reclaimed
    expect(snap.coverage.zones).toBe("COMPLETE");
    expect(snap.coverage.sessionLevels).toBe("COMPLETE");
    expect(snap.coverage.bias).toBe("COMPLETE");
  });
});
