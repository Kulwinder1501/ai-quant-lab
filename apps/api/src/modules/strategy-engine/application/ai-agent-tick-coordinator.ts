export interface AiAgentTicker {
  tick(symbol: string, timeframe: string, livePrice: number): Promise<void>;
}

/**
 * Coordinates browser-driven agent evaluations within one API process.
 *
 * The live dashboard may be open in several tabs, with each SSE connection
 * polling once per second. Agent ticks can evaluate and mutate paper trades, so
 * those connections must share one in-flight operation and one cadence per
 * symbol/timeframe instead of independently triggering the agent.
 */
export class AiAgentTickCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly lastStartedAt = new Map<string, number>();

  constructor(
    private readonly minimumIntervalMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  public async run(
    agent: AiAgentTicker,
    symbol: string,
    timeframe: string,
    livePrice: number,
  ): Promise<boolean> {
    const key = `${symbol.trim().toUpperCase()}:${timeframe.trim().toLowerCase()}`;
    const current = this.inFlight.get(key);
    if (current) {
      await current;
      return false;
    }

    const startedAt = this.now();
    const lastStartedAt = this.lastStartedAt.get(key);
    if (lastStartedAt !== undefined && startedAt - lastStartedAt < this.minimumIntervalMs) {
      return false;
    }

    this.lastStartedAt.set(key, startedAt);
    const operation = Promise.resolve().then(() => agent.tick(symbol, timeframe, livePrice));
    this.inFlight.set(key, operation);

    try {
      await operation;
      return true;
    } finally {
      if (this.inFlight.get(key) === operation) {
        this.inFlight.delete(key);
      }
    }
  }
}
