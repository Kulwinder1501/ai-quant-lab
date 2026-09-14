import type { InstitutionalFlow } from "./institutional-flow.js";
import type { OffshoreDerivative } from "./offshore-derivative.js";

/**
 * How stale a published FII/DII print may be before it stops describing "now".
 *
 * NSE publishes every trading day, so a wider gap means the collector was down
 * rather than that the market was quiet. Defined here because it is a property of
 * the data, not of any one consumer: the autonomous agent, the ML feature loader
 * (`INSTITUTIONAL_FLOW_STALENESS_DAYS` in `contracts.py`), and this summary all
 * need the same number, and three independent literals would drift apart.
 */
export const INSTITUTIONAL_FLOW_STALENESS_DAYS = 5;

/**
 * How the two investor classes acted, relative to each other.
 *
 * Deliberately descriptive rather than directional. `institutionalFlowBias` in
 * the strategy engine grades flows into a confidence adjustment; that is a
 * trading opinion. This says only what the print reported, so the dashboard can
 * render a session without implying a view on it.
 */
export type InstitutionalFlowStance =
  | "BOTH_ACCUMULATING"
  | "BOTH_DISTRIBUTING"
  | "FOREIGN_INFLOW_DOMESTIC_OUTFLOW"
  | "FOREIGN_OUTFLOW_DOMESTIC_SUPPORT"
  | "BALANCED"
  | "UNKNOWN";

/** Net flows within this magnitude are treated as flat rather than directional. */
const FLAT_THRESHOLD_CR = 100;

export interface InstitutionalFlowSession {
  date: string;
  fiiCashNetCr: number | null;
  diiCashNetCr: number | null;
  /** Null when either leg is absent — summing an unknown with a number is not a total. */
  combinedNetCr: number | null;
  publishedAt: string;
  source: string;
  isProvisional: boolean;
}

export interface InstitutionalFlowSummary {
  latest: InstitutionalFlowSession | null;
  /** Most recent first, including `latest`. */
  history: InstitutionalFlowSession[];
  stance: InstitutionalFlowStance;
  /** Whole days between the latest session and `asOf`. Null when there is no print. */
  ageInDays: number | null;
  isStale: boolean;
  /** Rolling totals over `history`, skipping absent legs; null when every leg is absent. */
  fiiTotalCr: number | null;
  diiTotalCr: number | null;
  sessionsCovered: number;
}

function toSession(flow: InstitutionalFlow): InstitutionalFlowSession {
  const { fiiCashNetCr, diiCashNetCr } = flow;
  return {
    date: flow.date.toISOString().slice(0, 10),
    fiiCashNetCr,
    diiCashNetCr,
    combinedNetCr:
      fiiCashNetCr === null || diiCashNetCr === null
        ? null
        : Number((fiiCashNetCr + diiCashNetCr).toFixed(2)),
    publishedAt: flow.publishedAt.toISOString(),
    source: flow.source ?? "NSE_CURRENT_API",
    isProvisional: flow.isProvisional ?? true,
  };
}

export function classifyStance(
  fiiCashNetCr: number | null,
  diiCashNetCr: number | null,
): InstitutionalFlowStance {
  if (fiiCashNetCr === null || diiCashNetCr === null) return "UNKNOWN";

  const fiiFlat = Math.abs(fiiCashNetCr) < FLAT_THRESHOLD_CR;
  const diiFlat = Math.abs(diiCashNetCr) < FLAT_THRESHOLD_CR;
  if (fiiFlat && diiFlat) return "BALANCED";

  const fiiBuying = fiiCashNetCr > 0;
  const diiBuying = diiCashNetCr > 0;
  if (fiiBuying && diiBuying) return "BOTH_ACCUMULATING";
  if (!fiiBuying && !diiBuying) return "BOTH_DISTRIBUTING";
  return fiiBuying ? "FOREIGN_INFLOW_DOMESTIC_OUTFLOW" : "FOREIGN_OUTFLOW_DOMESTIC_SUPPORT";
}

