import fyersApi from "fyers-api-v3";
import { EventEmitter } from "node:events";
import type { FyersTokenService } from "./fyers-token-service.js";

/**
 * One WebSocket connection to Fyers, re-emitting quotes as `tick` events.
 *
 * The vendor socket is untyped (`fyers-api-v3` ships `export const fyersDataSocket: any`), so
 * everything crossing that boundary is validated here rather than trusted. The two pieces of
 * logic worth testing -- what counts as a usable tick, and how long to wait before
 * reconnecting -- are pure functions below, and the socket itself is injectable so the
 * reconnect path can be exercised without a network.
 */

/** The minimum surface this class uses. Narrower than the vendor's `any`. */
export interface FyersDataSocket {
  on(event: string, listener: (payload?: unknown) => void): void;
  connect(): void;
  close(): void;
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  isConnected?(): boolean;
}

export interface Tick {
  symbol: string;
  ltp: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  /**
   * The feed's own clocks for this quote, in epoch seconds, when it supplies them.
   *
   * Verified live on 2026-08-24: the socket sends `exch_feed_time` and `last_traded_time` on every
   * message, never null, both carrying session times. They were previously dropped here, which is
   * why every stored quote could only be timed by our own receipt clock.
   *
   * Second-granularity, like the depth feed's equivalents — adequate for a 60-second eligibility
   * window, and not evidence for any sub-second latency claim. Null when absent rather than
   * defaulted: a missing exchange clock is a fact worth keeping, and zero is a real epoch value.
   */
  exchangeFeedTimeSeconds: number | null;
  lastTradeTimeSeconds: number | null;
}

export interface FyersLiveStreamerOptions {
  tokenService: Pick<FyersTokenService, "getAccessToken">;
  appId: string;
  /** Injectable so tests can drive connect, message, error and close without a network. */
  createSocket?: (authHeader: string) => FyersDataSocket;
  /**
   * Whether the socket this streamer gets keeps the first token it was created with. True for the vendor's own socket (a
   * process-wide singleton, see fyers-token-rotation.ts), which is the default when `createSocket` is not injected; false for an
   * injected one unless a test says otherwise.
   */
  socketKeepsFirstToken?: boolean;
  /**
   * Called when the stored access token is no longer the one the socket was created with, so this process can never
   * authenticate with the new one and must be replaced. The host restarts itself. Without it the streamer keeps retrying with
   * the stale token, as it always did. The token is never passed or logged.
   */
  onTokenRotated?: () => void;
  /**
   * Called when the socket is connected but nothing at all has ticked on it for a minute, while symbols asked for long ago are
   * waiting: a dead connection, as on 2026-10-29, when the replacement the watchdog made stayed dead for over two minutes and
   * restarting the process cured it. The host restarts itself and decides whether the market is open and how soon after a start
   * (see fyers-token-rotation.ts). Without it the streamer leaves a feed that is quiet as a whole alone, as it always did.
   */
  onFeedDead?: () => void;
  /** Injectable so a reconnect test does not have to wait in real time. */
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  /**
   * Gap between subscription packets, in milliseconds. Zero sends everything at once.
   *
   * Fyers drops packets when several arrive back to back, and says nothing: two option chains opened together on
   * 2026-10-19 sent eight packets in a burst and one of the two streams kept only its last three symbols (and
   * which one it was changed from run to run). Packets now leave one at a time through a single queue.
   */
  subscribeSpacingMs?: number;
  /**
   * How many distinct symbols one socket connection may be asked for before it is replaced. Fyers holds about 65 per
   * connection and an unsubscribe does not give a slot back, so a long-lived socket fills up as the option chain's
   * strikes move with the index; past the limit new symbols are silently ignored (on 2026-10-22 the BANKNIFTY chain
   * streamed only its index while NIFTY50's kept streaming). Reconnecting resubscribes just the symbols wanted now,
   * which frees every stale slot. Default 64, one under the capacity measured on 2026-10-19 (about 65).
   */
  socketSlotLimit?: number;
  /** Clock for the recycle rate limit; injectable for tests. */
  nowFn?: () => number;
}

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;

