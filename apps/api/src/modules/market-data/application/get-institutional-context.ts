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
  listRecent?(instrumentId: string, limit: number): Promise<OffshoreDerivative[]>;
}

export interface VolatilityIndexClose {
  date: Date;
  close: number;
  receivedAt: Date;
  source: string;
}

export interface VolatilityIndexReader {
  listDailyCloses(symbol: string, limit: number): Promise<VolatilityIndexClose[]>;
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
  giftNifty: GiftNiftyStatus & {
    history: Array<{ date: string; closePrice: number; domesticClose: number | null; impliedGapBps: number | null; publishedAt: string }>;
    ageInDays: number | null;
    isStale: boolean;
  };
  indiaVix: {
    available: boolean;
    latest: { date: string; close: number; receivedAt: string; source: string } | null;
    history: Array<{ date: string; close: number; receivedAt: string; source: string }>;
    ageInDays: number | null;
    isStale: boolean;
  };
}

const INDIA_VIX_SYMBOL = "INDIAVIX";
const MARKET_CONTEXT_STALENESS_DAYS = 5;

function ageInDays(date: Date, now: Date): number {
  const session = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((today - session) / 86_400_000));
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
    private readonly volatility: VolatilityIndexReader,
    private readonly configuredGiftNiftySymbol: string | null = process.env.GIFT_NIFTY_YAHOO_SYMBOL ?? null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    options: { historySessions?: number } = {},
  ): Promise<InstitutionalContext> {
    const historySessions = options.historySessions ?? DEFAULT_FLOW_HISTORY_SESSIONS;

    const [flowRows, print, vixRows] = await Promise.all([
      this.flows.listRecent(historySessions),
      this.offshore.findLatest(GIFT_NIFTY_INSTRUMENT_ID),
      this.volatility.listDailyCloses(INDIA_VIX_SYMBOL, historySessions),
    ]);

    const offshoreRows = this.offshore.listRecent
      ? await this.offshore.listRecent(GIFT_NIFTY_INSTRUMENT_ID, historySessions)
      : print ? [print] : [];

    const offshoreHistory = await Promise.all(offshoreRows.map(async (row) => {
      const domesticCloseForSession = await this.domesticCloses.findCloseOn(GIFT_NIFTY_DOMESTIC_SYMBOL, row.date);
      return {
        date: row.date.toISOString().slice(0, 10),
        closePrice: row.closePrice,
        domesticClose: domesticCloseForSession,
        impliedGapBps: domesticCloseForSession === null ? null :
          Number((((row.closePrice - domesticCloseForSession) / domesticCloseForSession) * 10_000).toFixed(2)),
        publishedAt: row.publishedAt.toISOString(),
      };
    }));

    const domesticClose = print
      ? await this.domesticCloses.findCloseOn(GIFT_NIFTY_DOMESTIC_SYMBOL, print.date)
      : null;

    const now = this.now();
    const giftAge = print ? ageInDays(print.date, now) : null;
    const vixHistory = vixRows.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      close: row.close,
      receivedAt: row.receivedAt.toISOString(),
      source: row.source,
    }));
    const vixAge = vixRows[0] ? ageInDays(vixRows[0].date, now) : null;
    const giftStatus = buildGiftNiftyStatus({
      print,
      domesticClose,
      configuredSymbol: this.configuredGiftNiftySymbol?.trim() || null,
    });

    return {
      flows: summariseInstitutionalFlows(flowRows, this.now()),
      giftNifty: {
        ...giftStatus,
        history: offshoreHistory,
        ageInDays: giftAge,
        isStale: giftAge === null || giftAge > MARKET_CONTEXT_STALENESS_DAYS,
      },
      indiaVix: {
        available: vixHistory.length > 0,
        latest: vixHistory[0] ?? null,
        history: vixHistory,
        ageInDays: vixAge,
        isStale: vixAge === null || vixAge > MARKET_CONTEXT_STALENESS_DAYS,
      },
    };
  }
}
