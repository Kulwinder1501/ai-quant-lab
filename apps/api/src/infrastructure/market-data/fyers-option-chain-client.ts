import { resolveFyersSymbol } from "../../modules/market-data/domain/fyers-symbol-resolver.js";
import type {
  ExpiryKind,
  OptionChainQuote,
  OptionChainSnapshot,
  OptionType,
} from "../../modules/market-data/domain/option-chain.js";
import { FYERS_PROVIDER_ID, type FyersTokenService } from "./fyers-token-service.js";

type FetchFunction = typeof fetch;

interface FyersChainRow {
  strike_price?: number;
  option_type?: string;
  symbol?: string;
  fyToken?: string;
  ltp?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  oi?: number;
  prev_oi?: number;
  oich?: number;
}

interface FyersChainResponse {
  s?: string;
  code?: number;
  message?: string;
  data?: {
    optionsChain?: FyersChainRow[];
    expiryData?: Array<{ date?: string; expiry?: string; expiry_flag?: string }>;
  };
}

export interface FyersOptionChainClientOptions {
  tokenService: Pick<FyersTokenService, "getAccessToken">;
  appId: string;
  /** Injectable for deterministic tests. */
  fetch?: FetchFunction;
  baseUrl?: string;
  now?: () => Date;
}

/**
 * Reads the current option chain from Fyers API v3.
 *
 * A chain endpoint returns the book as it stands, so this is inherently
 * forward-accumulating: there is no historical option-chain source here, and Phase 25's
 * Workstream D3 forbids presenting today's page as though it were the past. History
 * deepens only from the moment collection starts.
 *
 * The response carries no provider or exchange timestamp, so the snapshot is stamped
 * with receipt time and says so. Borrowing a plausible timestamp would imply an
 * exchange-side precision the payload does not have.
 */
