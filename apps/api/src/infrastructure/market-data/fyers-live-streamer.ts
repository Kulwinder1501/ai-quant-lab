import fyersApi from "fyers-api-v3";
import type { FyersTokenService } from "./fyers-token-service.js";
import { EventEmitter } from "node:events";

export interface FyersLiveStreamerOptions {
  tokenService: FyersTokenService;
  appId: string;
}

export interface Tick {
  symbol: string;
  ltp: number;
  bid?: number;
  ask?: number;
  volume?: number;
}

/**
 * Manages a single WebSocket connection to Fyers for live data.
 * Emits "tick" events when new data arrives.
 */
export class FyersLiveStreamer extends EventEmitter {
  private socket: any = null;
  private currentSubscriptions: Set<string> = new Set();
  private reconnecting = false;

  constructor(private readonly options: FyersLiveStreamerOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket || this.reconnecting) return;
    
    try {
      const accessToken = await this.options.tokenService.getAccessToken();
      const authHeader = `${this.options.appId}:${accessToken}`;
      
      // We pass a dummy log path, fyers-api-v3 creates it if enabled
      this.socket = fyersApi.fyersDataSocket.getInstance(authHeader, "./fyers-logs", false);

      this.socket.on("connect", () => {
        console.log("[FyersLiveStreamer] Connected to Data WebSocket.");
        // Resubscribe to existing symbols if this was a reconnect
        if (this.currentSubscriptions.size > 0) {
          this.socket.subscribe(Array.from(this.currentSubscriptions));
        }
      });

      this.socket.on("message", (message: any) => {
        // Fyers api v3 message structure typically contains symbol, ltp, bid, ask
        if (message && message.symbol) {
          console.log("[RAW TICK]", JSON.stringify(message));
          this.emit("tick", {
            symbol: message.symbol,
            ltp: message.ltp ?? message.last_price,
            bid: message.bid_price ?? message.bid ?? message.best_bid,
            ask: message.ask_price ?? message.ask ?? message.best_ask,
            volume: message.vol_traded_today ?? message.volume ?? message.v,
          } as Tick);
        }
      });

      this.socket.on("error", (err: any) => {
        console.error("[FyersLiveStreamer] Error:", err);
      });

      this.socket.on("close", () => {
        console.log("[FyersLiveStreamer] Connection closed.");
        this.socket = null;
        this.scheduleReconnect();
      });

      this.socket.connect();

    } catch (err) {
      console.error("[FyersLiveStreamer] Failed to connect:", err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    setTimeout(() => {
      this.reconnecting = false;
      void this.connect();
    }, 5000);
  }

  /**
   * Subscribes to the given list of symbols. 
   * Note: Fyers has a limit on simultaneous subscriptions.
   */
  subscribe(symbols: string[]) {
    if (!symbols || symbols.length === 0) return;
    
    let isNew = false;
    for (const sym of symbols) {
      if (!this.currentSubscriptions.has(sym)) {
        this.currentSubscriptions.add(sym);
        isNew = true;
      }
    }

    if (this.socket && this.socket.isConnected && this.socket.isConnected()) {
      this.socket.subscribe(symbols);
    } else if (isNew) {
      void this.connect();
    }
  }

  unsubscribe(symbols: string[]) {
    if (!symbols || symbols.length === 0) return;
    for (const sym of symbols) {
      this.currentSubscriptions.delete(sym);
    }
    if (this.socket && this.socket.isConnected && this.socket.isConnected()) {
      this.socket.unsubscribe(symbols);
    }
  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
