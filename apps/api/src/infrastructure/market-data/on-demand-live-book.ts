import type { LiveQuote } from "./live-quote-cache.js";

/**
 * A live two-sided book for one contract, subscribing it first if the socket is not already carrying it.
 *
 * A manual option buy fills from the live book, then a recent stored tick, and is refused if neither is fresh. The
 * chain stream now covers only the strikes nearest the money (the socket holds about 65 symbols), and the scheduler's
 * stored ticks cover a somewhat wider band, so a strike further out had no fresh quote and its buy was refused even
 * though the market was open. Here the buy asks the socket for just that contract and waits briefly for its first
 * tick, which is enough for a book (a tick that carries only one side does not refresh the other, so both must have
 * arrived).
 *
 * It is a last resort and it is bounded: it returns null after `timeoutMs` and the caller refuses the buy as before,
 * so an illiquid contract that never quotes is still refused rather than filled at a stale price.
 */
export interface OnDemandBookDeps {
  cache: { quote(symbol: string, maxAgeMs: number, now?: number): LiveQuote | null };
  subscriber: { subscribe(symbols: string[]): void } | null | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface OnDemandBookOptions {
  /** How old either side of the book may be. */
  maxAgeMs: number;
  /** How long to wait for the first tick after subscribing. */
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 100;

export async function liveBookOnDemand(
  deps: OnDemandBookDeps,
  symbol: string,
  options: OnDemandBookOptions,
): Promise<LiveQuote | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const existing = deps.cache.quote(symbol, options.maxAgeMs, now());
  if (existing !== null) return existing;
  if (deps.subscriber === null || deps.subscriber === undefined) return null;

  try {
    deps.subscriber.subscribe([symbol]);
  } catch {
    // A socket that will not subscribe has no book to wait for.
    return null;
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    const book = deps.cache.quote(symbol, options.maxAgeMs, now());
    if (book !== null) return book;
  }
  return null;
}
