import type { PointInTimeClocks } from "./timestamps.js";

export const canonicalLayers = ["raw", "fact", "feature", "signal"] as const;
export type CanonicalLayer = (typeof canonicalLayers)[number];

export const fundamentalOrigins = ["REPORTED_ACTUAL", "ANALYST_ESTIMATE"] as const;
export type FundamentalOrigin = (typeof fundamentalOrigins)[number];

export interface CanonicalRawRecord extends PointInTimeClocks {
  readonly rawId: string;
  readonly instrumentId: string | null;
  readonly sourceKind: string;
  readonly payload: Record<string, unknown>;
  readonly dataSchemaVersion: string;
}

export interface CanonicalFact extends PointInTimeClocks {
  readonly factId: string;
  readonly instrumentId: string;
  readonly factName: string;
  readonly factValue: Record<string, unknown>;
  readonly sourceRawId: string | null;
  readonly sourceDocument: string | null;
  readonly sourcePage: number | null;
  readonly extractionModel: string | null;
  readonly extractionVersion: string | null;
  readonly dataSchemaVersion: string;
}

export interface CanonicalFeature extends PointInTimeClocks {
  readonly featureId: string;
  readonly instrumentId: string;
  readonly featureName: string;
  readonly featureValue: Record<string, unknown>;
  readonly derivedFromFactIds: readonly string[];
  readonly featureVersion: string;
}

export interface CanonicalSignal extends PointInTimeClocks {
  readonly signalId: string;
  readonly instrumentId: string;
  readonly signalName: string;
  readonly signalValue: Record<string, unknown>;
  readonly strength: number | null;
  readonly derivedFrom: Record<string, unknown>;
  readonly sourceFacts: Record<string, unknown>;
  readonly featureVersion: string;
  readonly engineVersion: string;
}

export interface AsReportedFundamental extends PointInTimeClocks {
  readonly snapshotId: string;
  readonly instrumentId: string;
  readonly field: string;
  readonly value: string;
  readonly origin: FundamentalOrigin;
  readonly reportDate: string;
  readonly periodEnd: string;
  readonly dataSchemaVersion: string;
}

export const corporateActionTypes = [
  "SPLIT",
  "BONUS",
  "RIGHTS",
  "DIVIDEND",
  "BUYBACK",
  "MERGER",
  "DELISTING",
] as const;
export type CorporateActionType = (typeof corporateActionTypes)[number];

export interface CorporateActionRecord extends PointInTimeClocks {
  readonly actionId: string;
  readonly instrumentId: string;
  readonly actionType: CorporateActionType;
  readonly exDate: string;
  readonly details: Record<string, unknown>;
}
