import { istSessionDate } from "../../platform/calendar/trading-session.js";
import { computeCandidateLevels, RANGE_LOOKBACK_SESSIONS, type DailyBar } from "../domain/levels.js";
import { evaluatePreOpenGate, type IndexIndicativeRow } from "../domain/preopen-gate.js";
import { evidenceId, type CandidateLevel, type EvidenceItem, type MarketSnapshot } from "../domain/snapshot.js";
import { PREMARKET_INSTRUMENTS, type PremarketInstrument } from "../domain/targets.js";
import type { CaptureResult, RunSlot, SnapshotSource } from "./run-premarket-bias.js";

export interface CueQuote {
  changePercent: number | null;
  price: number | null;
  observedAt: Date | null;
}

export interface SnapshotSourceDependencies {
  giftNiftyQuote(): Promise<{ lastPrice: number; changePercent: number; expiryDate: string } | null>;
  /** Keyed by the symbol as passed in; a missing key means no usable quote. */
  cueQuotes(symbols: readonly string[]): Promise<Map<string, CueQuote>>;
  indexIndicatives(): Promise<{ timestamp: string | null; rows: Record<PremarketInstrument, IndexIndicativeRow & { last: number | null }> }>;
  /** Completed daily bars strictly before `beforeDate`, oldest first. */
  dailyBars(instrument: PremarketInstrument, beforeDate: string, count: number): Promise<DailyBar[]>;
}

/** Symbols the model may read, with the name it sees. Every one was verified to resolve on 2026-10-12. */
export const ASIAN_CUES = [
  { symbol: "^N225", name: "Nikkei 225" },
  { symbol: "^HSI", name: "Hang Seng" },
  { symbol: "^KS11", name: "KOSPI" },
  { symbol: "^AXJO", name: "ASX 200" },
  { symbol: "^STI", name: "Straits Times" },
  { symbol: "000001.SS", name: "Shanghai Composite" },
] as const;

export const GLOBAL_CUES = [
  { symbol: "^GSPC", name: "S&P 500 (last cash close)" },
  { symbol: "^IXIC", name: "Nasdaq Composite (last cash close)" },
  { symbol: "ES=F", name: "S&P 500 futures" },
  { symbol: "NQ=F", name: "Nasdaq 100 futures" },
  { symbol: "CL=F", name: "WTI crude futures" },
  { symbol: "BZ=F", name: "Brent crude futures" },
  { symbol: "DX-Y.NYB", name: "US dollar index" },
  { symbol: "USDINR=X", name: "USD/INR" },
] as const;

/**
 * Assembles the deterministic snapshot the model is shown. All reads are injected, so this is the
 * single place that decides what evidence exists and in what order, and it is testable without a
 * network.
 *
 * Each cue carries the IST date of its own last trade in its label. A market that was shut (Japan
 * on a holiday) still returns a quote, and without that stamp a days-old change would read as
 * today's move.
 */
export class CapturePremarketSnapshot implements SnapshotSource {
  constructor(private readonly deps: SnapshotSourceDependencies) {}

  async capture(input: { sessionDate: string; runSlot: string; now: Date; slot: RunSlot }): Promise<CaptureResult> {
    const diagnostics: Record<string, unknown> = {};
    const evidence: EvidenceItem[] = [];
    const push = (item: Omit<EvidenceItem, "id">): void => { evidence.push({ id: evidenceId(evidence.length), ...item }); };

    try {
      const gift = await this.deps.giftNiftyQuote();
      if (gift) {
        const observedAt = input.now.toISOString();
        push({ category: "GIFT_NIFTY", label: `GIFT Nifty futures (${gift.expiryDate}) change vs previous settlement`, value: gift.changePercent, unit: "PERCENT_CHANGE", observedAt, source: "NSE_IX" });
        push({ category: "GIFT_NIFTY", label: `GIFT Nifty futures (${gift.expiryDate}) last price`, value: gift.lastPrice, unit: "PRICE", observedAt, source: "NSE_IX" });
      } else {
        diagnostics.giftNifty = "NO_QUOTE";
      }
    } catch (error) {
      diagnostics.giftNifty = `FETCH_FAILED: ${String(error)}`;
    }

    const cues = await this.deps.cueQuotes([...ASIAN_CUES, ...GLOBAL_CUES].map((cue) => cue.symbol)).catch((error: unknown) => {
      diagnostics.cues = `FETCH_FAILED: ${String(error)}`;
      return new Map<string, CueQuote>();
    });
    const missing: string[] = [];
    const addCue = (category: "ASIAN_INDEX" | "GLOBAL_CUE", cue: { symbol: string; name: string }): void => {
      const quote = cues.get(cue.symbol);
      if (!quote || quote.changePercent === null) { missing.push(cue.symbol); return; }
      const lastTrade = quote.observedAt ? istSessionDate(quote.observedAt) : "unknown date";
      push({
        category,
        label: `${cue.name} change (last trade ${lastTrade})`,
        value: quote.changePercent,
        unit: "PERCENT_CHANGE",
        observedAt: quote.observedAt ? quote.observedAt.toISOString() : null,
        source: "YAHOO",
      });
    };
    for (const cue of ASIAN_CUES) addCue("ASIAN_INDEX", cue);
    for (const cue of GLOBAL_CUES) addCue("GLOBAL_CUE", cue);
    if (missing.length > 0) diagnostics.missingCues = missing;

    if (input.slot === "0910") {
      try {
        const indicatives = await this.deps.indexIndicatives();
        const gate = evaluatePreOpenGate({ payloadTimestamp: indicatives.timestamp, rows: indicatives.rows, sessionDate: input.sessionDate, now: input.now });
        diagnostics.preOpenProbe = { timestamp: indicatives.timestamp, rows: indicatives.rows, gate: gate.ok ? "PASSED" : gate.reason };
        if (gate.ok) {
          for (const instrument of PREMARKET_INSTRUMENTS) {
            push({
              category: "NSE_PREOPEN",
              label: `${instrument} indicative pre-open price vs previous close`,
              value: gate.gaps[instrument].impliedGapPct,
              unit: "PERCENT_CHANGE",
              observedAt: gate.observedAt.toISOString(),
              source: "NSE_ALL_INDICES",
            });
          }
        }
      } catch (error) {
        diagnostics.preOpenProbe = { gate: `FETCH_FAILED: ${String(error)}` };
      }
    }

    const candidateLevels: CandidateLevel[] = [];
    for (const instrument of PREMARKET_INSTRUMENTS) {
      try {
        const bars = await this.deps.dailyBars(instrument, input.sessionDate, RANGE_LOOKBACK_SESSIONS);
        candidateLevels.push(...computeCandidateLevels(instrument, bars));
      } catch (error) {
        diagnostics[`levels_${instrument}`] = `FAILED: ${String(error)}`;
      }
    }

    const snapshot: MarketSnapshot = {
      sessionDate: input.sessionDate,
      runSlot: input.runSlot,
      capturedAt: input.now.toISOString(),
      evidence,
      candidateLevels,
    };
    return { snapshot, diagnostics };
  }
}
