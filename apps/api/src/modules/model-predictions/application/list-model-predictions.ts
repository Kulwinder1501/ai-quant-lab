import type {
  ListModelPredictionsInput,
  ModelPredictionCursor,
  ModelPredictionLabel,
  ModelPredictionQueryRepository,
  ModelPredictionSummary,
} from "../domain/model-prediction.js";

export const defaultPredictionListLimit = 50;
export const maximumPredictionListLimit = 100;

/** Raised for a client query that cannot be safely interpreted as a read-only filter. */
export class InvalidModelPredictionQueryError extends Error {}

function normalizeOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidModelPredictionQueryError(`${field} must not be blank.`);
  }
  return normalized;
}

export class ListModelPredictions {
  constructor(private readonly repository: ModelPredictionQueryRepository) {}

  async execute(input: Partial<ListModelPredictionsInput> = {}): Promise<{
    records: ModelPredictionSummary[];
    limit: number;
    nextCursor: ModelPredictionCursor | null;
  }> {
    const limit = input.limit ?? defaultPredictionListLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumPredictionListLimit) {
      throw new InvalidModelPredictionQueryError(
        `limit must be an integer between 1 and ${maximumPredictionListLimit}.`,
      );
    }

    const instrumentSymbol = normalizeOptionalText(input.instrumentSymbol, "instrument")?.toUpperCase();
    const modelKey = normalizeOptionalText(input.modelKey, "modelKey");
    const timeframe = normalizeOptionalText(input.timeframe, "timeframe");
    const prediction = input.prediction;
    if (prediction !== undefined && !["BULLISH", "BEARISH", "NEUTRAL"].includes(prediction)) {
      throw new InvalidModelPredictionQueryError("prediction must be BULLISH, BEARISH, or NEUTRAL.");
    }
    const cursor = input.cursor;
    if (cursor && (!cursor.id.trim() || Number.isNaN(cursor.createdAt.getTime()))) {
      throw new InvalidModelPredictionQueryError("cursor must contain a valid createdAt and id.");
    }
    if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id)) {
      throw new InvalidModelPredictionQueryError("cursor id must be a UUID.");
    }

    // Ask for one extra row so the API can expose a stable keyset cursor without a COUNT query.
    const candidates = await this.repository.list({
      instrumentSymbol,
      modelKey,
      timeframe,
      prediction: prediction as ModelPredictionLabel | undefined,
      cursor,
      limit: limit + 1,
    });
    const records = candidates.slice(0, limit);
    const lastRecord = records.at(-1);
    const nextCursor = candidates.length > limit && lastRecord
      ? { createdAt: lastRecord.createdAt, id: lastRecord.id }
      : null;
    return { records, limit, nextCursor };
  }
}
