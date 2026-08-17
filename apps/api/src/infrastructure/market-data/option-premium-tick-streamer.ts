import { FYERS_PROVIDER_ID } from "./fyers-token-service.js";
import type { FyersLiveStreamer, Tick } from "./fyers-live-streamer.js";
import type { AtmPremiumContract } from "../../modules/market-data/domain/atm-premium-contracts.js";
import { selectAtmPremiumContracts } from "../../modules/market-data/domain/atm-premium-contracts.js";
import { resolveFyersSymbol } from "../../modules/market-data/domain/fyers-symbol-resolver.js";
import {
  resolveSubscriptionDelta,
  selectFlushableTicks,
  type BufferedTick,
} from "../../modules/market-data/application/stream-option-premium-ticks.js";
import type {
  OptionPremiumTickRow,
  PostgresOptionPremiumTickRepository,
} from "../database/repositories/postgres-option-premium-tick-repository.js";
import type { PostgresOptionChainRepository } from "../database/repositories/postgres-option-chain-repository.js";

/** Contracts an open position needs quoted regardless of where the ATM band has moved. */
export interface RequiredContractReader {
  listForUnderlying(underlyingSymbol: string): Promise<AtmPremiumContract[]>;
}

export interface OptionPremiumTickStreamerOptions {
  underlyingSymbols: readonly string[];
  streamer: FyersLiveStreamer;
  chainRepository: PostgresOptionChainRepository;
  tickRepository: PostgresOptionPremiumTickRepository;
  requiredContracts?: RequiredContractReader;
  /** How often buffered quotes become rows. The persistence resolution, not the feed's. */
  flushIntervalMs?: number;
  /** How often the ATM band is recomputed from the newest chain snapshot. */
  resubscribeIntervalMs?: number;
  /** A quote older than this is dropped rather than written. */
  maximumTickAgeMs?: number;
  strikeBand?: number;
  now?: () => Date;
  /**
   * Called after a flush that wrote rows, with what it wrote.
   *
   * This is how exit evaluation rides the tick loop instead of a cron: the barrier a position
   * cares about becomes visible the moment the quote that crossed it is persisted, so the
   * handler runs against a table that already contains it. Nothing about this class depends on
   * what the handler does -- it is deliberately a callback rather than a paper-trading
   * dependency, so market-data collection does not import a trading module to stay honest about
   * which way the dependency points.
   *
   * A handler that throws or hangs must not take the writer with it: the caller owns its own
   * errors and its own concurrency, and this awaits it only so a slow handler cannot overlap
   * itself through the flush timer.
   */
  onTicksWritten?: (result: { inserted: number; skipped: number }) => Promise<void> | void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
// The chain job runs every 15 minutes, so recomputing faster than that mostly re-reads the same
// snapshot. Five minutes still moves the band within one chain interval when spot runs.
const DEFAULT_RESUBSCRIBE_INTERVAL_MS = 5 * 60_000;
// Three flushes. Long enough that one dropped message is not a gap, short enough that a dead
// socket stops writing well inside the five-minute bot cycle that reads this series.
const DEFAULT_MAXIMUM_TICK_AGE_MS = 15_000;

/**
 * Fills `option_premium_ticks` from the Fyers data socket instead of the HTTP quotes endpoint.
 *
 * This exists because the dense poller is rate-limited, not because polling is inelegant.
 * Measured over the seven days to 2026-08-16: `OPTION_PREMIUM_TICKS` failed 97 of 1,038 runs on
 * `HTTP 429 request limit reached`, and on 2026-08-12 those failures also drove 16 of 24
 * `FYERS_AUTH_HEALTH_CHECK` runs to declare the credential unusable while the token was valid.
 * One rate limit, two broken signals.
 *
 * It deliberately writes to the same table rather than serving a cache. The paper-trading bot is
 * a separate process spawned every five minutes and cannot read this process's memory; the table
 * is the only handoff it already understands, so nothing downstream changes. What changes is
 * resolution: the poller sampled roughly every 33 seconds, which cost about 0.20R of overshoot
 * past the stop on the positions closed 2026-08-14, because the premium moves between samples.
 *
 * The HTTP poller is intended to remain scheduled at a slower cadence. A socket fails by going
 * quiet, and a feed that silently stops is worse than one that 429s loudly, so the poller stays
 * as the floor under this.
 */
export class OptionPremiumTickStreamer {
  private readonly buffered = new Map<string, BufferedTick>();
  private readonly lastFlushedAt = new Map<string, number>();
  private readonly underlyingValues = new Map<string, number>();
  private readonly subscribed = new Set<string>();
  private readonly underlyingByProviderSymbol = new Map<string, string>();
  private contracts: AtmPremiumContract[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private resubscribeTimer: NodeJS.Timeout | null = null;
  private readonly onTick = (tick: Tick): void => this.record(tick);

  constructor(private readonly options: OptionPremiumTickStreamerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async start(): Promise<void> {
    this.options.streamer.on("tick", this.onTick);
    await this.refreshSubscriptions();
    this.flushTimer = setInterval(() => {
      // Skipped rather than queued when the previous cycle is still running. A write plus its
      // handler that outlives the interval would otherwise stack timers on top of each other,
      // and the next tick's data supersedes this one anyway.
      if (this.flushing) return;
      this.flushing = true;
      void this.flush().finally(() => { this.flushing = false; });
    }, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.resubscribeTimer = setInterval(() => {
      void this.refreshSubscriptions();
    }, this.options.resubscribeIntervalMs ?? DEFAULT_RESUBSCRIBE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.options.streamer.off("tick", this.onTick);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.resubscribeTimer) clearInterval(this.resubscribeTimer);
    this.flushTimer = null;
    this.resubscribeTimer = null;
    // One last write so quotes already in hand are not discarded on shutdown.
    await this.flush();
  }

  private record(tick: Tick): void {
    const key = tick.symbol.toUpperCase();
    const underlying = this.underlyingByProviderSymbol.get(key);
    if (underlying !== undefined) {
      this.underlyingValues.set(underlying, tick.ltp);
      return;
    }
    this.buffered.set(key, {
      bid: tick.bid,
      ask: tick.ask,
      lastPrice: tick.ltp,
      volume: tick.volume,
      observedAt: this.now(),
    });
  }

  /** Recompute the wanted contract set and move the socket's subscriptions to match. */
  async refreshSubscriptions(): Promise<void> {
    const contracts: AtmPremiumContract[] = [];
    for (const symbol of this.options.underlyingSymbols) {
      const snapshot = await this.options.chainRepository.latestSnapshot({ underlyingSymbol: symbol });
      if (snapshot) {
        contracts.push(...selectAtmPremiumContracts(snapshot, {
          strikeBand: this.options.strikeBand ?? 1,
          now: this.now(),
        }));
      }
      // Open positions are quoted whether or not the band still covers them. A position whose
      // strike drifted out of the band is exactly the one whose stop still has to resolve.
      const required = await this.options.requiredContracts?.listForUnderlying(symbol) ?? [];
      contracts.push(...required);
    }

    this.contracts = [...new Map(
      contracts.map((contract) => [contract.providerSymbol.toUpperCase(), contract]),
    ).values()];

    const underlyingSymbols = this.options.underlyingSymbols.map((symbol) => {
      const providerSymbol = resolveFyersSymbol(symbol);
      this.underlyingByProviderSymbol.set(providerSymbol.toUpperCase(), symbol);
      return providerSymbol;
    });

    const wanted = [...this.contracts.map((c) => c.providerSymbol), ...underlyingSymbols];
    const { subscribe, unsubscribe } = resolveSubscriptionDelta(this.subscribed, wanted);
    if (subscribe.length > 0) {
      this.options.streamer.subscribe(subscribe);
      for (const symbol of subscribe) this.subscribed.add(symbol);
    }
    if (unsubscribe.length > 0) {
      this.options.streamer.unsubscribe(unsubscribe);
      for (const symbol of unsubscribe) {
        this.subscribed.delete(symbol);
        // Dropped with the subscription so a later resubscribe cannot flush a quote from
        // before the gap as though it were current.
        this.buffered.delete(symbol);
        this.lastFlushedAt.delete(symbol);
      }
    }
  }

  /** Write every buffered quote that is fresh and new. Returns what was persisted. */
  async flush(): Promise<{ inserted: number; skipped: number }> {
    const rows: OptionPremiumTickRow[] = selectFlushableTicks({
      contracts: this.contracts,
      buffered: this.buffered,
      lastFlushedAt: this.lastFlushedAt,
      underlyingValues: this.underlyingValues,
      provider: FYERS_PROVIDER_ID,
      now: this.now(),
      maximumTickAgeMs: this.options.maximumTickAgeMs ?? DEFAULT_MAXIMUM_TICK_AGE_MS,
    });
    if (rows.length === 0) return { inserted: 0, skipped: 0 };

    const result = await this.options.tickRepository.insertTicks(rows);
    for (const row of rows) {
      this.lastFlushedAt.set(row.providerSymbol.toUpperCase(), row.observedAt.getTime());
    }

    // After the write, never before: a handler that reads the tick table must find the quotes
    // this cycle produced. Only when something landed -- a flush that inserted nothing has
    // told the handler nothing it did not already know.
    if (result.inserted > 0 && this.options.onTicksWritten) {
      try {
        await this.options.onTicksWritten(result);
      } catch (error) {
        // The writer's job is the series. A handler failure is reported and the series continues,
        // because dropping quotes would turn someone else's bug into a gap in the record.
        console.error(JSON.stringify({
          level: "error",
          message: "An option premium tick handler failed; the tick series is unaffected",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return result;
  }
}
