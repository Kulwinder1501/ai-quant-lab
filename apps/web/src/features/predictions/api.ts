import { asBoolean, asNumber, asObject, asString, objectAt } from "../research/json";
import type {
  ExplanationEntry,
  FeatureContribution,
  PredictionDetail,
  PredictionSummary,
} from "./domain";

export function parsePredictionSummary(value: unknown): PredictionSummary | null {
  const record = asObject(value);
  if (!record) return null;

  const id = asString(record.id);
  const prediction = asString(record.prediction);
  const instrument = objectAt(record, "instrument");
  const sourceCandle = objectAt(record, "sourceCandle");
  const model = objectAt(record, "model");
  const symbol = asString(instrument.symbol);
  if (!id || !prediction || !symbol || record.researchOnly !== true) return null;

  return {
    id,
    researchOnly: true,
    prediction,
    confidence: asNumber(record.confidence),
    createdAt: asString(record.createdAt),
    evidenceCutoffAt: asString(record.evidenceCutoffAt),
    instrument: {
      symbol,
      displayName: asString(instrument.displayName),
    },
    sourceCandle: {
      id: asString(sourceCandle.id),
      timeframe: asString(sourceCandle.timeframe),
      openTime: asString(sourceCandle.openTime),
      closeTime: asString(sourceCandle.closeTime),
      close: asNumber(sourceCandle.close),
    },
    model: {
      id: asString(model.id),
      key: asString(model.key),
      version: asNumber(model.version),
      algorithm: asString(model.algorithm),
      currentStage: asString(model.currentStage),
      trainedAt: asString(model.trainedAt),
      promotedAt: asString(model.promotedAt),
      validationMetrics: objectAt(model, "validationMetrics"),
    },
  };
}

function parseContribution(value: unknown): FeatureContribution | null {
  const contribution = asObject(value);
  const feature = contribution && asString(contribution.feature);
  if (!contribution || !feature) return null;
  return {
    feature,
    category: asString(contribution.category),
    rawValue: asNumber(contribution.rawValue),
    coefficient: asNumber(contribution.coefficient),
    contribution: asNumber(contribution.contribution),
    contributionMethod: asString(contribution.contributionMethod),
    supportsPredictedClass: asBoolean(contribution.supportsPredictedClass),
  };
}

function parseExplanation(value: unknown): ExplanationEntry | null {
  const entry = asObject(value);
  const kind = entry && asString(entry.kind);
  const summary = entry && asString(entry.summary);
  if (!entry || !kind || !summary) return null;
  return { kind, summary, details: objectAt(entry, "details") };
}

export function parsePredictionDetail(value: unknown): PredictionDetail | null {
  const record = asObject(value);
  const summary = parsePredictionSummary(record);
  if (!record || !summary) return null;
  const featureContributions = Array.isArray(record.featureContributions)
    ? record.featureContributions.map(parseContribution).filter((item): item is FeatureContribution => item !== null)
    : [];
  const explanation = Array.isArray(record.explanation)
    ? record.explanation.map(parseExplanation).filter((item): item is ExplanationEntry => item !== null)
    : [];
  return { ...summary, featureContributions, explanation };
}

export function parsePredictionListEnvelope(value: unknown): PredictionSummary[] {
  const payload = asObject(value);
  return Array.isArray(payload?.data)
    ? payload.data.map(parsePredictionSummary).filter((record): record is PredictionSummary => record !== null)
    : [];
}

export function parsePredictionDetailEnvelope(value: unknown): PredictionDetail | null {
  const payload = asObject(value);
  return parsePredictionDetail(payload?.data);
}
