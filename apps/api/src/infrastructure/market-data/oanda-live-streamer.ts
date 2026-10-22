import { EventEmitter } from "node:events";

export interface OandaTick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  time: Date;
  isTradeable: boolean;
  liquidity?: {
    bid: number;
    ask: number;
  };
  receivedAt: Date;
}

export interface OandaSynthetic1mCandle {
  symbol: string;
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
}

export interface OandaLiveStreamerOptions {
  accountId: string;
  accessToken: string;
  symbols?: string[]; // Defaults to ["XAU_USD"]
  environment?: "practice" | "trade";
  baseUrl?: string;
  synthesize1mCandles?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  fetchFn?: typeof fetch;
}

interface InProgress1mCandle {
  minuteBucket: number; // UTC minute timestamp (floored to :00)
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
}

export class OandaLiveStreamer extends EventEmitter {
  private readonly accountId: string;
  private readonly accessToken: string;
  private readonly symbols: string[];
  private readonly baseUrl: string;
  private readonly synthesize1mCandles: boolean;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly fetchFn: typeof fetch;

  private isRunning = false;
  private abortController: AbortController | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // In-memory state (Zero DB writes!)
  private readonly latestQuotes = new Map<string, OandaTick>();
  private readonly inProgressCandles = new Map<string, InProgress1mCandle>();
  private lastHeartbeatAt: Date | null = null;

  constructor(options: OandaLiveStreamerOptions) {
    super();
    this.accountId = options.accountId;
    this.accessToken = options.accessToken;
    this.symbols = options.symbols ?? ["XAU_USD"];
    this.synthesize1mCandles = options.synthesize1mCandles ?? true;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 2000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

    if (options.baseUrl) {
      this.baseUrl = options.baseUrl;
    } else {
      this.baseUrl = options.environment === "trade"
        ? "https://stream-fxtrade.oanda.com"
        : "https://stream-fxpractice.oanda.com";
    }
  }

  /**
   * Starts the streaming connection to OANDA.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * Stops the streaming connection and clears timers.
   */
  disconnect(): void {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.emit("disconnected");
  }

  /**
   * Returns the most recent tick received for the symbol.
   */
  getLatestQuote(symbol: string): OandaTick | null {
    return this.latestQuotes.get(symbol) ?? null;
  }

  /**
   * Returns the last traded mid-price.
   */
  getLastPrice(symbol: string): number | null {
    const q = this.latestQuotes.get(symbol);
    return q ? q.mid : null;
  }

  /**
   * Returns current spread in currency units (e.g. 0.30 USD on Gold).
   */
  getSpread(symbol: string): number | null {
    const q = this.latestQuotes.get(symbol);
    return q ? q.spread : null;
  }

  /**
   * Checks whether the in-memory quote was received within `maxAgeMs`.
   */
  isFresh(symbol: string, maxAgeMs = 5000): boolean {
    const q = this.latestQuotes.get(symbol);
    if (!q) return false;
    return Date.now() - q.receivedAt.getTime() <= maxAgeMs;
  }

  getLastHeartbeatTime(): Date | null {
    return this.lastHeartbeatAt;
  }

  /**
   * Parses and processes a single raw NDJSON line from OANDA pricing stream.
   * Exposed public for testing and synthetic replay.
   */
  processStreamLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let payload: any;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      // Ignore partial or malformed chunk
      return;
    }

    if (payload.type === "HEARTBEAT") {
      this.lastHeartbeatAt = new Date(payload.time ?? Date.now());
      this.emit("heartbeat", this.lastHeartbeatAt);
      return;
    }

    if (payload.type === "PRICE") {
      const symbol = payload.instrument;
      const bid = parseFloat(payload.closeoutBid ?? payload.bids?.[0]?.price ?? "0");
      const ask = parseFloat(payload.closeoutAsk ?? payload.asks?.[0]?.price ?? "0");

      if (bid <= 0 || ask <= 0) return;

      const mid = Number(((bid + ask) / 2).toFixed(4));
      const spread = Number((ask - bid).toFixed(4));
      const tickTime = payload.time ? new Date(payload.time) : new Date();
      const receivedAt = new Date();

      const tick: OandaTick = {
        symbol,
        bid,
        ask,
        mid,
        spread,
        time: tickTime,
        isTradeable: payload.status === "tradeable",
        receivedAt,
      };

      if (payload.bids?.[0] && payload.asks?.[0]) {
        tick.liquidity = {
          bid: payload.bids[0].liquidity,
          ask: payload.asks[0].liquidity,
        };
      }

      this.latestQuotes.set(symbol, tick);
      this.emit("tick", tick);

      if (this.synthesize1mCandles) {
        this.update1mCandle(symbol, mid, tickTime);
      }
    }
  }

  private update1mCandle(symbol: string, price: number, time: Date): void {
    // Floor to nearest minute boundary (00 seconds)
    const minuteBucket = Math.floor(time.getTime() / 60000) * 60000;
    const current = this.inProgressCandles.get(symbol);

    if (!current) {
      this.inProgressCandles.set(symbol, {
        minuteBucket,
        open: price,
        high: price,
        low: price,
        close: price,
        tickCount: 1,
      });
      return;
    }

    if (minuteBucket > current.minuteBucket) {
      // Completed candle for prior minute!
      const completed: OandaSynthetic1mCandle = {
        symbol,
        openTime: new Date(current.minuteBucket),
        closeTime: new Date(current.minuteBucket + 60000),
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        tickCount: current.tickCount,
      };

      this.emit("candle_1m", completed);

      // Start new minute candle
      this.inProgressCandles.set(symbol, {
        minuteBucket,
        open: price,
        high: price,
        low: price,
        close: price,
        tickCount: 1,
      });
    } else {
      // Update ongoing candle
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
      current.tickCount++;
    }
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    this.abortController = new AbortController();
    const instruments = this.symbols.join(",");
    const url = `${this.baseUrl}/v3/accounts/${this.accountId}/pricing/stream?instruments=${instruments}`;

    try {
      const response = await this.fetchFn(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`OANDA stream HTTP error: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("OANDA stream response has no readable body.");
      }

      this.reconnectAttempts = 0;
      this.emit("connected");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (this.isRunning) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial token in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.processStreamLine(line);
        }
      }
    } catch (error: any) {
      if (!this.isRunning) return;
      this.emit("error", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(1.5, this.reconnectAttempts - 1),
      this.reconnectMaxMs
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
