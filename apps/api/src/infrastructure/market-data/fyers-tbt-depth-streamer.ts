import fyersApi from "fyers-api-v3";
import { EventEmitter } from "node:events";
import type { FyersTokenService } from "./fyers-token-service.js";
import { reconnectDelayMs } from "./fyers-live-streamer.js";
import { parseDepthFrame, type DepthFrame } from "../../modules/market-data/domain/depth-frame.js";

/**
 * One WebSocket to the Fyers tick-by-tick depth feed, re-emitting frames as `frame` events.
 *
 * A second socket alongside `FyersLiveStreamer`, not a replacement. They are physically different
 * endpoints: `fyersDataSocket` (HSM) carries LTP and best bid/ask *price*, while `fyersTbtSocket`
 * carries the 50-level book with sizes and order counts. Nothing here changes what the existing
 * streamer does, and the option-premium mark series keeps flowing from it untouched.
 *
 * ## Four vendor conventions that fail silently, encoded here once
 *
 * Every one of these connects successfully and then delivers **zero frames with no error event** —
 * no `error`, no `servererror`, just silence. They cost most of the Phase 0 spike's debugging time,
 * and they are the reason this class exists rather than a few inline calls at the use site.
 *
 * 1. **Auth is the bare access token.** `fyersDataSocket` wants `appId:accessToken`; this socket
 *    wants the token alone. Passing the HSM form is the silent-failure case, not an auth error.
 * 2. **Channel ids are strings.** `'1'`, not `1`.
 * 3. **A subscription is not active until its channel is resumed.** `subscribe()` registers;
 *    `switchChannel([], ['1'])` activates. Both are required.
 * 4. **`switchChannel` takes arrays.** The SDK's own `subsinfo` uses Sets internally, and passing a
 *    Set here serialises to `{}` on the wire.
 *
 * A fifth, benign: the vendor's `getUrl()` references an unimported `https` and throws
 * `ReferenceError` inside its own try block on every construction, then falls back to a hardcoded
 * and working socket URL. The stderr line is expected and is not ours.
 *
 * ## Silence is the failure mode, so silence is measured
 *
 * A depth feed that dies does not error; it stops. `framesReceived` and `lastFrameAt` are exposed so
 * a caller can distinguish "the book is quiet" from "we are no longer connected to it" — the same
 * distinction that made polling failures loud (HTTP 429) and stream failures invisible.
 */

export interface FyersTbtSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  connect(): void;
  close(): void;
  subscribe(symbols: string[], channel: string, mode: string): void;
  switchChannel(paused: string[], resumed: string[]): void;
  isConnected(): boolean;
}

export interface FyersTbtDepthStreamerOptions {
  tokenService: Pick<FyersTokenService, "getAccessToken">;
  /** Levels kept per side. The feed carries 50; storing all of them is a different problem. */
  levelsToStore?: number;
  /** Vendor channel id. A string, per convention 2 above. */
  channel?: string;
  /** Injectable so the reconnect and parse paths can be exercised without a network. */
  createSocket?: (accessToken: string) => FyersTbtSocketLike;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  /** Injectable clock so a test can assert the receive stamp. */
  now?: () => Date;
}

function log(level: "info" | "error", message: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, source: "FyersTbtDepthStreamer", ...extra });
  if (level === "error") console.error(line);
  else console.info(line);
}

export class FyersTbtDepthStreamer extends EventEmitter {
  private socket: FyersTbtSocketLike | null = null;
  private readonly subscriptions = new Set<string>();
  private connecting = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private closed = false;
  private framesReceived = 0;
  private droppedMessages = 0;
  private lastFrameAt: Date | null = null;

  private readonly levelsToStore: number;
  private readonly channel: string;

  constructor(private readonly options: FyersTbtDepthStreamerOptions) {
    super();
    this.levelsToStore = options.levelsToStore ?? 10;
    this.channel = options.channel ?? "1";
  }

