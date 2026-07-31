import type { InstitutionalFlow } from "../domain/institutional-flow.js";
import type { OffshoreDerivative } from "../domain/offshore-derivative.js";
import {
  buildGiftNiftyStatus,
  summariseInstitutionalFlows,
  type GiftNiftyStatus,
  type InstitutionalFlowSummary,
} from "../domain/institutional-flow-summary.js";

/** The offshore contract this read model reports on. */
export const GIFT_NIFTY_INSTRUMENT_ID = "GIFT_NIFTY";

/** The domestic index GIFT Nifty's premium/discount is measured against. */
export const GIFT_NIFTY_DOMESTIC_SYMBOL = "NIFTY50";

export const DEFAULT_FLOW_HISTORY_SESSIONS = 10;

export interface InstitutionalFlowReader {
  listRecent(limit: number): Promise<InstitutionalFlow[]>;
}

export interface OffshoreDerivativeReader {
  findLatest(instrumentId: string): Promise<OffshoreDerivative | null>;
}

/**
 * Resolves the settled domestic close for a session, so an offshore print can be
 * expressed as a premium rather than as a bare number.
 */
export interface DomesticCloseReader {
  findCloseOn(symbol: string, date: Date): Promise<number | null>;
}

export interface InstitutionalContext {
  flows: InstitutionalFlowSummary;
  giftNifty: GiftNiftyStatus;
}

/**
 * Read-only dashboard projection of institutional context.
 *
 * SELECT-only by construction: it takes readers, not repositories, so no caller
 * can reach a write path through it. Both halves degrade independently — an
 * absent GIFT Nifty feed must not blank out the FII/DII card, which is real data.
 */
export class GetInstitutionalContextService {
  constructor(
    private readonly flows: InstitutionalFlowReader,
    private readonly offshore: OffshoreDerivativeReader,
    private readonly domesticCloses: DomesticCloseReader,
    private readonly configuredGiftNiftySymbol: string | null = process.env.GIFT_NIFTY_YAHOO_SYMBOL ?? null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    options: { historySessions?: number } = {},
  ): Promise<InstitutionalContext> {
    const historySessions = options.historySessions ?? DEFAULT_FLOW_HISTORY_SESSIONS;

    const [flowRows, print] = await Promise.all([
      this.flows.listRecent(historySessions),
      this.offshore.findLatest(GIFT_NIFTY_INSTRUMENT_ID),
    ]);

    const domesticClose = print
      ? await this.domesticCloses.findCloseOn(GIFT_NIFTY_DOMESTIC_SYMBOL, print.date)
      : null;

    return {
      flows: summariseInstitutionalFlows(flowRows, this.now()),
      giftNifty: buildGiftNiftyStatus({
        print,
        domesticClose,
        configuredSymbol: this.configuredGiftNiftySymbol?.trim() || null,
      }),
    };
  }
}
