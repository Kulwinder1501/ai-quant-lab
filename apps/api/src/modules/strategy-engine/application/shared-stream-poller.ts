export type StreamDataListener<T> = (value: T) => void;
export type StreamUnavailableListener = (consecutiveFailures: number) => void;

export interface SharedStreamPollerOptions<T> {
  /** Appears in log lines, so two registries are distinguishable in one process. */
  readonly name: string;
  readonly intervalMs: number;
  /**
   * Produces one snapshot for a key. Returning null means "nothing to publish yet" -- subscribers
   * are not notified and no snapshot is cached, which is how the caller says "not ready" without
   * pretending a failure occurred.
   */
  readonly produce: (key: string) => Promise<T | null>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
}

interface Subscriber<T> {
  readonly onData: StreamDataListener<T>;
  readonly onUnavailable: StreamUnavailableListener | undefined;
}

interface PollerState<T> {
  readonly subscribers: Set<Subscriber<T>>;
  timer: ReturnType<typeof setInterval> | null;
  pollInFlight: boolean;
  latest: T | null;
  consecutiveFailures: number;
  lastFailureLogAt: number;
}

const FAILURE_LOG_THROTTLE_MS = 30_000;

/**
 * One poll per distinct key per process, fanned out to every stream watching that key.
 *
 * ## Why
 *
 * SSE routes here owned their own `setInterval`, so every upstream read happened once per interval
 * **per connected browser tab**. `/stream/live-agent` was the worst case: a 1-second interval doing
 * three database queries and one provider quote, so a single open dashboard tab cost 60 provider
 * requests a minute and four tabs cost 240. On 2026-08-27 that traffic tripped the quote provider's
 * edge rate limiter, which returned an HTML 429 with `retry-after: 2374` and blanked every live panel
 * for forty minutes. Measured against a background of roughly 20 requests a minute from the
 * collectors, the browser was the dominant consumer by a wide margin.
 *
 * Keyed, because these streams are parameterised: `/stream/live-agent?symbol=X&timeframe=Y`. Two tabs
 * on the same symbol share a poll; two tabs on different symbols do not, which is correct -- they
 * genuinely need different data.
 *
 * ## Behaviours that are decisions, not accidents
 *
 * - **A new subscriber is replayed the cached snapshot synchronously**, so opening a second tab shows
 *   data at once rather than waiting a full interval for something already in memory.
 * - **A failed poll keeps the last good snapshot** and notifies `onUnavailable`. A transport that
 *   went silent on failure would be indistinguishable from a healthy connection that had not ticked
 *   yet -- the state that made the original outage take a hand-rolled provider request to diagnose.
 * - **A key is torn down when its last subscriber leaves**, including its cached snapshot. Unlike a
 *   single fixed-payload poller, the key space here is caller-supplied and unbounded, so retaining
 *   snapshots for departed symbol/timeframe pairs would leak for the process's lifetime. The cost is
 *   that the first tab back on a cold key waits one produce; that is the right trade.
 * - **Failure logs are throttled per key.** At a 2.5s interval an outage measured in minutes would
 *   otherwise write thousands of identical lines.
 */
export class SharedStreamPollerRegistry<T> {
  private readonly states = new Map<string, PollerState<T>>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly logError: (line: string) => void;

  constructor(private readonly options: SharedStreamPollerOptions<T>) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line: string) => console.info(line));
    this.logError = options.logError ?? ((line: string) => console.error(line));
  }

  get stats(): { keys: number; subscribers: number } {
    let subscribers = 0;
    for (const state of this.states.values()) subscribers += state.subscribers.size;
    return { keys: this.states.size, subscribers };
  }

  /** Subscribers watching one key. Exposed for tests and diagnostics. */
  subscriberCount(key: string): number {
    return this.states.get(key)?.subscribers.size ?? 0;
  }

  subscribe(
    key: string,
    onData: StreamDataListener<T>,
    onUnavailable?: StreamUnavailableListener,
  ): () => void {
    let state = this.states.get(key);
    if (state === undefined) {
      state = {
        subscribers: new Set<Subscriber<T>>(),
        timer: null,
        pollInFlight: false,
        latest: null,
        consecutiveFailures: 0,
        lastFailureLogAt: 0,
      };
      this.states.set(key, state);
    }

    const subscriber: Subscriber<T> = { onData, onUnavailable };
    state.subscribers.add(subscriber);
    if (state.latest !== null) onData(state.latest);

    if (state.timer === null) {
      state.timer = setInterval(() => void this.pollOnce(key), this.options.intervalMs);
      // Never let a poll loop hold the process open at shutdown.
      state.timer.unref?.();
      void this.pollOnce(key);
    }

    let released = false;
    return () => {
      // Idempotent: a stream can both close and error, and double-removal would decrement past the
      // real subscriber count and tear down a key others still need.
      if (released) return;
      released = true;
      const current = this.states.get(key);
      if (current === undefined) return;
      current.subscribers.delete(subscriber);
      if (current.subscribers.size === 0) {
        if (current.timer !== null) clearInterval(current.timer);
        current.timer = null;
        this.states.delete(key);
      }
    };
  }

  /** Stops every key. For shutdown and for tests. */
  stopAll(): void {
    for (const state of this.states.values()) {
      if (state.timer !== null) clearInterval(state.timer);
      state.timer = null;
    }
    this.states.clear();
  }

  async pollOnce(key: string): Promise<void> {
    const state = this.states.get(key);
    if (state === undefined) return;
    // Without this a slow upstream round-trip lets ticks stack up on one key.
    if (state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      const value = await this.options.produce(key);
      if (value === null) return;

      if (state.consecutiveFailures > 0) {
        this.log(JSON.stringify({
          level: "info",
          message: `${this.options.name} stream recovered`,
          source: this.options.name,
          key,
          afterConsecutiveFailures: state.consecutiveFailures,
        }));
        state.consecutiveFailures = 0;
      }

      state.latest = value;
      for (const subscriber of state.subscribers) subscriber.onData(value);
    } catch (error) {
      /*
       * Logged, not swallowed. The routes this replaces had empty `catch` blocks, so a provider
       * outage produced an open socket delivering nothing and no server-side trace at all.
       */
      state.consecutiveFailures += 1;
      const now = this.now();
      if (state.consecutiveFailures === 1 || now - state.lastFailureLogAt >= FAILURE_LOG_THROTTLE_MS) {
        state.lastFailureLogAt = now;
        this.logError(JSON.stringify({
          level: "error",
          message: `${this.options.name} stream could not produce a snapshot`,
          source: this.options.name,
          key,
          consecutiveFailures: state.consecutiveFailures,
          subscribers: state.subscribers.size,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      // `latest` is deliberately retained -- see the class comment.
      for (const subscriber of state.subscribers) {
        subscriber.onUnavailable?.(state.consecutiveFailures);
      }
    } finally {
      state.pollInFlight = false;
    }
  }
}
