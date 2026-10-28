import { upcomingIndexFutures } from "../../modules/market-data/domain/index-futures-contracts.js";

const IST_OFFSET_MS = 330 * 60_000;
/** Opens a little before the 09:15 session so the volume counter is already being followed when it starts. */
const WATCH_FROM_MINUTE_IST = 9 * 60;
const WATCH_UNTIL_MINUTE_IST = 15 * 60 + 35;
const CHECK_EVERY_MS = 60_000;

/** The two front-month index futures, as the Fyers symbols the live socket takes. Today's front month, never the next. */
export function sideSplitSymbols(now: Date): string[] {
  const today = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  // One per index, nearest first: the same "front month" rule the stored-bar profile uses.
  return upcomingIndexFutures(today, 1).map((contract) => contract.providerInstrumentId);
}

/**
 * A weekday between 09:00 and 15:35 IST. A holiday inside this window only means two symbols that send nothing, so
 * the exchange calendar is not consulted: the point is to keep the socket from being opened at night for nobody.
 */
export function isSideSplitWatchWindow(now: Date): boolean {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  const weekday = local.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minute >= WATCH_FROM_MINUTE_IST && minute < WATCH_UNTIL_MINUTE_IST;
}

/**
 * Keeps the two front-month futures subscribed on the API's live socket during the session, so the live side split
 * counts from the open without anyone having to open the page first. Outside the window it asks for nothing, so an API
 * that is up overnight does not open a Fyers socket just for this. Subscribing is idempotent, so checking every minute
 * also picks up a roll to the next month without a restart. Returns the function that stops it.
 */
export function startLiveSideSplitFeed(options: {
  streamer: { subscribe(symbols: string[]): void };
  now?: () => Date;
}): () => void {
  const clock = options.now ?? (() => new Date());
  const check = (): void => {
    const now = clock();
    if (!isSideSplitWatchWindow(now)) return;
    options.streamer.subscribe(sideSplitSymbols(now));
  };
  check();
  const timer = setInterval(check, CHECK_EVERY_MS);
  // Never the reason the process stays alive.
  timer.unref();
  return () => clearInterval(timer);
}
