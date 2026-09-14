import type { PostgresOptionChainRepository } from "../../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import type { PostgresOptionPremiumTickRepository } from "../../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { FYERS_PROVIDER_ID } from "../../../infrastructure/market-data/fyers-token-service.js";
import { resolveFyersSymbol } from "../domain/fyers-symbol-resolver.js";
import { selectAtmPremiumContracts } from "../domain/atm-premium-contracts.js";
import type { AtmPremiumContract } from "../domain/atm-premium-contracts.js";
import { normaliseTradedVolume } from "../domain/traded-volume.js";
import { POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY } from "../domain/collector-regimes.js";

export interface CollectOptionPremiumTicksInput {
  underlyingSymbols: readonly string[];
  /** ATM ± this many strike steps. Default 1 → 6 contracts per underlying. */
  strikeBand?: number;
}

export interface CollectOptionPremiumTicksResult {
  underlyings: Array<{
    symbol: string;
    contractsSelected: number;
    ticksInserted: number;
    ticksSkipped: number;
    refusal: string | null;
  }>;
  inserted: number;
}

type FetchFunction = typeof fetch;

export interface AdditionalPremiumContractReader {
  listForUnderlying(underlyingSymbol: string): Promise<AtmPremiumContract[]>;
}

/**
 * Polls Fyers quotes for ATM-band contracts chosen from the latest chain snapshot.
 *
 * Keeps the 15m full-chain job unchanged; this is the dense mark series Phase 27 needs.
 */
export class CollectOptionPremiumTicks {
  constructor(
    private readonly chainRepository: PostgresOptionChainRepository,
    private readonly tickRepository: PostgresOptionPremiumTickRepository,
    private readonly options: {
      appId: string;
      tokenService: { getAccessToken(): Promise<string> };
      fetch?: FetchFunction;
      baseUrl?: string;
    },
    private readonly additionalContracts?: AdditionalPremiumContractReader,
  ) {}

  async execute(input: CollectOptionPremiumTicksInput): Promise<CollectOptionPremiumTicksResult> {
    const underlyings: CollectOptionPremiumTicksResult["underlyings"] = [];
    let inserted = 0;

    for (const symbol of input.underlyingSymbols) {
      const snapshot = await this.chainRepository.latestSnapshot({ underlyingSymbol: symbol });
      if (!snapshot) {
        underlyings.push({
          symbol,
          contractsSelected: 0,
          ticksInserted: 0,
          ticksSkipped: 0,
          refusal: "NO_CHAIN_SNAPSHOT",
        });
        continue;
      }

      const atmContracts = selectAtmPremiumContracts(snapshot, {
        strikeBand: input.strikeBand ?? 1,
      });
      const requiredContracts = await this.additionalContracts?.listForUnderlying(symbol) ?? [];
      const contracts = [...new Map(
        [...atmContracts, ...requiredContracts]
          .map((contract) => [contract.providerSymbol.toUpperCase(), contract]),
      ).values()];
      if (contracts.length === 0) {
        underlyings.push({
          symbol,
          contractsSelected: 0,
          ticksInserted: 0,
          ticksSkipped: 0,
          refusal: "NO_FRESH_ATM_CONTRACTS",
        });
        continue;
      }

      const underlyingProviderSymbol = resolveFyersSymbol(symbol);
      const richQuotes = await this.fetchRichQuotes([
        ...contracts.map((c) => c.providerSymbol),
        underlyingProviderSymbol,
      ]);
      const liveUnderlying = richQuotes.get(underlyingProviderSymbol.toUpperCase())?.lastPrice ?? null;
      const observedAt = new Date();
      const ticks = contracts.flatMap((contract) => {
        const quote = richQuotes.get(contract.providerSymbol.toUpperCase());
        if (!quote) return [];
        const tradedVolume = normaliseTradedVolume(quote.volume);
        return [{
          underlyingSymbol: contract.underlyingSymbol,
          provider: FYERS_PROVIDER_ID,
          observedAt,
          expiryDate: contract.expiryDate,
          strikePrice: contract.strikePrice,
          optionType: contract.optionType,
          providerSymbol: contract.providerSymbol,
          lastPrice: quote.lastPrice,
          bid: quote.bid,
          ask: quote.ask,
          // The polling path carries the same exposure as the socket: the provider's traded-volume
          // counter can arrive wrapped, and an impossible value must not reach a CHECK constraint.
          volume: tradedVolume.volume,
          volumeRaw: tradedVolume.rejectedRaw,
          // Same HTTP observation as the option bid/ask. Reusing the 15-minute chain spot here
          // made the dense series look fresh while trap detection was anchored to a stale index.
          underlyingValue: liveUnderlying !== null && liveUnderlying > 0 ? liveUnderlying : null,
          /*
           * Declare the regime. This path wrote NULL from migration 078 until now -- roughly 6-7% of
           * every session's ticks, unattributable to any capture code. Migration 078 gave the column
           * no DEFAULT precisely so that omission would surface rather than be silently labelled, and
           * it did: `COLLECTOR_HEALTH` reported DEGRADED the first session it was able to run.
           *
           * `POLLER_V2_FLOOR_...` and not `LEGACY_POLLER_V1`: that name belongs to the pre-streamer
           * sessions this is not a continuation of. This is the deliberate once-a-minute floor under
           * the socket, and its rows carry a receipt clock only, since the HTTP quotes endpoint
           * publishes no exchange time.
           */
          collectorRegime: POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY,
        }];
      });

      const write = await this.tickRepository.insertTicks(ticks);
      inserted += write.inserted;
      underlyings.push({
        symbol,
        contractsSelected: contracts.length,
        ticksInserted: write.inserted,
        ticksSkipped: write.skipped,
        refusal: ticks.length === 0 ? "NO_QUOTES" : null,
      });
    }

    return { underlyings, inserted };
  }

