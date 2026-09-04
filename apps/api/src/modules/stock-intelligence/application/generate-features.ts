import type { CanonicalFeature, CanonicalSignal } from "../domain/canonical.js";
import {
  overallDataQuality,
  fundamentalCompleteness,
  marketDataCompleteness,
} from "../domain/data-quality.js";
import { documentCoverage } from "../domain/extraction.js";
import { DATA_QUALITY_SIGNAL_NAME, type FeatureValue } from "../domain/feature-catalog.js";
import { computeFeatureSet, type FeatureEngineInput } from "../domain/feature-engines.js";
import { assertAvailableAtCutoff } from "../domain/timestamps.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import {
  STOCK_INTELLIGENCE_FEATURE_VERSION,
  STOCK_INTELLIGENCE_FUNDAMENTAL_ENGINE_VERSION,
} from "../domain/versions.js";

export interface GeneratedFeatureSet {
  readonly features: readonly FeatureValue[];
  readonly availableCount: number;
  readonly fundamentalCompleteness: number;
  readonly marketDataCompleteness: number;
  readonly documentCoverage: number;
  readonly dataQuality: ReturnType<typeof overallDataQuality>;
}

export function generateFeatureSet(input: FeatureEngineInput): GeneratedFeatureSet {
  const features = computeFeatureSet(input);
  for (const feature of features) {
    assertAvailableAtCutoff(input.asOf, input.asOf, `feature:${feature.name}`);
  }
  const completeness = fundamentalCompleteness(
    input.asOf,
    input.fundamentals.map((row) => ({ field: row.field, availableAt: row.availableAt })),
  );
  const market = marketDataCompleteness({ asOf: input.asOf, bars: input.bars });
  const documents = documentCoverage(input.facts, input.asOf);
  return {
    features,
    availableCount: features.filter((feature) => feature.unavailableReason === null).length,
    fundamentalCompleteness: completeness,
    marketDataCompleteness: market,
    documentCoverage: documents,
    dataQuality: overallDataQuality({
      fundamentalCompleteness: completeness,
      marketDataCompleteness: market,
      documentCoverage: documents,
    }),
  };
}

function featureRecord(
  instrumentId: string,
  asOf: Date,
  feature: FeatureValue,
  factIds: readonly string[],
): Omit<CanonicalFeature, "featureId"> {
  return {
    instrumentId,
    featureName: feature.name,
    featureValue: {
      value: feature.value,
      unavailableReason: feature.unavailableReason,
      engine: feature.engine,
    },
    derivedFromFactIds: factIds,
    featureVersion: STOCK_INTELLIGENCE_FEATURE_VERSION,
    publishedAt: asOf,
    effectiveAt: asOf,
    availableAt: asOf,
  };
}

function dataQualitySignal(
  instrumentId: string,
  asOf: Date,
  generated: GeneratedFeatureSet,
): Omit<CanonicalSignal, "signalId"> {
  return {
    instrumentId,
    signalName: DATA_QUALITY_SIGNAL_NAME,
    signalValue: {
      ...generated.dataQuality,
      availableFeatureCount: generated.availableCount,
      featureCount: generated.features.length,
    },
    strength: generated.dataQuality.overall,
    derivedFrom: { availableFeatureCount: generated.availableCount },
    sourceFacts: { documentCoverage: generated.documentCoverage },
    featureVersion: STOCK_INTELLIGENCE_FEATURE_VERSION,
    engineVersion: STOCK_INTELLIGENCE_FUNDAMENTAL_ENGINE_VERSION,
    publishedAt: asOf,
    effectiveAt: asOf,
    availableAt: asOf,
  };
}

export class PersistGeneratedFeatures {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: FeatureEngineInput): Promise<GeneratedFeatureSet & {
    featureRecords: Omit<CanonicalFeature, "featureId">[];
  }> {
    const generated = generateFeatureSet(input);
    const factIds = input.facts.map((fact) => fact.factId);
    const featureRecords = generated.features.map((feature) =>
      featureRecord(input.instrumentId, input.asOf, feature, factIds)
    );
    await Promise.all(featureRecords.map((record) => this.store.insertFeature(record)));
    await this.store.insertSignal(dataQualitySignal(input.instrumentId, input.asOf, generated));
    return { ...generated, featureRecords };
  }
}
