import { describe, expect, it } from "vitest";
import {
  PredictOpeningGap,
  OPENING_GAP_DRIVER_SYMBOL,
  type GlobalCueSource,
  type OpeningGapPredictionStore,
} from "./predict-opening-gap.js";
import type { OpeningGapPredictionDraft, OpeningGapPrediction } from "../domain/opening-gap-prediction.js";

const NOW = new Date("2026-10-12T03:10:00.000Z"); // 08:40 IST

function fakeStore(): OpeningGapPredictionStore & { saved: OpeningGapPredictionDraft[] } {
  const saved: OpeningGapPredictionDraft[] = [];
  return {
    saved,
    async upsert(prediction) {
      saved.push(prediction);
      return { ...prediction, id: `pred-${saved.length}`, predictedAt: NOW } satisfies OpeningGapPrediction;
    },
  };
}

describe("PredictOpeningGap", () => {
  it("predicts both instruments from the GIFT Nifty driver and stores supplementary cues", async () => {
    const cues: GlobalCueSource = {
      async getChangePercents() {
        return new Map([
          [OPENING_GAP_DRIVER_SYMBOL, { changePercent: 0.4 }],
          ["^GSPC", { changePercent: 0.59 }],
          ["^N225", { changePercent: -0.6 }],
          ["^HSI", { changePercent: null }],
        ]);
      },
    };
    const store = fakeStore();

    const result = await new PredictOpeningGap(cues, store, () => NOW).execute();

    expect(result).toEqual({ sessionDate: "2026-10-12", driverAvailable: true, predicted: 2, skipped: 0 });
    expect(store.saved).toHaveLength(2);
    const nifty = store.saved.find((p) => p.instrumentSymbol === "NIFTY50")!;
    expect(nifty.expectation).toBe("GAP_UP");
    expect(nifty.driverChangePct).toBe(0.4);
    expect(nifty.driverSymbol).toBe(OPENING_GAP_DRIVER_SYMBOL);
    expect(nifty.supplementaryCues).toEqual({ "^GSPC": 0.59, "^N225": -0.6, "^HSI": null });
    const banknifty = store.saved.find((p) => p.instrumentSymbol === "BANKNIFTY")!;
    // Same 0.4% driver change clears BANKNIFTY's wider 0.35% threshold too.
    expect(banknifty.expectation).toBe("GAP_UP");
  });

  it("writes nothing when the driver quote is unavailable", async () => {
    const cues: GlobalCueSource = {
      async getChangePercents() {
        return new Map([[OPENING_GAP_DRIVER_SYMBOL, { changePercent: null }]]);
      },
    };
    const store = fakeStore();

    const result = await new PredictOpeningGap(cues, store, () => NOW).execute();

    expect(result).toEqual({ sessionDate: "2026-10-12", driverAvailable: false, predicted: 0, skipped: 2 });
    expect(store.saved).toHaveLength(0);
  });

  it("writes nothing when the driver symbol is entirely absent from the quote map", async () => {
    const cues: GlobalCueSource = {
      async getChangePercents() {
        return new Map();
      },
    };
    const store = fakeStore();

    const result = await new PredictOpeningGap(cues, store, () => NOW).execute();

    expect(result.driverAvailable).toBe(false);
    expect(store.saved).toHaveLength(0);
  });
});
