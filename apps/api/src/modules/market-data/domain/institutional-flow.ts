/** One published NSE FII/DII print for a single trading session. */
export interface InstitutionalFlow {
  /** The session the figures describe, as reported by NSE — not the collection date. */
  date: Date;
  /**
   * Net cash flows in crore. Null means the value was absent or unparseable
   * upstream; it is never coerced to 0, because 0 is a meaningful reading
   * (balanced buying and selling) and coercion would make missing data
   * indistinguishable from a flat session once it reached the ML feature set.
   */
  fiiCashNetCr: number | null;
  diiCashNetCr: number | null;
  /**
   * Index futures/options net. NSE's `fiidiiTradeReact` endpoint carries cash
   * only, so these stay null until the derivatives report is wired in.
   */
  fiiIndexFuturesNetCr: number | null;
  fiiIndexOptionsNetCr: number | null;
  /**
   * When the figures became publicly known. Flows for session D are published
   * after D closes, so point-in-time consumers must filter on this rather than
   * on `date`.
   */
  publishedAt: Date;
}