export class FyersOptionChainClient {
  readonly provider = FYERS_PROVIDER_ID;
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: FyersOptionChainClientOptions) {
    if (!options.appId.trim()) {
      throw new Error("Fyers option-chain collection requires an app ID.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api-t1.fyers.in";
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Fetches one chain.
   *
   * `strikeCount` is per side of the money, so the row count is roughly twice it plus
   * the ATM strike. Kept modest by default: the far wings are where quotes thin out to
   * nothing, and an unquotable strike contributes a row that cannot be costed.
   */
  async fetchChain(
    input: { underlyingSymbol: string; strikeCount?: number; expiryToken?: string | null },
  ): Promise<OptionChainSnapshot> {
    const providerSymbol = resolveFyersSymbol(input.underlyingSymbol);
    const strikeCount = input.strikeCount ?? 10;
    if (!Number.isInteger(strikeCount) || strikeCount < 1 || strikeCount > 50) {
      throw new Error("strikeCount must be an integer between 1 and 50.");
    }

    const accessToken = await this.options.tokenService.getAccessToken();
    const endpoint = new URL("/data/options-chain-v3", this.baseUrl);
    endpoint.searchParams.set("symbol", providerSymbol);
    endpoint.searchParams.set("strikecount", String(strikeCount));
    // Absent, the provider returns whichever expiry it considers current -- in practice the front
    // one. Naming the expiry is the only way to reach any other listed contract's book.
    if (input.expiryToken) endpoint.searchParams.set("timestamp", input.expiryToken);

    const response = await this.fetch(endpoint, {
      headers: { Authorization: `${this.options.appId}:${accessToken}` },
    });
    const payload = await response.json().catch(() => undefined) as FyersChainResponse | undefined;

    // Fyers reports failures in the body with HTTP 200, so status alone is not a verdict.
    if (!response.ok || payload?.s !== "ok" || !payload.data) {
      const detail = payload?.message ? ` ${payload.message}` : "";
      throw new Error(
        `Fyers option-chain request for ${providerSymbol} failed with HTTP ${response.status}, `
        + `code ${payload?.code ?? "none"}.${detail}`,
      );
    }

    const expiryKindByDate = new Map<string, ExpiryKind>();
    const expiryByEpoch = new Map<string, Date>();
    const epochByExpiryKey = new Map<string, string>();
    for (const entry of payload.data.expiryData ?? []) {
      const parsed = parseExpiryDate(entry.date);
      if (parsed === null) continue;
      const key = parsed.toISOString().slice(0, 10);
      // W and M are the provider's own flags. Recorded rather than inferred from the
      // weekday: NSE moved weeklies to a single index and to Tuesday, so any weekday
      // rule is already stale.
      expiryKindByDate.set(key, entry.expiry_flag === "W" ? "WEEKLY" : "MONTHLY");
      if (entry.expiry) {
        expiryByEpoch.set(entry.expiry, parsed);
        // Kept so a caller can ask for this expiry's book. Without it, only whichever expiry the
        // provider defaults to is reachable, and every other listed contract is unquotable.
        epochByExpiryKey.set(key, entry.expiry);
      }
    }

    const rows = payload.data.optionsChain ?? [];
    const quotes: OptionChainQuote[] = [];
    let underlyingValue: number | null = null;

    for (const row of rows) {
      // The chain includes a synthetic underlying row with strike 0 and no option type;
      // it carries spot, which is worth keeping and is not a contract.
      const optionType = row.option_type === "CE" || row.option_type === "PE"
        ? (row.option_type as OptionType)
        : null;
      if (optionType === null || !row.strike_price || row.strike_price <= 0) {
        if (typeof row.ltp === "number" && row.ltp > 0 && underlyingValue === null) {
          underlyingValue = row.ltp;
        }
        continue;
      }

      const expiryDate = expiryFromSymbol(row.symbol, expiryKindByDate);
      if (expiryDate === null) continue;
      const expiryKey = expiryDate.toISOString().slice(0, 10);

      quotes.push({
        expiryDate,
        expiryKind: expiryKindByDate.get(expiryKey) ?? "MONTHLY",
        strikePrice: row.strike_price,
        optionType,
        providerSymbol: row.symbol ?? `${providerSymbol}:${row.strike_price}${optionType}`,
        providerToken: row.fyToken ?? null,
        lastPrice: numberOrNull(row.ltp),
        // Zero is how Fyers reports "nobody is quoting", and a zero bid would claim
        // someone was willing to pay nothing. Absent is the honest reading.
        bid: positiveOrNull(row.bid),
        ask: positiveOrNull(row.ask),
        volume: nonNegativeIntegerOrNull(row.volume),
        openInterest: nonNegativeIntegerOrNull(row.oi),
        previousOpenInterest: nonNegativeIntegerOrNull(row.prev_oi),
        openInterestChange: integerOrNull(row.oich),
      });
    }

    return {
      underlyingSymbol: input.underlyingSymbol.toUpperCase(),
      provider: this.provider,
      observedAt: this.now(),
      underlyingValue,
      quotes,
      // The header's whole list, independent of which expiry the rows belong to.
      listedExpiries: [...expiryKindByDate.entries()]
        .map(([date, expiryKind]) => ({
          expiryDate: new Date(`${date}T10:00:00.000Z`),
          expiryKind,
          providerExpiryToken: epochByExpiryKey.get(date) ?? null,
        }))
        .sort((left, right) => left.expiryDate.getTime() - right.expiryDate.getTime()),
    };
  }
}

/** Fyers returns expiry dates as dd-MM-yyyy. */
function parseExpiryDate(value: string | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!match) return null;
  // 10:00 UTC is 15:30 IST, the session close on which an NSE contract expires.
  const parsed = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 10, 0, 0));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Which expiry a contract belongs to.
 *
 * Fyers does not put an expiry field on the chain rows, only on the header, so it has to
 * come from the contract symbol: `NSE:NIFTY2680424350PE` is yy-M-dd for a weekly and
 * `NSE:BANKNIFTY26AUG57400PE` is yy-MON for a monthly. When a chain covers exactly one
 * expiry — which is what a single request returns — the header's own date is
 * unambiguous and is used directly, which avoids depending on a symbol-format parse.
 */
function expiryFromSymbol(
  symbol: string | undefined,
  expiryKindByDate: Map<string, ExpiryKind>,
): Date | null {
  const dates = [...expiryKindByDate.keys()].sort();
  if (dates.length === 0) return null;
  if (dates.length === 1) return new Date(`${dates[0]}T10:00:00.000Z`);

  // More than one expiry in the header: prefer a symbol match so rows are not all
  // attributed to the nearest expiry.
  if (symbol) {
    for (const date of dates) {
      const [year, month, day] = date.split("-") as [string, string, string];
      const yy = year.slice(2);
      const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const weekly = `${yy}${Number(month)}${day}`;
      const monthly = `${yy}${monthNames[Number(month) - 1]}`;
      if (symbol.includes(weekly) || symbol.includes(monthly)) {
        return new Date(`${date}T10:00:00.000Z`);
      }
    }
  }
  // Unattributable. Dropped by the caller rather than guessed onto an expiry, because a
  // contract filed under the wrong expiry corrupts every metric computed per expiry.
  return null;
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeIntegerOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function integerOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
