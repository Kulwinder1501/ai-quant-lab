import type { CanonicalFact } from "./canonical.js";
import { assertAvailableAtCutoff, assertClocksAreOrdered } from "./timestamps.js";
import { STOCK_INTELLIGENCE_DATA_SCHEMA_VERSION, STOCK_INTELLIGENCE_EXTRACTION_VERSION } from "./versions.js";

/**
 * LLMs extract structured facts with provenance. They do not predict prices.
 * A fact without a document, model, and extraction version is refused rather
 * than stored as if it were observed.
 */
export const EXTRACTION_FORBIDDEN_FACT_NAMES = [
  "predicted_return",
  "forward_price_return",
  "forward_total_return",
  "price_prediction",
  "forecast_return",
] as const;

export class ExtractionProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionProvenanceError";
  }
}

export interface ExtractedFactDraft {
  readonly instrumentId: string;
  readonly factName: string;
  readonly factValue: Record<string, unknown>;
  readonly sourceRawId?: string | null;
  readonly sourceDocument: string;
  readonly sourcePage?: number | null;
  readonly extractionModel: string;
  readonly extractionVersion?: string;
  readonly publishedAt: Date;
  readonly effectiveAt: Date;
  readonly availableAt: Date;
}

export function assertExtractableFact(draft: ExtractedFactDraft, dataCutoff: Date): void {
  const name = draft.factName.trim();
  if (!name) throw new ExtractionProvenanceError("Extracted facts must name the field.");
  if ((EXTRACTION_FORBIDDEN_FACT_NAMES as readonly string[]).includes(name)) {
    throw new ExtractionProvenanceError(
      `Fact "${name}" is a prediction, not an extraction. LLMs do not write returns.`,
    );
  }
  if (!draft.sourceDocument.trim()) {
    throw new ExtractionProvenanceError(`Fact "${name}" is missing source_document.`);
  }
  if (!draft.extractionModel.trim()) {
    throw new ExtractionProvenanceError(`Fact "${name}" is missing extraction_model.`);
  }
  if (draft.sourcePage != null && draft.sourcePage <= 0) {
    throw new ExtractionProvenanceError(`Fact "${name}" source_page must be a positive page number.`);
  }
  assertClocksAreOrdered(draft, `extract:${name}`);
  assertAvailableAtCutoff(draft.availableAt, dataCutoff, `extract:${name}`);
}

export function toCanonicalExtractedFact(
  draft: ExtractedFactDraft,
  dataCutoff: Date,
): Omit<CanonicalFact, "factId"> {
  assertExtractableFact(draft, dataCutoff);
  return {
    instrumentId: draft.instrumentId,
    factName: draft.factName.trim(),
    factValue: draft.factValue,
    sourceRawId: draft.sourceRawId ?? null,
    sourceDocument: draft.sourceDocument.trim(),
    sourcePage: draft.sourcePage ?? null,
    extractionModel: draft.extractionModel.trim(),
    extractionVersion: draft.extractionVersion?.trim() || STOCK_INTELLIGENCE_EXTRACTION_VERSION,
    publishedAt: draft.publishedAt,
    effectiveAt: draft.effectiveAt,
    availableAt: draft.availableAt,
    dataSchemaVersion: STOCK_INTELLIGENCE_DATA_SCHEMA_VERSION,
  };
}

export function documentCoverage(facts: readonly CanonicalFact[], asOf: Date): number {
  const recent = facts.filter((fact) => fact.availableAt.getTime() <= asOf.getTime());
  if (recent.length === 0) return 0;
  const withDocument = recent.filter((fact) => (fact.sourceDocument ?? "").trim().length > 0);
  return withDocument.length / recent.length;
}
