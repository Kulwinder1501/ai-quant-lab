import type { ModelPredictionDetail, ModelPredictionQueryRepository } from "../domain/model-prediction.js";
import { InvalidModelPredictionQueryError } from "./list-model-predictions.js";

/** Looks up persisted research evidence only; it never reruns inference or mutates a record. */
export class GetModelPrediction {
  constructor(private readonly repository: ModelPredictionQueryRepository) {}

  async execute(predictionId: string): Promise<ModelPredictionDetail | null> {
    const normalizedId = predictionId.trim();
    if (!normalizedId) {
      throw new InvalidModelPredictionQueryError("predictionId must not be blank.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedId)) {
      throw new InvalidModelPredictionQueryError("predictionId must be a UUID.");
    }
    return this.repository.findById(normalizedId);
  }
}