/** Whole days between two UTC-midnight-anchored session dates. */
function ageInWholeDays(session: Date, asOf: Date): number {
  const asOfMidnight = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.floor((asOfMidnight - session.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Build the dashboard read model for a run of published prints.
 *
 * `flows` may arrive in any order; it is sorted most-recent-first here so a
 * caller changing its query's ORDER BY cannot silently relabel which session is
 * "latest". Absent legs stay absent throughout — a null is never summed as 0,
 * for the same reason the ML loader leaves the feature missing.
 */
export function summariseInstitutionalFlows(
  flows: readonly InstitutionalFlow[],
  asOf: Date,
): InstitutionalFlowSummary {
  const history = [...flows]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map(toSession);
  const latestFlow = [...flows].sort((a, b) => b.date.getTime() - a.date.getTime())[0];

  if (!latestFlow) {
    return {
      latest: null,
      history: [],
      stance: "UNKNOWN",
      ageInDays: null,
      isStale: true,
      fiiTotalCr: null,
      diiTotalCr: null,
      sessionsCovered: 0,
    };
  }

  const sumPresent = (pick: (s: InstitutionalFlowSession) => number | null): number | null => {
    const present = history.map(pick).filter((v): v is number => v !== null);
    return present.length === 0 ? null : Number(present.reduce((a, b) => a + b, 0).toFixed(2));
  };

  const ageInDays = ageInWholeDays(latestFlow.date, asOf);
  return {
    latest: toSession(latestFlow),
    history,
    stance: classifyStance(latestFlow.fiiCashNetCr, latestFlow.diiCashNetCr),
    ageInDays,
    isStale: ageInDays > INSTITUTIONAL_FLOW_STALENESS_DAYS,
    fiiTotalCr: sumPresent((s) => s.fiiCashNetCr),
    diiTotalCr: sumPresent((s) => s.diiCashNetCr),
    sessionsCovered: history.length,
  };
}

/**
 * GIFT Nifty's premium/discount to the domestic close, in basis points.
 *
 * Basis points rather than points so the figure stays comparable across eras,
 * matching the scale-free rule the `ml-feature-v5` contract is built on.
 */
export function impliedGapBps(offshoreClose: number, domesticClose: number): number | null {
  if (!Number.isFinite(offshoreClose) || !Number.isFinite(domesticClose)) return null;
  if (offshoreClose <= 0 || domesticClose <= 0) return null;
  return Number((((offshoreClose - domesticClose) / domesticClose) * 10_000).toFixed(2));
}

/**
 * Why no GIFT Nifty print is available, when there is none.
 *
 * `PROVIDER_NOT_CONFIGURED` is the default state, not an error: GIFT Nifty trades
 * on NSE IX, which publishes no free machine-readable feed, and no Yahoo symbol
 * carries the contract either (`GIFTNIFTY`, `NIFTY_F1`, `^NSEIX`, `GIFT=F`,
 * `SGXNIFTY`, `IN50=F` and `NIFTYF.NS` were all checked and all 404). The NIFTY 50
 * spot index is *not* substituted, even though public "GIFT Nifty live" pages do
 * exactly that: spot is already this database's NIFTY50 candle series, so filing
 * it as an offshore print would make the implied overnight gap a comparison of the
 * Indian close with itself — a fabricated signal, and structurally a leak.
 */
export type GiftNiftyUnavailableReason = "PROVIDER_NOT_CONFIGURED" | "NO_PRINT_COLLECTED";

export interface GiftNiftyStatus {
  available: boolean;
  reason: GiftNiftyUnavailableReason | null;
  instrumentId: string;
  date: string | null;
  closePrice: number | null;
  publishedAt: string | null;
  /** The domestic close the gap was measured against, when one was resolvable. */
  domesticClose: number | null;
  impliedGapBps: number | null;
  configuredSymbol: string | null;
}

export function buildGiftNiftyStatus(input: {
  print: OffshoreDerivative | null;
  domesticClose: number | null;
  configuredSymbol: string | null;
}): GiftNiftyStatus {
  const { print, domesticClose, configuredSymbol } = input;

  if (!print) {
    return {
      available: false,
      reason: configuredSymbol ? "NO_PRINT_COLLECTED" : "PROVIDER_NOT_CONFIGURED",
      instrumentId: "GIFT_NIFTY",
      date: null,
      closePrice: null,
      publishedAt: null,
      domesticClose: null,
      impliedGapBps: null,
      configuredSymbol,
    };
  }

  return {
    available: true,
    reason: null,
    instrumentId: print.instrumentId,
    date: print.date.toISOString().slice(0, 10),
    closePrice: print.closePrice,
    publishedAt: print.publishedAt.toISOString(),
    domesticClose,
    impliedGapBps: domesticClose === null ? null : impliedGapBps(print.closePrice, domesticClose),
    configuredSymbol,
  };
}
