import { modelStages, type ModelStage } from "../../model-predictions/domain/model-prediction.js";
import type {
  ListModelVersionsInput,
  ModelPerformanceQueryRepository,
  ModelVersionPerformance,
} from "../domain/model-performance.js";

export const defaultModelVersionLimit = 50;
export const maximumModelVersionLimit = 200;

/** Raised for a client query that cannot be safely interpreted as a read-only filter. */
export class InvalidModelPerformanceQueryError extends Error {}

function normalizeOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidModelPerformanceQueryError(`${field} must not be blank.`);
  }
  return normalized;
}

/** One model family's lineage, newest version first. */
export interface ModelFamilySummary {
  modelKey: string;
  versionCount: number;
  algorithms: string[];
  latestVersion: number;
  productionVersionId: string | null;
  bestValidationMacroF1: number | null;
}

/**
 * Groups versions by family so the dashboard can show which algorithm currently
 * holds each PRODUCTION slot. Ordering is deterministic: newest training first.
 */
export function summarizeModelFamilies(records: readonly ModelVersionPerformance[]): ModelFamilySummary[] {
  const families = new Map<string, ModelVersionPerformance[]>();
  for (const record of records) {
    const existing = families.get(record.modelKey);
    if (existing) {
      existing.push(record);
    } else {
      families.set(record.modelKey, [record]);
    }
  }

  return [...families.entries()]
    .map(([modelKey, versions]) => {
      const macroF1Values = versions
        .map((version) => version.validationMetrics.macroF1)
        .filter((value): value is number => value !== null);
      return {
        modelKey,
        versionCount: versions.length,
        algorithms: [...new Set(versions.map((version) => version.algorithm))].sort(),
        latestVersion: Math.max(...versions.map((version) => version.version)),
        productionVersionId: versions.find((version) => version.stage === "PRODUCTION")?.id ?? null,
        bestValidationMacroF1: macroF1Values.length === 0 ? null : Math.max(...macroF1Values),
      };
    })
    .sort((left, right) => left.modelKey.localeCompare(right.modelKey));
}

/**
 * Lists persisted model versions and their recorded training evidence. This use
 * case is query-only: it cannot train, promote, reject, or archive a model, and
 * it never returns an artifact location.
 */
export class ListModelVersions {
  constructor(private readonly repository: ModelPerformanceQueryRepository) {}

  async execute(input: Partial<ListModelVersionsInput> = {}): Promise<{
    records: ModelVersionPerformance[];
    families: ModelFamilySummary[];
    limit: number;
    truncated: boolean;
  }> {
    const limit = input.limit ?? defaultModelVersionLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumModelVersionLimit) {
      throw new InvalidModelPerformanceQueryError(
        `limit must be an integer between 1 and ${maximumModelVersionLimit}.`,
      );
    }
    const stage = input.stage;
    if (stage !== undefined && !(modelStages as readonly string[]).includes(stage)) {
      throw new InvalidModelPerformanceQueryError(`stage must be one of ${modelStages.join(", ")}.`);
    }

    const candidates = await this.repository.list({
      modelKey: normalizeOptionalText(input.modelKey, "modelKey"),
      algorithm: normalizeOptionalText(input.algorithm, "algorithm"),
      stage: stage as ModelStage | undefined,
      limit: limit + 1,
    });
    const records = candidates.slice(0, limit);
    return {
      records,
      families: summarizeModelFamilies(records),
      limit,
      truncated: candidates.length > limit,
    };
  }
}
