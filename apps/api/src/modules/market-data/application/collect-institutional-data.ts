import type { InstitutionalFlow } from "../domain/institutional-flow.js";
import type { OffshoreDerivative } from "../domain/offshore-derivative.js";

/**
 * Ports, not the concrete Postgres/axios classes.
 *
 * The service previously named `PostgresInstitutionalFlowRepository` and
 * `NseApiClient` directly, which is why none of this logic could be tested
 * without a live database and an outbound call to NSE — and why the date and
 * validation bugs it contained went unnoticed.
 */
export interface InstitutionalFlowSource {
  getFiiDiiData(): Promise<InstitutionalFlow>;
  getGiftNiftyData(date: Date): Promise<OffshoreDerivative | null>;
}

export interface InstitutionalFlowStore {
  upsert(flow: InstitutionalFlow): Promise<void>;
}

export interface OffshoreDerivativeStore {
  upsert(derivative: OffshoreDerivative): Promise<void>;
}

export interface CollectInstitutionalDataResult {
  /** The session NSE reported, which is not necessarily the session asked for. */
  flowSessionDate: string | null;
  flowStored: boolean;
  /**
   * True when NSE's latest print is for an earlier session than expected — a
   * holiday, or a run before publication. The row is still stored under its own
   * (correct) date; this flags that the expected session is not yet available.
   */
  flowIsStale: boolean;
  offshoreStored: boolean;
  /** Non-fatal problems worth surfacing without failing the whole collection. */
  warnings: string[];
}

/**
 * Returns the IST trading date for an instant.
 *
 * The collector runs after the close, so "which session are we collecting?" is an
 * IST question. Deriving it from UTC components meant the answer was wrong for
 * anything scheduled between 00:00 and 05:30 IST.
 */
export function istTradingDate(now: Date): Date {
  const istMillis = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMillis);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

export class CollectInstitutionalDataService {
  constructor(
    private readonly source: InstitutionalFlowSource,
    private readonly flowStore: InstitutionalFlowStore,
    private readonly offshoreStore: OffshoreDerivativeStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Collect and persist the latest institutional context.
   *
   * Errors propagate. The previous version caught everything and logged, so the
   * CLI's own handler could never set a non-zero exit code and a permanently
   * broken scraper looked like a successful cron run forever. The GIFT Nifty leg
   * is deliberately non-fatal — no provider is configured by default — but it is
   * reported in `warnings` rather than passing silently.
   */
  async execute(): Promise<CollectInstitutionalDataResult> {
    const expectedSession = istTradingDate(this.now());
    const warnings: string[] = [];

    const flow = await this.source.getFiiDiiData();
    const flowSessionDate = flow.date.toISOString().slice(0, 10);
    const flowIsStale = flow.date.getTime() < expectedSession.getTime();

    if (flowIsStale) {
      warnings.push(
        `NSE's latest FII/DII print is for ${flowSessionDate}, not the expected session ` +
          `${expectedSession.toISOString().slice(0, 10)} (market holiday, or figures not published yet).`,
      );
    }
    if (flow.fiiCashNetCr === null) warnings.push("FII cash net was absent or unparseable and is stored as NULL.");
    if (flow.diiCashNetCr === null) warnings.push("DII cash net was absent or unparseable and is stored as NULL.");

    // Stored under the session NSE reported, never under the collection date.
    await this.flowStore.upsert(flow);

    let offshoreStored = false;
    try {
      const giftNifty = await this.source.getGiftNiftyData(flow.date);
      if (giftNifty) {
        await this.offshoreStore.upsert(giftNifty);
        offshoreStored = true;
      } else {
        warnings.push(
          "No GIFT Nifty quote available; the implied-gap feature stays absent. " +
            "Set GIFT_NIFTY_YAHOO_SYMBOL to a series your data provider actually carries.",
        );
      }
    } catch (error) {
      warnings.push(`GIFT Nifty collection failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { flowSessionDate, flowStored: true, flowIsStale, offshoreStored, warnings };
  }
}