  /**
   * Quotes endpoint with bid/ask when the provider supplies them.
   * Falls back to last price only — never fabricates a spread.
   */
  private async fetchRichQuotes(
    providerSymbols: readonly string[],
  ): Promise<Map<string, { lastPrice: number | null; bid: number | null; ask: number | null; volume: number | null }>> {
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const baseUrl = this.options.baseUrl ?? "https://api-t1.fyers.in";
    const accessToken = await this.options.tokenService.getAccessToken();
    const endpoint = new URL("/data/quotes", baseUrl);
    endpoint.searchParams.set("symbols", [...new Set(providerSymbols)].join(","));

    const response = await fetchFn(endpoint, {
      headers: { Authorization: `${this.options.appId}:${accessToken}` },
    });
    const payload = await response.json().catch(() => undefined) as {
      s?: string;
      code?: number;
      message?: string;
      d?: Array<{
        n?: string;
        s?: string;
        v?: {
          lp?: number;
          bid?: number;
          ask?: number;
          volume?: number | null;
        };
      }>;
    } | undefined;

    const out = new Map<string, {
      lastPrice: number | null;
      bid: number | null;
      ask: number | null;
      volume: number | null;
    }>();
    if (!response.ok || payload?.s !== "ok" || !Array.isArray(payload.d)) {
      throw new Error(
        `Fyers premium quote request failed (HTTP ${response.status}, code ${payload?.code ?? "none"}). `
        + `${payload?.message ?? "No quote rows returned."}`,
      );
    }

    for (const row of payload.d) {
      if (row.s !== "ok" || !row.n || !row.v) continue;
      const finite = (value: number | null | undefined): number | null =>
        value !== null && value !== undefined && Number.isFinite(value) ? value : null;
      out.set(row.n.toUpperCase(), {
        lastPrice: finite(row.v.lp),
        bid: finite(row.v.bid),
        ask: finite(row.v.ask),
        volume: finite(row.v.volume ?? null),
      });
    }
    return out;
  }
}
