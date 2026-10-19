/**
 * Counts how many holders want each symbol on a shared socket, so a symbol is released only when the last one lets go.
 *
 * The API's Fyers socket holds a limited number of symbols and `subscribe` never gave any back. Each open option chain
 * page added its whole contract set for good, so the second chain opened in a session got only the slots that were
 * left. With a count, two pages that both show the same contracts keep them subscribed until both close.
 */
export class SubscriptionRefCounter {
  private readonly counts = new Map<string, number>();

  /** Registers a holder for each symbol. Returns the symbols nobody held before. */
  acquire(symbols: Iterable<string>): string[] {
    const fresh: string[] = [];
    for (const symbol of new Set(symbols)) {
      const held = this.counts.get(symbol) ?? 0;
      if (held === 0) fresh.push(symbol);
      this.counts.set(symbol, held + 1);
    }
    return fresh;
  }

  /** Drops a holder for each symbol. Returns the symbols nobody holds any more. */
  release(symbols: Iterable<string>): string[] {
    const freed: string[] = [];
    for (const symbol of new Set(symbols)) {
      const held = this.counts.get(symbol);
      if (held === undefined) continue;
      if (held <= 1) {
        this.counts.delete(symbol);
        freed.push(symbol);
      } else {
        this.counts.set(symbol, held - 1);
      }
    }
    return freed;
  }

  heldCount(): number {
    return this.counts.size;
  }
}