/**
 * Fyers WebSocket caps symbols per subscribe packet at 25. Large batches (e.g. 60+ option chain
 * strikes) must be sent in chunks of 20 or fewer to avoid silent drops by the vendor socket.
 */
export const MAX_SOCKET_SUBSCRIBE_CHUNK = 20;

const DEFAULT_SUBSCRIBE_SPACING_MS = 300;
const DEFAULT_SOCKET_SLOT_LIMIT = 64;
/** A socket is not replaced again within this long, so a wanted set that cannot fit does not reconnect in a loop. */
const MIN_RECYCLE_INTERVAL_MS = 60_000;

/*
 * The silent-symbol watchdog. The API's socket has, three times in six days (2026-10-22, 10-26, 10-28), stayed connected and kept
 * delivering the index while the option contracts of one chain never ticked, with no error anywhere. The cause was not found, so the
 * watchdog tests the outcome instead: symbols that were asked for, had time to answer, and never did, while other symbols are ticking.
 */
/** A symbol asked for this long ago and not yet heard from counts as silent. The feed answers a new subscription within seconds. */
const SILENT_GRACE_MS = 30_000;
/** Some symbol must have ticked this recently, or the whole feed is quiet (market closed, or a failure no recycle of this kind addresses). */
const FEED_ALIVE_WINDOW_MS = 10_000;
/** A symbol that did tick and then said nothing for this long, while others tick, is silent too. Option contracts tick about twice a second. */
const STALE_AFTER_MS = 120_000;
/** Fewer silent symbols than this is a dead contract or two (an expired future delivers nothing), not a failed subscription. */
const SILENT_MIN_SYMBOLS = 5;
/** And they must be at least this share of the symbols old enough to judge. */
const SILENT_MIN_SHARE = 0.2;
/** Replacing the socket drops every symbol for several seconds, so this is deliberately slower than the slot recycle. */
const MIN_SILENT_RECYCLE_INTERVAL_MS = 120_000;
/** A refused recycle is reported at most this often, so a stuck condition cannot flood the log. */
const REFUSAL_LOG_INTERVAL_MS = 5 * 60_000;
/**
 * A connection on which no symbol has ticked for this long, with symbols past their grace waiting, is dead. The indices and futures
 * the API holds tick about once a second in the session, so a minute of nothing is not a quiet market. The host gates this by
 * the calendar (a holiday is quiet all day) and the clock; see fyers-streamer-watchdog.ts.
 */
const DEAD_FEED_AFTER_MS = 60_000;

export type SilentSymbolCheck =
  | { action: "NONE"; reason: string; silent: string[] }
  | { action: "RECYCLED" | "REFUSED" | "RESTART_REQUESTED"; reason: string; silent: string[] };

/** What a person needs to see, without a restart, when the feed misbehaves. Symbols only: nothing secret. */
export interface StreamerDiagnostics {
  connected: boolean;
  wantedSymbols: number;
  slotsUsedOnThisConnection: number;
  /** Milliseconds since any symbol last ticked on this process, or null if none has. */
  lastTickAgeMs: number | null;
  /** Wanted symbols old enough to judge that have not ticked (or stopped), at most forty named. */
  silentSymbols: string[];
  silentSymbolCount: number;
  /** Symbols still silent after a replacement: given up on, so they cannot trigger another one. */
  deadSymbols: string[];
  reconnectAttempts: number;
  droppedMessages: number;
  socketReplacements: { forSlots: number; forSilentSymbols: number };
  /** Times the host was asked to restart because the connection delivered nothing at all (see `onFeedDead`). */
  deadFeedRestartsRequested: number;
  lastReplacementAt: string | null;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Backoff for reconnection, doubling to a five-minute ceiling.
 *
 * A fixed 5s retry was worse than it looks: Fyers auth lapses every 15 days with no
 * non-interactive path, so a lapsed credential meant reconnecting every 5 seconds forever,
 * and each attempt calls `getAccessToken()` -- which takes a row lock and can spend a refresh
 * against the provider. An overnight failure was thousands of those.
 */
export function reconnectDelayMs(attempt: number): number {
  const bounded = Math.max(1, Math.floor(attempt));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (bounded - 1));
}

