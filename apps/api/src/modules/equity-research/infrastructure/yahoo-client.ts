import { createHash } from "node:crypto";
import { isValidSymbol } from "../domain/symbol-validator.js";
import type { EquityOutcome } from "../domain/types.js";
import type { PostgresEquitySourceHealthRepository } from "./repositories/postgres-equity-source-health-repository.js";

export interface YahooClientOptions {
  source?: string;
  baseUrl?: string;
  maxDailyBudget?: number;
  minIntervalMs?: number;
  cooldownPeriodMs?: number;
  sourceHealthRepo?: PostgresEquitySourceHealthRepository;
  fetchFn?: typeof fetch;
  nowFn?: () => Date;
  onBudgetExceeded?: (count: number, budget: number) => void;
  onCallLogged?: (info: { endpoint: string; status: number; durationMs: number }) => void;
}

export interface EndpointBreakerState {
  failureCount: number;
  cooldownUntil: number | null;
  lastError: string | null;
}

export interface YahooCallResult<T = unknown> {
  httpStatus: number;
  body: T;
  rawText: string;
  bodySha256: string;
  outcome: EquityOutcome;
  requestedAt: Date;
  durationMs: number;
  warnings: string[];
}

export class YahooClient {
  private readonly source: string;
  private readonly baseUrl: string;
  private readonly maxDailyBudget: number;
  private readonly minIntervalMs: number;
  private readonly cooldownPeriodMs: number;
  private readonly sourceHealthRepo?: PostgresEquitySourceHealthRepository;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn: () => Date;
  private readonly onBudgetExceeded?: (count: number, budget: number) => void;
  private readonly onCallLogged?: (info: { endpoint: string; status: number; durationMs: number }) => void;

  // Per-host gate: rate limiter tracking last request start timestamp
  private lastRequestTime = 0;

  // Circuit breaker: per-endpoint state (chart vs fundamentals)
  private readonly endpointBreakers = new Map<string, EndpointBreakerState>();

  // In-memory daily call counter
  private currentDateKey = "";
  private callsToday = 0;

  constructor(options: YahooClientOptions = {}) {
    this.source = options.source ?? "YAHOO";
    this.baseUrl = options.baseUrl ?? "https://query1.finance.yahoo.com";
    this.maxDailyBudget = options.maxDailyBudget ?? 300;
    this.minIntervalMs = options.minIntervalMs ?? 1000; // 1 req/second per-host gate
    this.cooldownPeriodMs = options.cooldownPeriodMs ?? 5 * 60 * 1000; // 5 min cooldown on 429
    this.sourceHealthRepo = options.sourceHealthRepo;
    this.fetchFn = options.fetchFn ?? fetch;
    this.nowFn = options.nowFn ?? (() => new Date());
    this.onBudgetExceeded = options.onBudgetExceeded;
    this.onCallLogged = options.onCallLogged;
  }

  get sourceName(): string {
    return this.source;
  }


  private getDateKey(now: Date): string {
    return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }

  private async checkAndIncrementBudget(now: Date): Promise<void> {
    const key = this.getDateKey(now);
    if (this.currentDateKey !== key) {
      this.currentDateKey = key;
      this.callsToday = 0;
    }

    if (this.sourceHealthRepo) {
      try {
        const dbCalls = await this.sourceHealthRepo.getTotalCallsToday(this.source, key);
        this.callsToday = Math.max(this.callsToday, dbCalls);
      } catch {
        // Fall back to in-memory counter if DB read fails
      }
    }

    if (this.callsToday >= this.maxDailyBudget) {
      this.onBudgetExceeded?.(this.callsToday, this.maxDailyBudget);
      throw new Error(
        `Yahoo daily request budget exceeded: ${this.callsToday}/${this.maxDailyBudget} calls used today (${key}).`,
      );
    }
  }

  private getBreaker(endpoint: string): EndpointBreakerState {
    let state = this.endpointBreakers.get(endpoint);
    if (!state) {
      state = { failureCount: 0, cooldownUntil: null, lastError: null };
      this.endpointBreakers.set(endpoint, state);
    }
    return state;
  }

