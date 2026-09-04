import { displayedSnapshot } from "../domain/decay.js";
import { projectOutlook, type ConsumerContext } from "../domain/consumer-context.js";
import { stockIntelligenceHorizons, type StockIntelligenceHorizon } from "../domain/data-quality.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import { ResolveInstrument } from "./resolve-instrument.js";

export class GetStockOutlook {
  constructor(
    private readonly resolveInstrument: ResolveInstrument,
    private readonly store: StockIntelligenceStore,
  ) {}

  async execute(input: {
    query: string;
    horizon?: StockIntelligenceHorizon;
    asOf?: Date;
    context?: ConsumerContext;
  }) {
    const instrument = await this.resolveInstrument.execute(input.query);
    const asOf = input.asOf ?? new Date();
    const horizon = input.horizon ?? "6M";
    if (!stockIntelligenceHorizons.includes(horizon)) {
      throw new Error(`Unsupported horizon "${horizon}".`);
    }
    const snapshots = await this.store.listSnapshotsAsOf(instrument.instrumentId, asOf);
    const snapshot = snapshots
      .filter((row) => row.horizon === horizon)
      .sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime())[0] ?? null;
    if (!snapshot) {
      return {
        instrumentId: instrument.instrumentId,
        symbol: instrument.symbol,
        horizon,
        investorFacing: false,
        status: "INSUFFICIENT_DATA" as const,
        unavailable: {
          headline: "UNAVAILABLE",
          reason: "No prediction snapshot for this name and horizon.",
        },
        outlook: null,
      };
    }
    const marks = await this.store.listDecayMarks(snapshot.snapshotId);
    const displayed = displayedSnapshot(snapshot, marks);
    const holdings = await this.store.listHoldings();
    const watchlist = await this.store.listInvestorWatchlist();
    const context = input.context ?? "watchlist";
    const outlook = projectOutlook({
      snapshot,
      displayed,
      context,
      holding: holdings.find((row) => row.instrumentId === snapshot.instrumentId) ?? null,
      watchlist: watchlist.find((row) => row.instrumentId === snapshot.instrumentId) ?? null,
    });
    return {
      instrumentId: instrument.instrumentId,
      symbol: instrument.symbol,
      horizon,
      investorFacing: displayed.investorFacing,
      status: displayed.status,
      unavailable: displayed.investorFacing ? null : {
        headline: displayed.status === "UNDER_REVIEW" ? "Outlook under review" : "UNAVAILABLE",
        reason: displayed.unavailableReason,
      },
      outlook,
    };
  }
}
