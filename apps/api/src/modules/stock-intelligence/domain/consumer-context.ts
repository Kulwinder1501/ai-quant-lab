import type { DisplayedSnapshot } from "./decay.js";
import type { PredictionSnapshot } from "./snapshot.js";
import { unavailableReason } from "./snapshot.js";

export const consumerContexts = ["holdings", "watchlist"] as const;
export type ConsumerContext = (typeof consumerContexts)[number];

export interface HoldingOverlay {
  readonly instrumentId: string;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly thesis: string | null;
}

export interface WatchlistOverlay {
  readonly instrumentId: string;
  readonly targetPrice: number | null;
  readonly targetEntry: number | null;
  readonly notes: string | null;
}

export interface ProjectedOutlook {
  readonly context: ConsumerContext;
  readonly instrumentId: string;
  readonly horizon: PredictionSnapshot["horizon"];
  readonly predictionAsOf: string;
  readonly displayed: DisplayedSnapshot;
  readonly calibratedProbabilityPositiveReturn: number | null;
  readonly medianReturn: number | null;
  readonly scenarios: PredictionSnapshot["scenarios"];
  readonly analogueN: number;
  readonly holding: HoldingOverlay | null;
  readonly watchlist: WatchlistOverlay | null;
}

export function projectOutlook(input: {
  snapshot: PredictionSnapshot;
  displayed: DisplayedSnapshot;
  context: ConsumerContext;
  holding?: HoldingOverlay | null;
  watchlist?: WatchlistOverlay | null;
}): ProjectedOutlook {
  return {
    context: input.context,
    instrumentId: input.snapshot.instrumentId,
    horizon: input.snapshot.horizon,
    predictionAsOf: input.snapshot.predictionAsOf.toISOString(),
    displayed: input.displayed.investorFacing
      ? input.displayed
      : {
        ...input.displayed,
        unavailableReason: input.displayed.unavailableReason
          ?? unavailableReason(input.snapshot),
      },
    calibratedProbabilityPositiveReturn: input.snapshot.calibratedProbabilityPositiveReturn,
    medianReturn: input.snapshot.returnDistribution?.p50 ?? null,
    scenarios: input.snapshot.scenarios,
    analogueN: input.snapshot.analogueSet.nCandidates,
    holding: input.context === "holdings" ? input.holding ?? null : null,
    watchlist: input.context === "watchlist" ? input.watchlist ?? null : null,
  };
}
