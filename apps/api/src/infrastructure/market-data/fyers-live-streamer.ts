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
}

export interface FyersLiveStreamerOptions {
  tokenService: Pick<FyersTokenService, "getAccessToken">;
  appId: string;
  /** Injectable so tests can drive connect, message, error and close without a network. */
  createSocket?: (authHeader: string) => FyersDataSocket;
  /** Injectable so a reconnect test does not have to wait in real time. */
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
}

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;

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
  return {
    symbol,
    ltp,
    // Zero means nobody is quoting that side, which is absent rather than a price of zero.
    bid: bid !== null && bid > 0 ? bid : null,
    ask: ask !== null && ask > 0 ? ask : null,
    volume: finiteOrNull(record.vol_traded_today ?? record.volume ?? record.v),
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
  private reconnecting = false;
  private reconnectAttempts = 0;
  private droppedMessages = 0;
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

  constructor(private readonly options: FyersLiveStreamerOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket || this.reconnecting || this.closed) return;

    try {
      const accessToken = await this.options.tokenService.getAccessToken();
      const authHeader = `${this.options.appId}:${accessToken}`;
      const socket = this.options.createSocket
        ? this.options.createSocket(authHeader)
        : (fyersApi.fyersDataSocket.getInstance(authHeader, "./fyers-logs", false) as FyersDataSocket);
      this.socket = socket;

      socket.on("connect", () => {
        // A successful connection is what clears the backoff; clearing it on *attempt* would
        // reset the delay every cycle and reproduce the fixed-interval retry.
        this.reconnectAttempts = 0;
        log("info", "Connected to the Fyers data socket", {
          resubscribing: this.currentSubscriptions.size,
        });
        if (this.currentSubscriptions.size > 0) {
          socket.subscribe([...this.currentSubscriptions]);
        }
      });

      socket.on("message", (payload) => {
        const tick = parseTick(payload);
        if (tick === null) {
          // Counted, not logged per message. The previous version logged every raw tick at
          // info level, which floods a session's container log and hides everything else.
          this.droppedMessages += 1;
          return;
        }
        this.emit("tick", tick);
      });

      socket.on("error", (error) => {
        log("error", "Fyers data socket error", { error: String(error) });
      });

      socket.on("close", () => {
        log("info", "Fyers data socket closed", { droppedMessages: this.droppedMessages });
        this.socket = null;
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

    if (this.isSocketConnected()) this.socket!.subscribe(symbols);
    else if (isNew) void this.connect();
  }

  unsubscribe(symbols: string[]): void {
    if (!symbols || symbols.length === 0) return;
    for (const symbol of symbols) this.currentSubscriptions.delete(symbol);
    if (this.isSocketConnected()) this.socket!.unsubscribe(symbols);
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