  async connect(): Promise<void> {
    // `connecting` is set synchronously, before the first await, and is not the same guard as
    // `socket`. Checking `socket` alone is insufficient: `getAccessToken()` suspends, so two callers
    // entering before it resolves both see a null socket and both build one. Observed live on the
    // first capture run -- `subscribe()` kicks off a connect for a newly wanted symbol and the
    // caller then awaits `connect()` itself, which opened two sockets against one token and logged
    // "Connected" twice. Both had their `depth` handler bound to this emitter, so every frame would
    // have been counted and persisted twice.
    if (this.socket || this.connecting || this.reconnecting || this.closed) return;
    this.connecting = true;

    try {
      // Convention 1: the bare token. Prefixing the app id is the silent-failure case.
      const accessToken = await this.options.tokenService.getAccessToken();
      const socket = this.options.createSocket
        ? this.options.createSocket(accessToken)
        : (new (fyersApi as unknown as {
          fyersTbtSocket: new (
            auth: string, logPath?: string, logging?: boolean, diffOnly?: boolean,
          ) => FyersTbtSocketLike;
        }).fyersTbtSocket(accessToken, undefined, false, false));
      this.socket = socket;

      socket.on("open", () => {
        this.reconnectAttempts = 0;
        log("info", "Connected to the Fyers TBT depth socket", {
          resubscribing: this.subscriptions.size,
          channel: this.channel,
        });
        if (this.subscriptions.size > 0) this.activate([...this.subscriptions]);
      });

      socket.on("depth", (...args: unknown[]) => {
        // The SDK calls back with (ticker, depth). The depth object is REUSED per symbol, so
        // parseDepthFrame copies every array out of it rather than retaining the reference.
        const ticker = typeof args[0] === "string" ? args[0] : "";
        const frame = parseDepthFrame({
          providerSymbol: ticker,
          raw: args[1],
          receivedAt: (this.options.now ?? (() => new Date()))(),
          levelsToStore: this.levelsToStore,
        });
        if (frame === null) {
          // Counted, not logged per frame: at 1000+ updates/second a per-message log would bury
          // the session's real events and cost more than the capture itself.
          this.droppedMessages += 1;
          return;
        }
        this.framesReceived += 1;
        this.lastFrameAt = frame.receivedAt;
        this.emit("frame", frame);
      });

      socket.on("error", (error: unknown) => {
        log("error", "Fyers TBT depth socket error", { error: String(error) });
      });

      socket.on("servererror", (message: unknown) => {
        // Distinct from a transport error: the server accepted the connection and refused the
        // request. A bad symbol or an unentitled segment arrives here, if it arrives at all.
        log("error", "Fyers TBT depth server error", { detail: String(message) });
      });

      socket.on("close", () => {
        log("info", "Fyers TBT depth socket closed", {
          framesReceived: this.framesReceived,
          droppedMessages: this.droppedMessages,
        });
        this.socket = null;
        this.scheduleReconnect();
      });

      socket.connect();
      this.connecting = false;
    } catch (error) {
      log("error", "Could not open the Fyers TBT depth socket", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.socket = null;
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  /** Conventions 2-4: string channel, subscribe then resume, arrays not Sets. */
  private activate(symbols: string[]): void {
    if (!this.socket) return;
    this.socket.subscribe(symbols, this.channel, "depth");
    this.socket.switchChannel([], [this.channel]);
  }

  subscribe(symbols: string[]): void {
    if (!symbols || symbols.length === 0) return;

    const added: string[] = [];
    for (const symbol of symbols) {
      const normalised = symbol.trim();
      if (normalised === "" || this.subscriptions.has(normalised)) continue;
      this.subscriptions.add(normalised);
      added.push(normalised);
    }

    if (this.isSocketConnected()) {
      if (added.length > 0) this.activate(added);
    } else if (added.length > 0) {
      void this.connect();
    }
  }

  close(): void {
    this.closed = true;
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  /** Enough to tell a quiet book from a dead socket. */
  stats(): { framesReceived: number; droppedMessages: number; lastFrameAt: Date | null } {
    return {
      framesReceived: this.framesReceived,
      droppedMessages: this.droppedMessages,
      lastFrameAt: this.lastFrameAt,
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    // Shared with FyersLiveStreamer rather than reimplemented: a lapsed Fyers credential must not
    // be retried every five seconds forever, and one backoff policy is easier to reason about than
    // two that drift.
    const delay = reconnectDelayMs(this.reconnectAttempts);
    log("info", "Scheduling a Fyers TBT depth reconnect", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    const schedule = this.options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    schedule(() => {
      this.reconnecting = false;
      void this.connect();
    }, delay);
  }

  private isSocketConnected(): boolean {
    return this.socket !== null
      && typeof this.socket.isConnected === "function"
      && this.socket.isConnected();
  }
}
