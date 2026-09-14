/**
 * One offshore-derivative close (e.g. GIFT Nifty) for a session.
 *
 * A row exists only when a real print was retrieved. There is no such thing as a
 * zero index close, so absent data is represented by the absence of a row rather
 * than by a placeholder price — see `010-institutional-flow-as-of`, which adds a
 * `close_price > 0` check for exactly this reason.
 */
export interface OffshoreDerivative {
  instrumentId: string;
  date: Date;
  closePrice: number;
  /** When the print became publicly known. Point-in-time consumers filter on this. */
  publishedAt: Date;
}
