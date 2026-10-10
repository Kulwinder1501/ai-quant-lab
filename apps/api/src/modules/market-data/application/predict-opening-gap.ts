import { istSessionDate } from "../../platform/calendar/trading-session.js";
import { OPENING_GAP_CLASSIFIER_INSTRUMENTS } from "../domain/opening-gap-classifier.js";
import { buildOpeningGapPrediction, type OpeningGapPrediction, type OpeningGapPredictionDraft } from "../domain/opening-gap-prediction.js";

/**
 * GIFT Nifty's own overnight change is the driver (read from NSE IX, not Yahoo -- see
 * `nse-ix-client.ts`). Not a real Yahoo/resolver symbol; it is this module's own label for
 * whichever `GlobalCueSource` the CLI wires up, so the CLI can route it to a different client
 * than the supplementary symbols below without this file knowing the difference.
 */
export const OPENING_GAP_DRIVER_SYMBOL = "GIFT_NIFTY";

/** Collected alongside the driver but not used by the classification rule -- see the migration. */
export const OPENING_GAP_SUPPLEMENTARY_SYMBOLS = ["^GSPC", "^N225", "^HSI"] as const;

export interface GlobalCueQuote {
  changePercent: number | null;
}

export interface GlobalCueSource {
  /** Keyed by the symbol as passed in (e.g. "^GSPC"); absent from the map means no usable quote. */
  getChangePercents(symbols: readonly string[]): Promise<Map<string, GlobalCueQuote>>;
}

export interface OpeningGapPredictionStore {
  upsert(prediction: OpeningGapPredictionDraft): Promise<OpeningGapPrediction>;
}

export interface PredictOpeningGapResult {
  sessionDate: string;
  driverAvailable: boolean;
  predicted: number;
  skipped: number;
}

/**
 * Predicts the opening gap for NIFTY50 and BANKNIFTY from GIFT Nifty's own overnight change.
 *
 * Writes nothing when the driver quote is unavailable (NSE IX down, outside its trading hours,
 * an unparseable payload, etc.) rather than persisting a prediction built on an absent number --
 * the same "absent data is an absent row, not a fabricated value" rule this codebase applies
 * everywhere else.
 */
export class PredictOpeningGap {
  constructor(
    private readonly cues: GlobalCueSource,
    private readonly store: OpeningGapPredictionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<PredictOpeningGapResult> {
    const sessionDate = istSessionDate(this.now());
    const symbols = [OPENING_GAP_DRIVER_SYMBOL, ...OPENING_GAP_SUPPLEMENTARY_SYMBOLS];
    const quotes = await this.cues.getChangePercents(symbols);
    const driver = quotes.get(OPENING_GAP_DRIVER_SYMBOL);

    if (!driver || driver.changePercent === null) {
      return {
        sessionDate,
        driverAvailable: false,
        predicted: 0,
        skipped: OPENING_GAP_CLASSIFIER_INSTRUMENTS.length,
      };
    }

    const supplementaryCues: Record<string, number | null> = {};
    for (const symbol of OPENING_GAP_SUPPLEMENTARY_SYMBOLS) {
      supplementaryCues[symbol] = quotes.get(symbol)?.changePercent ?? null;
    }

    let predicted = 0;
    for (const instrumentSymbol of OPENING_GAP_CLASSIFIER_INSTRUMENTS) {
      const prediction = buildOpeningGapPrediction({
        instrumentSymbol,
        sessionDate,
        driverSymbol: OPENING_GAP_DRIVER_SYMBOL,
        driverChangePct: driver.changePercent,
        supplementaryCues,
      });
      await this.store.upsert(prediction);
      predicted += 1;
    }

    return { sessionDate, driverAvailable: true, predicted, skipped: 0 };
  }
}