  private async checkBreaker(endpoint: string, now: Date): Promise<void> {
    const breaker = this.getBreaker(endpoint);
    if (breaker.cooldownUntil !== null) {
      if (now.getTime() < breaker.cooldownUntil) {
        const remainingSec = Math.ceil((breaker.cooldownUntil - now.getTime()) / 1000);
        throw new Error(
          `Endpoint '${endpoint}' is cooling down after rate-limit or errors. Remaining: ${remainingSec}s. Reason: ${breaker.lastError ?? "rate limit"}`,
        );
      }
      // Cooldown expired, half-open
      breaker.cooldownUntil = null;
    }

    // Persistent cooldown check across process restarts
    if (this.sourceHealthRepo) {
      try {
        const health = await this.sourceHealthRepo.getHealth(this.source, endpoint);
        if (health && (health.status === "RATE_LIMITED" || health.status === "UNAVAILABLE") && health.last_failure_at) {
          const dbCooldownUntil = health.last_failure_at.getTime() + this.cooldownPeriodMs;
          if (now.getTime() < dbCooldownUntil) {
            const remainingSec = Math.ceil((dbCooldownUntil - now.getTime()) / 1000);
            throw new Error(
              `Endpoint '${endpoint}' is cooling down in database after rate-limit. Remaining: ${remainingSec}s. Status: ${health.status}`,
            );
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("cooling down")) {
          throw err;
        }
      }
    }
  }

  private async enforceRateGate(now: Date): Promise<void> {
    const elapsed = now.getTime() - this.lastRequestTime;
    if (elapsed < this.minIntervalMs && this.lastRequestTime > 0) {
      const waitTime = this.minIntervalMs - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    this.lastRequestTime = this.nowFn().getTime();
  }

  /**
   * Internal HTTP caller with per-host gate, budget check, breaker and call log.
   * Hard rules:
   * 1. No retry on 429.
   * 2. Per-endpoint circuit breaker and cooldown (never global).
   * 3. Symbol is validated prior to URL construction.
   */
  private async executeRequest<T>(
    endpoint: string,
    url: string,
    symbol: string,
  ): Promise<YahooCallResult<T>> {
    // Validate symbol before any request
    if (!isValidSymbol(symbol)) {
      throw new Error(`Symbol '${symbol}' failed validation. Request aborted before network call.`);
    }

    const now = this.nowFn();
    const dateKey = this.getDateKey(now);

    // 1. Budget check
    await this.checkAndIncrementBudget(now);

    // 2. Circuit breaker check
    await this.checkBreaker(endpoint, now);

    // 3. Per-host rate gate
    await this.enforceRateGate(now);

    const startTime = this.nowFn().getTime();
    let response: Response;
    let rawText = "";
    let httpStatus = 0;
    let errorMessage: string | null = null;
    const warnings: string[] = [];

    try {
      this.callsToday++;
      response = await this.fetchFn(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });

      httpStatus = response.status;
      rawText = await response.text();
    } catch (err: unknown) {
      const durationMs = this.nowFn().getTime() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      const breaker = this.getBreaker(endpoint);
      breaker.failureCount++;
      if (breaker.failureCount >= 3) {
        breaker.cooldownUntil = this.nowFn().getTime() + this.cooldownPeriodMs;
        breaker.lastError = `Consecutive network failures: ${message}`;
      }

      await this.logCall(endpoint, 0, durationMs, message, false, dateKey);
      throw err;
    }

    const durationMs = this.nowFn().getTime() - startTime;
    this.onCallLogged?.({ endpoint, status: httpStatus, durationMs });

    // Handle 429 specifically: NO RETRY; trigger per-endpoint cooldown
    if (httpStatus === 429 || httpStatus === 430) {
      const breaker = this.getBreaker(endpoint);
      breaker.cooldownUntil = this.nowFn().getTime() + this.cooldownPeriodMs;
      breaker.lastError = `HTTP ${httpStatus} Rate limited`;

      errorMessage = `HTTP ${httpStatus} Rate limit exceeded on endpoint '${endpoint}'. Cooldown activated for ${this.cooldownPeriodMs / 1000}s.`;
      await this.logCall(endpoint, httpStatus, durationMs, errorMessage, false, dateKey, true);

      const bodySha256 = createHash("sha256").update(rawText).digest("hex");
      return {
        httpStatus,
        body: {} as T,
        rawText,
        bodySha256,
        outcome: "RATE_LIMITED",
        requestedAt: now,
        durationMs,
        warnings: [errorMessage],
      };
    }

    // Handle 404 / Symbol Not Found specifically (Defect 2):
    // A mistyped or unknown symbol is user input, NOT an upstream provider failure.
    // It must NOT increment consecutive failures, trip circuit breaker, or start cooldown.
    if (httpStatus === 404) {
      const warning = `Symbol '${symbol}' not found on endpoint '${endpoint}'.`;
      if (this.sourceHealthRepo) {
        try {
          await this.sourceHealthRepo.recordCallLog({
            source: this.source,
            endpoint,
            status: 404,
            durationMs,
            errorMessage: warning,
          });
        } catch (logErr) {
          console.warn("Failed to write to source call log:", logErr);
        }
      }

      let parsedBody: T;
      try {
        parsedBody = JSON.parse(rawText) as T;
      } catch {
        parsedBody = {} as T;
      }

      const bodySha256 = createHash("sha256").update(rawText).digest("hex");
      return {
        httpStatus: 404,
        body: parsedBody,
        rawText,
        bodySha256,
        outcome: "EMPTY",
        requestedAt: now,
        durationMs,
        warnings: [warning],
      };
    }

    if (!response.ok) {
      const breaker = this.getBreaker(endpoint);
      breaker.failureCount++;
      if (breaker.failureCount >= 3) {
        breaker.cooldownUntil = this.nowFn().getTime() + this.cooldownPeriodMs;
        breaker.lastError = `HTTP ${httpStatus} consecutive failures`;
      }
      errorMessage = `HTTP ${httpStatus}: ${rawText.slice(0, 100)}`;
      await this.logCall(endpoint, httpStatus, durationMs, errorMessage, false, dateKey, false);

      const bodySha256 = createHash("sha256").update(rawText).digest("hex");
      return {
        httpStatus,
        body: {} as T,
        rawText,
        bodySha256,
        outcome: "ERROR",
        requestedAt: now,
        durationMs,
        warnings: [errorMessage],
      };
    }

    // Success: reset failure count
    const breaker = this.getBreaker(endpoint);
    breaker.failureCount = 0;
    breaker.cooldownUntil = null;
    breaker.lastError = null;

    let parsedBody: T;
    try {
      parsedBody = JSON.parse(rawText) as T;
    } catch {
      errorMessage = "Invalid JSON in response";
      parsedBody = {} as T;
      warnings.push(errorMessage);
    }

    const bodySha256 = createHash("sha256").update(rawText).digest("hex");
    const outcome: EquityOutcome = errorMessage ? "ERROR" : "OK";

    await this.logCall(endpoint, httpStatus, durationMs, errorMessage, outcome === "OK", dateKey, false);

    return {
      httpStatus,
      body: parsedBody,
      rawText,
      bodySha256,
      outcome,
      requestedAt: now,
      durationMs,
      warnings,
    };
  }

  private async logCall(
    endpoint: string,
    status: number,
    durationMs: number,
    errorMessage: string | null,
    success: boolean,
    dateKey: string,
    isRateLimited: boolean = false,
  ): Promise<void> {
    if (!this.sourceHealthRepo) return;
    try {
      await this.sourceHealthRepo.recordCallLog({
        source: this.source,
        endpoint,
        status,
        durationMs,
        errorMessage,
      });

      await this.sourceHealthRepo.updateHealth({
        source: this.source,
        endpoint,
        success,
        dateKey,
        budgetToday: this.maxDailyBudget,
        errorMessage,
        isRateLimited,
      });
    } catch (logErr) {
      console.warn("Failed to write to source call log / health repo:", logErr);
    }
  }

  /**
   * Fetches daily chart bars, quote meta, and dividends/splits for a stock.
   * Hard rule: raw close only; adjclose is NEVER requested or used.
   *
   * To prevent Yahoo from silently falling back to 1mo bars on history requests,
   * range='max' uses explicit period1=0 and period2=now timestamps with interval=1d.
   */
  async fetchChart(
    symbol: string,
    exchange: "NSE" | "BSE",
    rangeOrDates: "1mo" | "max" | { period1?: number; period2?: number } = "1mo",
  ): Promise<YahooCallResult<any>> {
    const suffix = exchange === "NSE" ? ".NS" : ".BO";
    const yahooSymbol = `${symbol}${suffix}`;
    const nowSec = Math.floor(this.nowFn().getTime() / 1000);

    let queryParams: string;
    if (typeof rangeOrDates === "object" && rangeOrDates.period1 !== undefined && rangeOrDates.period2 !== undefined) {
      queryParams = `period1=${rangeOrDates.period1}&period2=${rangeOrDates.period2}&interval=1d&events=div|split`;
    } else if (rangeOrDates === "max") {
      // Explicit period1=0 and period2=now ensures Yahoo returns true daily bars (5,000+) instead of silent monthly fallback
      queryParams = `period1=0&period2=${nowSec}&interval=1d&events=div|split`;
    } else {
      queryParams = `interval=1d&range=1mo&events=div|split`;
    }

    const url = `${this.baseUrl}/v8/finance/chart/${yahooSymbol}?${queryParams}`;

    const res = await this.executeRequest<any>("chart", url, symbol);

    // Verify dataGranularity is strictly daily (1d)
    if (res.outcome === "OK") {
      const granularity = res.body?.chart?.result?.[0]?.meta?.dataGranularity;
      if (granularity && granularity !== "1d") {
        res.outcome = "ERROR";
        const errMsg = `Invalid dataGranularity '${granularity}' in chart response. Expected '1d' daily bars.`;
        res.warnings.push(errMsg);
      }
    }

    return res;
  }

  /**
   * Fetches annual and quarterly fundamental facts from Yahoo timeseries endpoint.
   */
  async fetchFundamentals(symbol: string, exchange: "NSE" | "BSE"): Promise<YahooCallResult<any>> {
    const suffix = exchange === "NSE" ? ".NS" : ".BO";
    const yahooSymbol = `${symbol}${suffix}`;

    const items = [
      "annualTotalRevenue",
      "annualOperatingRevenue",
      "annualNetIncomeCommonStockholders",
      "annualEBITDA",
      "annualOperatingIncome",
      "annualTotalDebt",
      "annualStockholdersEquity",
      "annualTotalAssets",
      "annualFreeCashFlow",
      "annualOperatingCashFlow",
      "annualCapitalExpenditure",
      "quarterlyTotalRevenue",
      "quarterlyOperatingRevenue",
      "quarterlyNetIncomeCommonStockholders",
      "quarterlyEBITDA",
      "quarterlyOperatingIncome",
      "quarterlyTotalDebt",
      "quarterlyStockholdersEquity",
      "quarterlyTotalAssets",
      "quarterlyFreeCashFlow",
      "quarterlyOperatingCashFlow",
      "quarterlyCapitalExpenditure",
    ].join(",");

    const nowSec = Math.floor(this.nowFn().getTime() / 1000);
    // Period1: ~5 years ago
    const period1Sec = nowSec - 5 * 365 * 24 * 60 * 60;
    const url = `${this.baseUrl}/ws/fundamentals-timeseries/v1/finance/timeseries/${yahooSymbol}?type=${items}&merge=false&period1=${period1Sec}&period2=${nowSec}`;

    return this.executeRequest<any>("fundamentals", url, symbol);
  }

  getCallsToday(): number {
    return this.callsToday;
  }

  getMaxDailyBudget(): number {
    return this.maxDailyBudget;
  }
}