/**
 * What a non-tick message says, when it reads as a refusal or an error, otherwise null.
 *
 * Every message that cannot become a tick is counted as dropped, and for a long time that was all that was known
 * about them -- including the one Fyers sends when a subscription is refused. A socket that quietly delivers
 * three of 63 requested symbols looked exactly like a quiet market.
 */
export function describeControlMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  const code = typeof record.code === "number" ? record.code : null;
  const text = typeof record.message === "string" ? record.message : null;
  const failed = record.s === "error" || (code !== null && code < 0);
  if (!failed) return null;
  return JSON.stringify({ s: record.s ?? null, code, message: text });
}

/** Readable text for whatever the Fyers SDK passes to its error callback. Never includes the auth header. */
export function describeSocketError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    // A browser-style error event keeps its fields non-enumerable, so a plain stringify of it is "{}".
    const own = JSON.stringify(error, Object.getOwnPropertyNames(error));
    if (own !== undefined && own !== "{}") return own.slice(0, 500);
    const named = (error as { constructor?: { name?: string } }).constructor?.name;
    return `${named ?? "object"} with no readable fields`;
  }
  try {
    return JSON.stringify(error)?.slice(0, 500) ?? String(error);
  } catch {
    return String(error);
  }
}

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/**
 * A tick, or null when the message cannot produce one.
 *
 * The field names are a fallback chain because the provider is inconsistent across payload
 * types. The important part is the refusal: the previous version emitted
 * `{ ltp: message.ltp ?? message.last_price }` typed as `number`, so a payload carrying
 * neither produced a Tick whose `ltp` was `undefined` while claiming to be a number. That
 * reached the browser, made `currentSpot` undefined, and silently stopped the chain
 * repricing rather than reporting anything.
 *
 * A price of zero is refused too: Fyers uses 0 for "no quote", and marking against it would
 * price a contract at nothing.
 */
export function parseTick(message: unknown): Tick | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;

  const symbol = typeof record.symbol === "string" ? record.symbol.trim() : "";
  if (symbol === "") return null;

  const ltp = finiteOrNull(record.ltp ?? record.last_price);
  if (ltp === null || ltp <= 0) return null;

  const bid = finiteOrNull(record.bid_price ?? record.bid ?? record.best_bid);
  const ask = finiteOrNull(record.ask_price ?? record.ask ?? record.best_ask);
  // Zero is refused for the clocks too, and for the same reason as the prices: the feed uses it as
  // "no value", and epoch zero would date every such quote to 1970.
  const exchangeFeedTimeSeconds = finiteOrNull(record.exch_feed_time ?? record.fdtm);
  const lastTradeTimeSeconds = finiteOrNull(record.last_traded_time ?? record.ltt);
  return {
    symbol,
    ltp,
    // Zero means nobody is quoting that side, which is absent rather than a price of zero.
    bid: bid !== null && bid > 0 ? bid : null,
    ask: ask !== null && ask > 0 ? ask : null,
    volume: finiteOrNull(record.vol_traded_today ?? record.volume ?? record.v),
    exchangeFeedTimeSeconds: exchangeFeedTimeSeconds !== null && exchangeFeedTimeSeconds > 0 ? exchangeFeedTimeSeconds : null,
    lastTradeTimeSeconds: lastTradeTimeSeconds !== null && lastTradeTimeSeconds > 0 ? lastTradeTimeSeconds : null,
  };
}

function log(level: "info" | "error", message: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, source: "FyersLiveStreamer", ...extra });
  if (level === "error") console.error(line);
  else console.info(line);
}

