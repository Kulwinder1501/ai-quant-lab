import { loadStoredMarketBars } from "./ingest-market-bars.js";
import { measureReturnToDate } from "./measure-realized-return.js";
import { dueDecayMarks, overlayFromDrawdown, type DecayMarkKind } from "../domain/decay.js";
import type { PredictionSnapshot } from "../domain/snapshot.js";
import type { StockIntelligenceStore } from "../domain/store.js";

export class RecordPredictionDecay {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: { asOf: Date }): Promise<{ marked: number; underReview: number }> {
    const snapshots = await this.store.listSnapshotsAvailableAt(input.asOf);
    let marked = 0;
    let underReview = 0;
    for (const snapshot of snapshots) {
      const counts = await this.markSnapshot(snapshot, input.asOf);
      marked += counts.marked;
      underReview += counts.underReview;
    }
    return { marked, underReview };
  }

  private async markSnapshot(snapshot: PredictionSnapshot, asOf: Date): Promise<{ marked: number; underReview: number }> {
    const existing = await this.store.listDecayMarks(snapshot.snapshotId);
    const due = dueDecayMarks({ snapshot, asOf, existing });
    if (due.length === 0) return { marked: 0, underReview: 0 };
    const bars = await loadStoredMarketBars(this.store, snapshot.instrumentId, asOf);
    const actions = await this.store.listCorporateActionsAsOf(snapshot.instrumentId, asOf);
    let marked = 0;
    let underReview = 0;
    for (const item of due) {
      const measured = measureReturnToDate({
        predictionAsOf: snapshot.predictionAsOf,
        endDate: item.asOf,
        evaluationCutoff: asOf,
        bars,
        actions,
      });
      if (measured.status !== "REALIZED") continue;
      const overlay = overlayFromDrawdown(measured.outcome.maxDrawdown, measured.outcome.priceReturn);
      const kind: DecayMarkKind = item.kind;
      await this.store.insertDecayMark({
        snapshotId: snapshot.snapshotId,
        markKind: kind,
        asOf: item.asOf,
        forwardPriceReturn: measured.outcome.priceReturn,
        forwardTotalReturn: kind === "HORIZON_FINAL" ? measured.outcome.totalReturn : null,
        maxDrawdown: measured.outcome.maxDrawdown,
        outcomeType: kind === "HORIZON_FINAL" ? measured.outcome.outcomeType : null,
        overlayStatus: overlay.overlayStatus,
        reviewFlag: overlay.reviewFlag,
        publishedAt: item.asOf,
        effectiveAt: item.asOf,
        availableAt: asOf,
      });
      marked += 1;
      if (overlay.overlayStatus === "UNDER_REVIEW") underReview += 1;
    }
    return { marked, underReview };
  }
}
