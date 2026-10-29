import type { SilentSymbolCheck } from "./fyers-live-streamer.js";

const IST_OFFSET_MS = 330 * 60_000;
/** After the open has settled: at 09:15 contracts are only just being asked for, and before it the options send nothing. */
const CHECK_FROM_MINUTE_IST = 9 * 60 + 20;
/** Before the close, when the feed thins out and a quiet symbol means nothing. */
const CHECK_UNTIL_MINUTE_IST = 15 * 60 + 25;
const CHECK_EVERY_MS = 15_000;

/**
 * A weekday between 09:20 and 15:25 IST. A holiday inside the window is not decided here: the caller passes `isSessionOpen`, which
 * knows the exchange holidays. It matters now that a feed quiet as a whole can ask for a restart, because a holiday is quiet all day.
 */
export function isSilentSymbolCheckWindow(now: Date): boolean {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  const weekday = local.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minute >= CHECK_FROM_MINUTE_IST && minute < CHECK_UNTIL_MINUTE_IST;
}

/**
 * Runs the streamer's silent-symbol check every fifteen seconds during the session, and only then: pre-open the options send nothing
 * while the index may already tick, which would look exactly like the failure this exists to catch. A check that throws is reported
 * and the next one still runs. Returns the function that stops it.
 */
export function startFyersStreamerWatchdog(options: {
  streamer: { checkForSilentSymbols(): SilentSymbolCheck };
  now?: () => Date;
  /** Whether the exchange is open today (holidays). Without it the weekday window alone decides. */
  isSessionOpen?: () => boolean;
  report?: (message: string, fields: Record<string, unknown>) => void;
}): () => void {
  const clock = options.now ?? (() => new Date());
  const report = options.report ?? ((message, fields) => console.error(JSON.stringify({ level: "error", message, source: "FyersStreamerWatchdog", ...fields })));
  const check = (): void => {
    if (!isSilentSymbolCheckWindow(clock())) return;
    if (options.isSessionOpen !== undefined && !options.isSessionOpen()) return;
    try {
      options.streamer.checkForSilentSymbols();
    } catch (error) {
      report("The silent-symbol check failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const timer = setInterval(check, CHECK_EVERY_MS);
  // Never the reason the process stays alive.
  timer.unref();
  return () => clearInterval(timer);
}