export class FyersLiveStreamer extends EventEmitter {
  private socket: FyersDataSocket | null = null;
  private readonly currentSubscriptions = new Set<string>();
  /** Every symbol requested on the current connection, whether or not it was later unsubscribed: each used a slot. */
  private readonly socketSlots = new Set<string>();
  private recycling = false;
  private lastRecycleAt = 0;
  private overCapacityLogged = false;
  /** When each symbol was first asked for on this connection (since it was last unsubscribed). Cleared on every new connection. */
  private readonly subscribedAt = new Map<string, number>();
  /** When each symbol last ticked on this connection. Cleared on every new connection, and when a symbol is asked for afresh. */
  private readonly lastTickAt = new Map<string, number>();
  /** The last tick of any symbol, on any connection: whether the feed as a whole is alive. */
  private lastAnyTickAt: number | null = null;
  /** The symbols that were silent when the socket was last replaced for them; still silent afterwards means given up on. */
  private readonly silentBeforeReplacement = new Set<string>();
  private readonly deadSymbols = new Set<string>();
  private replacementsForSlots = 0;
  private replacementsForSilentSymbols = 0;
  private lastReplacementAt: number | null = null;
  /** When the current connection was confirmed, or null with no connection: what "nothing has ticked on this connection" is measured from. */
  private connectedAt: number | null = null;
  private deadFeedRestartsRequested = 0;
  private deadFeedLoggedOnThisConnection = false;
  private lastRefusalLoggedAt = 0;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private droppedMessages = 0;
  private readonly reportedControlMessages = new Set<string>();
  /** Subscription packets waiting to be sent, in order, shared by every caller. */
  private readonly outbox: Array<{ operation: "subscribe" | "unsubscribe"; symbols: string[] }> = [];
  private draining = false;
  /**
   * Set by `close()` so a deliberate shutdown is not read as a dropped connection.
   *
   * `socket.close()` fires the vendor's `close` event, which is the same event a network drop
   * fires, so without this the reconnect handler treats shutdown as failure and dials back in
   * forever. Observed directly: closing the socket and ending the pool produced an unbounded
   * backoff loop logging "Cannot use a pool after calling end on the pool" -- the reconnect was
   * asking a closed pool for a token. The scheduler's `process.exit(0)` hid this in production;
   * any host that waits for a clean exit would hang.
   */
  private closed = false;
  /** The token the socket was created with, once it exists, when the socket keeps it (see `socketKeepsFirstToken`). */
  private firstSocketToken: string | null = null;
  private rotationLogged = false;

  constructor(private readonly options: FyersLiveStreamerOptions) {
    super();
  }

  private socketKeepsFirstToken(): boolean {
    return this.options.socketKeepsFirstToken ?? this.options.createSocket === undefined;
  }

  /**
   * True when the stored token differs from the one this process's socket was created with and the host has been told.
   * Compared by value, never logged. With no host handler it returns false and the caller connects as before.
   */
  private reportedStaleSocketToken(accessToken: string): boolean {
    if (!this.socketKeepsFirstToken() || this.firstSocketToken === null || this.firstSocketToken === accessToken) return false;
    if (!this.rotationLogged) {
      this.rotationLogged = true;
      log("info", "The Fyers access token changed after this socket was created; the vendor socket keeps its first token, so this process has to restart to use the new one", {
        hostWillRestart: this.options.onTokenRotated !== undefined,
      });
    }
    if (this.options.onTokenRotated === undefined) return false;
    this.options.onTokenRotated();
    return true;
  }

