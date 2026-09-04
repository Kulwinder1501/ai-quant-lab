import type { AnalogueSet } from "../domain/analogue-search.js";
import type { DataQualityScores } from "../domain/data-quality.js";
import type { FeatureValue } from "../domain/feature-catalog.js";
import type { HorizonForecast } from "../domain/outcome-model.js";
import { assemblePredictionSnapshot } from "../domain/snapshot.js";
import type { StockIntelligenceStore } from "../domain/store.js";

export class PersistPredictionSnapshots {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    instrumentId: string;
    asOf: Date;
    forecast6m: HorizonForecast;
    forecast12m: HorizonForecast;
    analogue6m: AnalogueSet;
    analogue12m: AnalogueSet;
    dataQuality: DataQualityScores;
    features: readonly FeatureValue[];
    regimeBucket: string | null;
    entryPrice: number | null;
  }): Promise<{ snapshotId6m: string; snapshotId12m: string }> {
    const snapshotId6m = await this.store.insertSnapshot(assemblePredictionSnapshot({
      instrumentId: input.instrumentId,
      asOf: input.asOf,
      forecast: input.forecast6m,
      analogueSet: input.analogue6m,
      dataQuality: input.dataQuality,
      features: input.features,
      regimeBucket: input.regimeBucket,
      entryPrice: input.entryPrice,
    }));
    const snapshotId12m = await this.store.insertSnapshot(assemblePredictionSnapshot({
      instrumentId: input.instrumentId,
      asOf: input.asOf,
      forecast: input.forecast12m,
      analogueSet: input.analogue12m,
      dataQuality: input.dataQuality,
      features: input.features,
      regimeBucket: input.regimeBucket,
      entryPrice: input.entryPrice,
    }));
    return { snapshotId6m, snapshotId12m };
  }
}
