const DEFAULT_GRACE_MILLISECONDS = 60 * 60 * 1_000;

export interface ExpiredProvisionalCandleRepository {
  deleteExpiredProvisionalCandles(closedBefore: Date): Promise<number>;
}

export interface ReconcileExpiredProvisionalCandlesInput {
  now?: Date;
  graceMilliseconds?: number;
}

/**
 * Removes partial candles that can no longer be completed by their originating
 * live-collector process. Completed candles are immutable and are never touched.
 * Missing bars remain visible gaps and can be restored from settled provider history.
 */
export class ReconcileExpiredProvisionalCandles {
  constructor(private readonly repository: ExpiredProvisionalCandleRepository) {}

  async execute(input: ReconcileExpiredProvisionalCandlesInput = {}): Promise<{
    closedBefore: Date;
    candlesDeleted: number;
  }> {
    const now = input.now ?? new Date();
    const graceMilliseconds = input.graceMilliseconds ?? DEFAULT_GRACE_MILLISECONDS;
    if (!Number.isFinite(graceMilliseconds) || graceMilliseconds < 0) {
      throw new Error("graceMilliseconds must be a non-negative finite number.");
    }
    const closedBefore = new Date(now.getTime() - graceMilliseconds);
    const candlesDeleted = await this.repository.deleteExpiredProvisionalCandles(closedBefore);
    return { closedBefore, candlesDeleted };
  }
}