  async connect(): Promise<void> {
    if (this.socket || this.reconnecting || this.closed) return;

    try {
      const accessToken = await this.options.tokenService.getAccessToken();
      if (this.reportedStaleSocketToken(accessToken)) {
        // The host decides when to restart (it may refuse a restart this soon after start); keep trying to reconnect meanwhile.
        this.scheduleReconnect();
        return;
      }
      const authHeader = `${this.options.appId}:${accessToken}`;
      const socket = this.options.createSocket
        ? this.options.createSocket(authHeader)
        : (fyersApi.fyersDataSocket.getInstance(authHeader, "./fyers-logs", false) as FyersDataSocket);
      if (this.socketKeepsFirstToken() && this.firstSocketToken === null) this.firstSocketToken = accessToken;
      this.socket = socket;

      socket.on("connect", () => {
        // A successful connection is what clears the backoff; clearing it on *attempt* would
        // reset the delay every cycle and reproduce the fixed-interval retry.
        this.reconnectAttempts = 0;
        this.connectedAt = this.now();
        this.deadFeedLoggedOnThisConnection = false;
        log("info", "Connected to the Fyers data socket", {
          resubscribing: this.currentSubscriptions.size,
        });
        // Whatever was queued for the previous connection is moot: everything wanted is sent again below.
        this.outbox.length = 0;
        this.socketSlots.clear();
        // What a symbol has said, or when it was asked for, belongs to one connection: a new one starts every symbol afresh.
        this.subscribedAt.clear();
        this.lastTickAt.clear();
        if (this.currentSubscriptions.size > 0) {
          for (const symbol of this.currentSubscriptions) this.socketSlots.add(symbol);
          this.send("subscribe", [...this.currentSubscriptions]);
        }
      });

      socket.on("message", (payload) => {
        const tick = parseTick(payload);
        if (tick === null) {
          // Counted, not logged per message. The previous version logged every raw tick at
          // info level, which floods a session's container log and hides everything else.
          this.droppedMessages += 1;
          const refusal = describeControlMessage(payload);
          // Each distinct refusal once, and no more than twenty kinds: a socket that is being refused
          // repeatedly must not turn the log into the thing that hides everything else.
          if (refusal !== null && !this.reportedControlMessages.has(refusal) && this.reportedControlMessages.size < 20) {
            this.reportedControlMessages.add(refusal);
            log("error", "Fyers data socket refused or reported an error", { response: refusal });
          }
          return;
        }
        const receivedAt = this.now();
        this.lastTickAt.set(tick.symbol, receivedAt);
        this.lastAnyTickAt = receivedAt;
        if (this.deadSymbols.size > 0) this.deadSymbols.delete(tick.symbol);
        this.emit("tick", tick);
      });

      socket.on("error", (error) => {
        // The SDK hands over plain objects (Fyers' own error replies) as well as Errors; String() turned every one of
        // them into "[object Object]", which hid why the API's socket reconnected every two minutes on 2026-10-21.
        log("error", "Fyers data socket error", { error: describeSocketError(error) });
      });

      socket.on("close", () => {
        log("info", "Fyers data socket closed", { droppedMessages: this.droppedMessages });
        this.socket = null;
        this.connectedAt = null;
        this.recycling = false;
        this.scheduleReconnect();
      });

      socket.connect();
    } catch (error) {
      log("error", "Could not open the Fyers data socket", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.socket = null;
      this.scheduleReconnect();
    }
  }

  /** Messages that could not produce a tick. Exposed so a caller can see silent drops. */
  droppedMessageCount(): number {
    return this.droppedMessages;
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const delay = reconnectDelayMs(this.reconnectAttempts);
    log("info", "Scheduling a Fyers reconnect", { attempt: this.reconnectAttempts, delayMs: delay });
    const schedule = this.options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    schedule(() => {
      this.reconnecting = false;
      void this.connect();
    }, delay);
  }

  /** Fyers caps simultaneous subscriptions; the caller is responsible for staying under it. */
  subscribe(symbols: string[]): void {
    if (!symbols || symbols.length === 0) return;

    let isNew = false;
    for (const symbol of symbols) {
      if (!this.currentSubscriptions.has(symbol)) {
        this.currentSubscriptions.add(symbol);
        isNew = true;
      }
    }

    // A socket on its way out is not sent to; the new connection subscribes everything wanted.
    if (this.recycling) return;

    if (this.isSocketConnected()) {
      const fresh = symbols.filter((symbol) => !this.socketSlots.has(symbol));
      const limit = this.options.socketSlotLimit ?? DEFAULT_SOCKET_SLOT_LIMIT;
      if (fresh.length > 0 && this.socketSlots.size + fresh.length > limit) {
        const attempt = this.tryRecycleSocket(limit);
        if (attempt.recycled) return;
        // Until now a refused recycle was silent: the symbols were sent to a socket that is probably full, which ignores them
        // without a word. Say so, at most once in a while.
        this.logRefusedRecycle(attempt.reason, { slotsUsed: this.socketSlots.size, wanted: this.currentSubscriptions.size, limit, newSymbols: fresh.length });
      }
      for (const symbol of fresh) this.socketSlots.add(symbol);
      this.send("subscribe", symbols);
    } else if (isNew) {
      void this.connect();
    }
  }

  private now(): number {
    return (this.options.nowFn ?? Date.now)();
  }

  /**
   * Replaces the connection so the slots used by symbols no longer wanted are freed. Only when what is wanted now fits
   * (otherwise a new connection would be just as full) and not more than once a minute. The vendor socket's own close
   * event then reconnects, after the usual short delay, and resubscribes the wanted set.
   */
  private tryRecycleSocket(limit: number): { recycled: true } | { recycled: false; reason: string } {
    if (this.currentSubscriptions.size > limit) {
      if (!this.overCapacityLogged) {
        this.overCapacityLogged = true;
        log("error", "More symbols are wanted than one Fyers socket holds; the extra will not stream", {
          wanted: this.currentSubscriptions.size,
          limit,
        });
      }
      return { recycled: false, reason: "MORE_WANTED_THAN_ONE_SOCKET_HOLDS" };
    }
    if (this.socket === null) return { recycled: false, reason: "NO_SOCKET" };
    if (this.now() - this.lastRecycleAt < MIN_RECYCLE_INTERVAL_MS) return { recycled: false, reason: "REPLACED_TOO_RECENTLY" };
    const replaced = this.replaceSocket("Replacing the Fyers data socket to free subscription slots", {
      slotsUsed: this.socketSlots.size,
      wanted: this.currentSubscriptions.size,
      limit,
    });
    if (!replaced) return { recycled: false, reason: "CLOSE_FAILED" };
    this.replacementsForSlots += 1;
    return { recycled: true };
  }

  /** Closes the current socket on purpose; its own close event reconnects and resubscribes what is wanted. */
  private replaceSocket(message: string, extra: Record<string, unknown>): boolean {
    if (this.socket === null) return false;
    this.lastRecycleAt = this.now();
    this.lastReplacementAt = this.lastRecycleAt;
    this.recycling = true;
    this.reconnectAttempts = 0;
    log("info", message, extra);
    try {
      this.socket.close();
    } catch (error) {
      log("error", "Could not close the Fyers data socket to recycle it", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.recycling = false;
      return false;
    }
    return true;
  }

  private logRefusedRecycle(reason: string, extra: Record<string, unknown>): void {
    const now = this.now();
    if (now - this.lastRefusalLoggedAt < REFUSAL_LOG_INTERVAL_MS) return;
    this.lastRefusalLoggedAt = now;
    log("error", "The Fyers socket could not be replaced; symbols sent to it now may not stream", { reason, ...extra });
  }

  /**
   * Symbols that were asked for on this connection long enough ago to have answered, and have not (or stopped). `judged` is how many
   * symbols were old enough to judge, the denominator for "a real share of them".
   */
  private findSilentSymbols(now: number): { silent: string[]; judged: number } {
    const silent: string[] = [];
    let judged = 0;
    for (const symbol of this.currentSubscriptions) {
      if (this.deadSymbols.has(symbol)) continue;
      const askedAt = this.subscribedAt.get(symbol);
      if (askedAt === undefined || now - askedAt < SILENT_GRACE_MS) continue;
      judged += 1;
      const lastTick = this.lastTickAt.get(symbol);
      if (lastTick === undefined || now - lastTick > STALE_AFTER_MS) silent.push(symbol);
    }
    return { silent, judged };
  }

  /**
   * Replaces the socket when the feed is alive but a real share of what was asked for never answered. Called by the host on a timer
   * (during the session only); it never schedules anything itself, so a test can drive it with `nowFn`.
   *
   * It acts only when ticks are arriving for some symbols, because a feed that is quiet as a whole (market closed, holiday) is not
   * this failure. A symbol still silent after one replacement is given up on, because an expired contract delivers nothing and would
   * otherwise be replaced for forever; it counts again the moment it ticks or is unsubscribed.
   */
  checkForSilentSymbols(): SilentSymbolCheck {
    if (this.closed) return { action: "NONE", reason: "The streamer is closed.", silent: [] };
    if (this.recycling || !this.isSocketConnected()) {
      return { action: "NONE", reason: "The socket is not connected; the reconnect asks again for everything wanted.", silent: [] };
    }
    const now = this.now();
    const deadFeed = this.checkDeadFeed(now);
    if (deadFeed !== null) return deadFeed;
    const { silent: allSilent, judged } = this.findSilentSymbols(now);

    // Second chance used: still silent on the new connection means dead. Ones that ticked since are cleared.
    // Not while nothing at all has ticked on this connection: that silence is the connection's, not the symbols', and giving up on
    // every symbol because the socket is dead would leave nothing for the next connection to be judged on.
    const stillSilent = this.lastTickAt.size === 0 ? [] : allSilent.filter((symbol) => this.silentBeforeReplacement.has(symbol));
    for (const symbol of [...this.silentBeforeReplacement]) {
      if (this.lastTickAt.has(symbol) || !this.currentSubscriptions.has(symbol)) this.silentBeforeReplacement.delete(symbol);
    }
    if (stillSilent.length > 0) {
      for (const symbol of stillSilent) {
        this.deadSymbols.add(symbol);
        this.silentBeforeReplacement.delete(symbol);
      }
      log("error", "Fyers symbols stayed silent after the socket was replaced; treating them as dead and no longer counting them", {
        count: stillSilent.length,
        sample: stillSilent.slice(0, 10),
      });
    }
    const silent = allSilent.filter((symbol) => !this.deadSymbols.has(symbol));

    if (this.lastAnyTickAt === null || now - this.lastAnyTickAt > FEED_ALIVE_WINDOW_MS) {
      return { action: "NONE", reason: "No symbol has ticked in the last ten seconds, so the whole feed is quiet; that is not a failed subscription.", silent };
    }
    if (silent.length < SILENT_MIN_SYMBOLS || silent.length < SILENT_MIN_SHARE * judged) {
      return { action: "NONE", reason: `${silent.length} silent of ${judged} old enough to judge: too few to call a failed subscription.`, silent };
    }
    const sinceLast = now - this.lastRecycleAt;
    if (sinceLast < MIN_SILENT_RECYCLE_INTERVAL_MS) {
      const reason = `The socket was replaced ${Math.round(sinceLast / 1000)} s ago; not again so soon.`;
      this.logRefusedRecycle("REPLACED_TOO_RECENTLY", { silentSymbols: silent.length, judged });
      return { action: "REFUSED", reason, silent };
    }

    for (const symbol of silent) this.silentBeforeReplacement.add(symbol);
    const replaced = this.replaceSocket("The Fyers socket is connected and ticking, but symbols it was asked for never answered; replacing it", {
      silentSymbols: silent.length,
      judged,
      sample: silent.slice(0, 8),
      wanted: this.currentSubscriptions.size,
      slotsUsed: this.socketSlots.size,
      lastTickAgeMs: now - this.lastAnyTickAt,
    });
    if (!replaced) {
      for (const symbol of silent) this.silentBeforeReplacement.delete(symbol);
      return { action: "REFUSED", reason: "The socket could not be closed.", silent };
    }
    this.replacementsForSilentSymbols += 1;
    return { action: "RECYCLED", reason: `${silent.length} of ${judged} symbols never answered; the socket was replaced.`, silent };
  }

  /**
   * A connection that is up, has symbols asked for long enough ago to have answered, and has delivered nothing from any of them for a
   * minute. Asks the host to restart (see `onFeedDead`) and returns that; null when the feed is not dead, or when there is no host
   * handler, in which case the checks below apply as before. The host is asked on every check while this holds, because it may refuse
   * (a process that has only just started); it is told once in the log per connection.
   */
  private checkDeadFeed(now: number): SilentSymbolCheck | null {
    if (this.options.onFeedDead === undefined || this.connectedAt === null) return null;
    let waiting = 0;
    for (const symbol of this.currentSubscriptions) {
      const askedAt = this.subscribedAt.get(symbol);
      if (askedAt !== undefined && now - askedAt >= SILENT_GRACE_MS) waiting += 1;
    }
    if (waiting === 0) return null;
    // A tick on an earlier connection says nothing about this one, so the clock never starts before this connection did.
    const quietMs = now - Math.max(this.connectedAt, this.lastAnyTickAt ?? 0);
    if (quietMs < DEAD_FEED_AFTER_MS) return null;
    if (!this.deadFeedLoggedOnThisConnection) {
      this.deadFeedLoggedOnThisConnection = true;
      log("error", "The Fyers socket is connected but nothing has ticked on it; the host is asked to restart", {
        quietSeconds: Math.round(quietMs / 1000),
        waitingSymbols: waiting,
        wanted: this.currentSubscriptions.size,
        slotsUsed: this.socketSlots.size,
      });
    }
    this.deadFeedRestartsRequested += 1;
    this.options.onFeedDead();
    return {
      action: "RESTART_REQUESTED",
      reason: `Nothing has ticked on this connection for ${Math.round(quietMs / 1000)} s with ${waiting} symbols waiting; the host was asked to restart.`,
      silent: [...this.currentSubscriptions],
    };
  }

  /** The state a person needs when the feed misbehaves, so the next occurrence is captured before anything is restarted. */
  diagnostics(): StreamerDiagnostics {
    const now = this.now();
    const { silent } = this.findSilentSymbols(now);
    return {
      connected: this.isSocketConnected(),
      wantedSymbols: this.currentSubscriptions.size,
      slotsUsedOnThisConnection: this.socketSlots.size,
      lastTickAgeMs: this.lastAnyTickAt === null ? null : now - this.lastAnyTickAt,
      silentSymbols: silent.slice(0, 40),
      silentSymbolCount: silent.length,
      deadSymbols: [...this.deadSymbols].slice(0, 40),
      reconnectAttempts: this.reconnectAttempts,
      droppedMessages: this.droppedMessages,
      socketReplacements: { forSlots: this.replacementsForSlots, forSilentSymbols: this.replacementsForSilentSymbols },
      deadFeedRestartsRequested: this.deadFeedRestartsRequested,
      lastReplacementAt: this.lastReplacementAt === null ? null : new Date(this.lastReplacementAt).toISOString(),
    };
  }

  /** When a symbol was first asked for on this connection; an unsubscribe wipes it, so a later subscribe starts afresh. */
  private noteSent(operation: "subscribe" | "unsubscribe", symbols: string[]): void {
    const now = this.now();
    for (const symbol of symbols) {
      if (operation === "unsubscribe") {
        this.subscribedAt.delete(symbol);
        this.lastTickAt.delete(symbol);
      } else if (!this.subscribedAt.has(symbol)) {
        this.subscribedAt.set(symbol, now);
        this.lastTickAt.delete(symbol);
      }
    }
  }

  unsubscribe(symbols: string[]): void {
    if (!symbols || symbols.length === 0) return;
    for (const symbol of symbols) this.currentSubscriptions.delete(symbol);
    for (const symbol of symbols) {
      this.deadSymbols.delete(symbol);
      this.silentBeforeReplacement.delete(symbol);
    }
    if (this.isSocketConnected() && !this.recycling) {
      this.send("unsubscribe", symbols);
    }
  }

  private send(operation: "subscribe" | "unsubscribe", symbols: string[]): void {
    for (const batch of chunkArray(symbols, MAX_SOCKET_SUBSCRIBE_CHUNK)) {
      this.outbox.push({ operation, symbols: batch });
    }
    this.drainOutbox();
  }

  /** Sends the queued packets one at a time, `subscribeSpacingMs` apart. The first goes out immediately. */
  private drainOutbox(): void {
    if (this.draining) return;
    const spacing = this.options.subscribeSpacingMs ?? DEFAULT_SUBSCRIBE_SPACING_MS;
    this.draining = true;
    const step = (): void => {
      const next = this.outbox.shift();
      if (next === undefined) {
        this.draining = false;
        return;
      }
      // A socket that has gone is skipped, not retried: the connect handler sends everything wanted again.
      if (this.socket !== null) {
        try {
          this.socket[next.operation](next.symbols);
          this.noteSent(next.operation, next.symbols);
        } catch (error) {
          log("error", "Could not send a Fyers subscription packet", {
            operation: next.operation,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (spacing <= 0) {
        step();
        return;
      }
      const schedule = this.options.setTimeoutFn ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
      schedule(step, spacing);
    };
    step();
  }

  /** Shuts the socket for good. A closed streamer stays closed; `connect()` becomes a no-op. */
  close(): void {
    this.closed = true;
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  private isSocketConnected(): boolean {
    // `isConnected` is optional on the vendor object, so its absence must not be read as
    // connected -- sending to a closed socket throws inside the vendor library.
    return this.socket !== null
      && typeof this.socket.isConnected === "function"
      && this.socket.isConnected();
  }
}
