import { isQuoteSessionOpen } from "../../modules/market-data/domain/quote-session.js";

/**
 * The two reasons the API's quote reader stops calling Fyers: the market is shut, or the browser has had its share.
 */

/** Answers "is a quote session open now" from a holiday list it refreshes in the background. */
export class QuoteSessionClock {
  private holidays: ReadonlySet<string> = new Set();
  private loadedAt: number | null = null;
  private loading = false;

  constructor(
    private readonly loadHolidays: () => Promise<string[]>,
    private readonly now: () => number = Date.now,
    private readonly refreshMs: number = 30 * 60_000,
  ) {}

  /**
   * Synchronous, because the reader asks on every request. Until the first holiday list arrives it assumes there are
   * none, which errs towards polling for a moment rather than towards serving a stale quote in a live session.
   */
  isOpen(): boolean {
    this.refreshIfDue();
    return isQuoteSessionOpen(new Date(this.now()), this.holidays);
  }

  private refreshIfDue(): void {
    const at = this.now();
    if (this.loading) return;
    if (this.loadedAt !== null && at - this.loadedAt < this.refreshMs) return;
    this.loading = true;
    this.loadHolidays()
      .then((dates) => {
        this.holidays = new Set(dates);
        this.loadedAt = this.now();
      })
      // A failed load keeps the last list and tries again in a minute.
      .catch(() => {
        this.loadedAt = this.now() - this.refreshMs + 60_000;
      })
      .finally(() => {
        this.loading = false;
      });
  }
}

/**
 * How many quote requests the API may spend in a day.
 *
 * The Fyers limit is 5,000 a day for everything: history, the option chain, the collectors and the API's own quotes.
 * The API's share is capped so a browser left open cannot starve the rest; past the cap the reader serves the quotes
 * it already holds. The count is read from the shared request ledger, so a restart does not reset it, and cached
 * briefly so the check costs nothing per request. If the ledger cannot be read, requests are allowed: the cap protects
 * the quota, and a failed read is not a reason to blank the screens.
 */
export class UiQuoteBudget {
  private count = 0;
  private readAt: number | null = null;
  private reading = false;

  constructor(
    private readonly readCount: () => Promise<number>,
    private readonly cap: number = 2_500,
    private readonly now: () => number = Date.now,
    private readonly cacheMs: number = 30_000,
  ) {}

  allow(): boolean {
    this.refreshIfDue();
    return this.count < this.cap;
  }

  private refreshIfDue(): void {
    const at = this.now();
    if (this.reading) return;
    if (this.readAt !== null && at - this.readAt < this.cacheMs) return;
    this.reading = true;
    this.readCount()
      .then((value) => {
        this.count = value;
        this.readAt = this.now();
      })
      .catch(() => {
        this.readAt = this.now();
      })
      .finally(() => {
        this.reading = false;
      });
  }
}
