/**
 * Market Context Map (`mkt-ctx-v1`) — point-in-time trend, day extremes, S/R, location, hypothesis.
 *
 * Pure domain: bars + optional FRVP levels + swing S/R in → map out. No I/O.
 * Normative: docs/2026-10-13-market-context-observation-protocol.md
 *
 * Observation only when stamped on Sniper; does not authorize trades.
 */

export const MARKET_CONTEXT_ALGORITHM_VERSION = "mkt-ctx-v1";

/** Opening-range length in completed 1m bars from 09:15 IST. */
export const OPENING_RANGE_MINUTES = 15;
/** Proximity to a level, in ATR units (matches Sniper maxSrDistanceAtr). */
export const LEVEL_PROXIMITY_ATR = 1.5;
/** Bars to scan for FADE reclaim after a probe. */
export const FADE_LOOKBACK_BARS = 30;
/** Consecutive closes outside a level for BREAK acceptance. */
export const BREAK_ACCEPTANCE_BARS = 15;

export type TrendLabel = "UP" | "DOWN" | "MIXED";
export type HtfAgreement = "AGREE" | "DISAGREE" | "MIXED" | "UNKNOWN";
export type LocationLabel =
  | "AT_RESISTANCE"
  | "AT_SUPPORT"
  | "INSIDE_RANGE"
  | "BREAKING_HIGH"
  | "BREAKING_LOW"
  | "FAR";
export type LevelHypothesis = "FADE" | "BREAK" | "AMBIGUOUS";
export type DataQuality = "PASS" | "FEATURE_UNAVAILABLE" | "FAIL";
export type TradeDirection = "LONG" | "SHORT";

export type ShadowVetoReason =
  | "LONG_AT_RESISTANCE"
  | "SHORT_AT_SUPPORT"
  | "HTF_DISAGREE"
  | "AMBIGUOUS_AT_LEVEL";

export interface ContextBar {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SwingLevel {
  kind: "SUPPORT" | "RESISTANCE";
  level: number;
}

export interface PriorValueArea {
  vah: number;
  val: number;
  poc: number;
}

export interface TrendSlice {
  strict: TrendLabel;
  soft: TrendLabel;
}

export interface KeyLevels {
  sessionHigh: number | null;
  sessionLow: number | null;
  priorDayHigh: number | null;
  priorDayLow: number | null;
  priorDayClose: number | null;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  priorVah: number | null;
  priorVal: number | null;
  priorPoc: number | null;
  nearestSwingSupport: number | null;
  nearestSwingResistance: number | null;
}

export interface NearestLevel {
  name: string;
  level: number;
  distancePoints: number;
  distanceAtr: number;
  side: "ABOVE" | "BELOW" | "AT";
}

export interface MarketContextMap {
  algorithmVersion: string;
  dataQuality: DataQuality;
  atr: number;
  price: number;
  direction: TradeDirection | null;
  trend: {
    tf5: TrendSlice | null;
    tf15: TrendSlice | null;
    /** Hourly trend, recorded for the review only; it takes no part in htfAgreement. */
    tf60?: TrendSlice | null;
    sessionBias: TrendLabel;
    htfAgreement: HtfAgreement;
  };
  levels: KeyLevels;
  location: LocationLabel;
  hypothesis: LevelHypothesis;
  nearest: NearestLevel | null;
  wouldBlock: boolean;
  vetoReasons: ShadowVetoReason[];
  sentence: string;
}

export interface BuildMarketContextInput {
  /** Completed bars of the evaluation session (IST day), oldest first, up to decision. */
  sessionBars: readonly ContextBar[];
  /** Completed bars of the prior IST session (for PDH/PDL/C). */
  priorSessionBars: readonly ContextBar[];
  atr: number;
  price: number;
  direction?: TradeDirection | null;
  swingLevels?: readonly SwingLevel[];
  priorValueArea?: PriorValueArea | null;
  /** Digested HTF trend labels when available. */
  tf5?: TrendSlice | null;
  tf15?: TrendSlice | null;
  tf60?: TrendSlice | null;
  /** IST calendar date of the session being evaluated, YYYY-MM-DD. */
  sessionDateIst: string;
}

const INDIA_OFFSET_MS = 5.5 * 3_600_000;

export function indiaClockMinutes(instant: Date): { hour: number; minute: number } {
  const local = new Date(instant.getTime() + INDIA_OFFSET_MS);
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

export function isRthMinute(instant: Date): boolean {
  const { hour, minute } = indiaClockMinutes(instant);
  const m = hour * 60 + minute;
  return m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

function trendFromBools(up: boolean, down: boolean): TrendLabel {
  if (up && !down) return "UP";
  if (down && !up) return "DOWN";
  return "MIXED";
}

/**
 * Builds strict/soft trend from optional Supertrend and EMA agreement with price.
 * Missing both → MIXED (unknown), not a fabricated direction.
 */
export function trendSliceFromIndicators(input: {
  price: number;
  ema: number | null;
  supertrendUp: boolean | null;
}): TrendSlice {
  const emaUp = input.ema !== null ? input.price > input.ema : null;
  const emaDown = input.ema !== null ? input.price < input.ema : null;
  const stUp = input.supertrendUp;
  const stDown = stUp === null ? null : !stUp;

  const softUp = (emaUp === true) || (stUp === true);
  const softDown = (emaDown === true) || (stDown === true);
  const soft = trendFromBools(softUp, softDown);

  const strictUp = emaUp === true && stUp === true;
  const strictDown = emaDown === true && stDown === true;
  const strict =
    emaUp === null || stUp === null
      ? soft
      : trendFromBools(strictUp, strictDown);

  return { strict, soft };
}

function sessionBias(bars: readonly ContextBar[]): TrendLabel {
  if (bars.length === 0) return "MIXED";
  const open = bars[0]!.open;
  const last = bars[bars.length - 1]!.close;
  let typicalSum = 0;
  let vol = 0;
  for (const b of bars) {
    const w = Math.max(b.volume, 1e-9);
    typicalSum += ((b.high + b.low + b.close) / 3) * w;
    vol += w;
  }
  const vwap = typicalSum / vol;
  const up = last > open && last >= vwap;
  const down = last < open && last <= vwap;
  return trendFromBools(up, down);
}

function openingRange(bars: readonly ContextBar[]): { high: number; low: number } | null {
  const orBars: ContextBar[] = [];
  for (const b of bars) {
    if (!isRthMinute(b.openTime)) continue;
    const { hour, minute } = indiaClockMinutes(b.openTime);
    const m = hour * 60 + minute;
    if (m < 9 * 60 + 15) continue;
    if (m >= 9 * 60 + 15 + OPENING_RANGE_MINUTES) break;
    orBars.push(b);
  }
  if (orBars.length === 0) return null;
  return {
    high: Math.max(...orBars.map((b) => b.high)),
    low: Math.min(...orBars.map((b) => b.low)),
  };
}

function priorDayOhlc(bars: readonly ContextBar[]): {
  high: number;
  low: number;
  close: number;
} | null {
  if (bars.length === 0) return null;
  return {
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars[bars.length - 1]!.close,
  };
}

interface NamedLevel {
  name: string;
  level: number;
  role: "resistance" | "support" | "neutral";
}

function collectLevels(input: BuildMarketContextInput, sessionHigh: number | null, sessionLow: number | null): NamedLevel[] {
  const out: NamedLevel[] = [];
  const push = (name: string, level: number | null | undefined, role: NamedLevel["role"]) => {
    if (level === null || level === undefined || !Number.isFinite(level)) return;
    out.push({ name, level, role });
  };

  const or = openingRange(input.sessionBars);
  const prior = priorDayOhlc(input.priorSessionBars);

  push("sessionHigh", sessionHigh, "resistance");
  push("sessionLow", sessionLow, "support");
  push("priorDayHigh", prior?.high ?? null, "resistance");
  push("priorDayLow", prior?.low ?? null, "support");
  push("priorDayClose", prior?.close ?? null, "neutral");
  push("openingRangeHigh", or?.high ?? null, "resistance");
  push("openingRangeLow", or?.low ?? null, "support");
  push("priorVah", input.priorValueArea?.vah ?? null, "resistance");
  push("priorVal", input.priorValueArea?.val ?? null, "support");
  push("priorPoc", input.priorValueArea?.poc ?? null, "neutral");

  for (const s of input.swingLevels ?? []) {
    push(
      s.kind === "SUPPORT" ? "swingSupport" : "swingResistance",
      s.level,
      s.kind === "SUPPORT" ? "support" : "resistance",
    );
  }
  return out;
}

function nearestLevel(price: number, atr: number, levels: readonly NamedLevel[]): NearestLevel | null {
  if (atr <= 0 || levels.length === 0) return null;
  let best: NearestLevel | null = null;
  for (const L of levels) {
    const distancePoints = Math.abs(price - L.level);
    const distanceAtr = distancePoints / atr;
    const side: NearestLevel["side"] =
      Math.abs(price - L.level) <= atr * 0.05 ? "AT" : price > L.level ? "ABOVE" : "BELOW";
    if (!best || distanceAtr < best.distanceAtr) {
      best = { name: L.name, level: L.level, distancePoints, distanceAtr, side };
    }
  }
  return best;
}

function classifyLocation(
  price: number,
  atr: number,
  nearest: NearestLevel | null,
  levels: readonly NamedLevel[],
  sessionHigh: number | null,
  sessionLow: number | null,
): LocationLabel {
  const band = LEVEL_PROXIMITY_ATR * atr;
  if (sessionHigh !== null && price > sessionHigh + atr * 0.05) return "BREAKING_HIGH";
  if (sessionLow !== null && price < sessionLow - atr * 0.05) return "BREAKING_LOW";
  if (!nearest || nearest.distanceAtr > LEVEL_PROXIMITY_ATR) {
    if (sessionHigh !== null && sessionLow !== null && price <= sessionHigh && price >= sessionLow) {
      return "INSIDE_RANGE";
    }
    return "FAR";
  }

  const named = levels.find((l) => l.name === nearest.name && l.level === nearest.level);
  if (named?.role === "resistance" && nearest.distancePoints <= band) return "AT_RESISTANCE";
  if (named?.role === "support" && nearest.distancePoints <= band) return "AT_SUPPORT";
  if (sessionHigh !== null && sessionLow !== null && price <= sessionHigh && price >= sessionLow) {
    return "INSIDE_RANGE";
  }
  return "FAR";
}

function classifyHypothesis(
  bars: readonly ContextBar[],
  nearest: NearestLevel | null,
  location: LocationLabel,
): LevelHypothesis {
  if (location === "BREAKING_HIGH" || location === "BREAKING_LOW") return "BREAK";
  if (!nearest || bars.length === 0) return "AMBIGUOUS";

  const level = nearest.level;
  const recent = bars.slice(-Math.max(FADE_LOOKBACK_BARS, BREAK_ACCEPTANCE_BARS));
  if (recent.length === 0) return "AMBIGUOUS";

  let outsideStreak = 0;
  let probedBeyond = false;
  let reclaimed = false;
  for (const b of recent) {
    const above = b.close > level;
    const below = b.close < level;
    const outside = nearest.side === "BELOW" || location === "AT_RESISTANCE"
      ? above
      : below;
    // Generic: outside means close on the "beyond" side of a resistance (above) or support (below).
    const beyondResistance = b.high > level && b.close > level;
    const beyondSupport = b.low < level && b.close < level;
    if (beyondResistance || beyondSupport) probedBeyond = true;
    if (probedBeyond && b.close <= level && beyondResistance === false && location === "AT_RESISTANCE") {
      reclaimed = true;
    }
    if (probedBeyond && b.close >= level && beyondSupport === false && location === "AT_SUPPORT") {
      reclaimed = true;
    }

    if (outside || beyondResistance || beyondSupport) {
      outsideStreak += 1;
    } else {
      outsideStreak = 0;
    }
  }

  // Sustained acceptance outside the level is BREAK even if a brief reclaim also appeared in the
  // lookback; a still-outside streak is the live state at decision time.
  if (outsideStreak >= BREAK_ACCEPTANCE_BARS) return "BREAK";
  if (reclaimed) return "FADE";
  return "AMBIGUOUS";
}

function htfAgreement(
  direction: TradeDirection | null | undefined,
  tf5: TrendSlice | null | undefined,
  tf15: TrendSlice | null | undefined,
): HtfAgreement {
  if (!direction) return "UNKNOWN";
  const wanted: TrendLabel = direction === "LONG" ? "UP" : "DOWN";
  const labels = [tf5?.soft, tf15?.soft].filter((x): x is TrendLabel => x != null);
  if (labels.length === 0) return "UNKNOWN";
  const agree = labels.filter((l) => l === wanted).length;
  const disagree = labels.filter((l) => l !== "MIXED" && l !== wanted).length;
  if (agree === labels.length) return "AGREE";
  if (disagree === labels.length) return "DISAGREE";
  if (disagree > 0 && agree > 0) return "MIXED";
  if (disagree > 0) return "DISAGREE";
  if (agree > 0) return "AGREE";
  return "MIXED";
}

export function shadowVetoReasons(input: {
  direction: TradeDirection | null | undefined;
  location: LocationLabel;
  hypothesis: LevelHypothesis;
  htfAgreement: HtfAgreement;
}): ShadowVetoReason[] {
  const reasons: ShadowVetoReason[] = [];
  const dir = input.direction;
  if (dir === "LONG" && input.location === "AT_RESISTANCE" && input.hypothesis !== "BREAK") {
    reasons.push("LONG_AT_RESISTANCE");
  }
  if (dir === "SHORT" && input.location === "AT_SUPPORT" && input.hypothesis !== "BREAK") {
    reasons.push("SHORT_AT_SUPPORT");
  }
  if (input.htfAgreement === "DISAGREE") {
    reasons.push("HTF_DISAGREE");
  }
  if (
    (input.location === "AT_RESISTANCE" || input.location === "AT_SUPPORT")
    && input.hypothesis === "AMBIGUOUS"
  ) {
    reasons.push("AMBIGUOUS_AT_LEVEL");
  }
  return reasons;
}

function buildSentence(map: Omit<MarketContextMap, "sentence">): string {
  const t5 = map.trend.tf5?.soft ?? "n/a";
  const t15 = map.trend.tf15?.soft ?? "n/a";
  const near = map.nearest
    ? `${map.nearest.name}@${map.nearest.level.toFixed(1)} (${map.nearest.distanceAtr.toFixed(2)} ATR)`
    : "none";
  return (
    `Trend tf5=${t5} tf15=${t15} session=${map.trend.sessionBias} htf=${map.trend.htfAgreement}; `
    + `nearest=${near}; loc=${map.location}; hyp=${map.hypothesis}; `
    + `dq=${map.dataQuality}; wouldBlock=${map.wouldBlock}`
  );
}

export function buildMarketContextMap(input: BuildMarketContextInput): MarketContextMap {
  const atr = input.atr;
  const price = input.price;
  if (!(atr > 0) || !(price > 0) || !Number.isFinite(atr) || !Number.isFinite(price)) {
    const emptyLevels: KeyLevels = {
      sessionHigh: null, sessionLow: null, priorDayHigh: null, priorDayLow: null,
      priorDayClose: null, openingRangeHigh: null, openingRangeLow: null,
      priorVah: null, priorVal: null, priorPoc: null,
      nearestSwingSupport: null, nearestSwingResistance: null,
    };
    const base = {
      algorithmVersion: MARKET_CONTEXT_ALGORITHM_VERSION,
      dataQuality: "FAIL" as const,
      atr: atr > 0 ? atr : 0,
      price,
      direction: input.direction ?? null,
      trend: {
        tf5: input.tf5 ?? null,
        tf15: input.tf15 ?? null,
        tf60: input.tf60 ?? null,
        sessionBias: "MIXED" as const,
        htfAgreement: "UNKNOWN" as const,
      },
      levels: emptyLevels,
      location: "FAR" as const,
      hypothesis: "AMBIGUOUS" as const,
      nearest: null,
      wouldBlock: false,
      vetoReasons: [] as ShadowVetoReason[],
    };
    return { ...base, sentence: buildSentence(base) };
  }

  const rth = input.sessionBars.filter((b) => isRthMinute(b.openTime));
  const usable = rth.length > 0 ? rth : input.sessionBars;
  if (usable.length === 0) {
    const emptyLevels: KeyLevels = {
      sessionHigh: null, sessionLow: null, priorDayHigh: null, priorDayLow: null,
      priorDayClose: null, openingRangeHigh: null, openingRangeLow: null,
      priorVah: null, priorVal: null, priorPoc: null,
      nearestSwingSupport: null, nearestSwingResistance: null,
    };
    const base = {
      algorithmVersion: MARKET_CONTEXT_ALGORITHM_VERSION,
      dataQuality: "FEATURE_UNAVAILABLE" as const,
      atr,
      price,
      direction: input.direction ?? null,
      trend: {
        tf5: input.tf5 ?? null,
        tf15: input.tf15 ?? null,
        tf60: input.tf60 ?? null,
        sessionBias: "MIXED" as const,
        htfAgreement: htfAgreement(input.direction, input.tf5, input.tf15),
      },
      levels: emptyLevels,
      location: "FAR" as const,
      hypothesis: "AMBIGUOUS" as const,
      nearest: null,
      wouldBlock: false,
      vetoReasons: [] as ShadowVetoReason[],
    };
    return { ...base, sentence: buildSentence(base) };
  }

  const sessionHigh = Math.max(...usable.map((b) => b.high));
  const sessionLow = Math.min(...usable.map((b) => b.low));
  const or = openingRange(usable);
  const prior = priorDayOhlc(input.priorSessionBars);
  const swings = input.swingLevels ?? [];
  const nearestSwingSupport = (() => {
    const below = swings.filter((s) => s.kind === "SUPPORT" && s.level <= price);
    return below.length === 0 ? null : Math.max(...below.map((s) => s.level));
  })();
  const nearestSwingResistance = (() => {
    const above = swings.filter((s) => s.kind === "RESISTANCE" && s.level >= price);
    return above.length === 0 ? null : Math.min(...above.map((s) => s.level));
  })();

  const levels: KeyLevels = {
    sessionHigh,
    sessionLow,
    priorDayHigh: prior?.high ?? null,
    priorDayLow: prior?.low ?? null,
    priorDayClose: prior?.close ?? null,
    openingRangeHigh: or?.high ?? null,
    openingRangeLow: or?.low ?? null,
    priorVah: input.priorValueArea?.vah ?? null,
    priorVal: input.priorValueArea?.val ?? null,
    priorPoc: input.priorValueArea?.poc ?? null,
    nearestSwingSupport,
    nearestSwingResistance,
  };

  const named = collectLevels(input, sessionHigh, sessionLow);
  const nearest = nearestLevel(price, atr, named);
  const location = classifyLocation(price, atr, nearest, named, sessionHigh, sessionLow);
  const hypothesis = classifyHypothesis(usable, nearest, location);
  const agreement = htfAgreement(input.direction, input.tf5, input.tf15);
  const vetoReasons = shadowVetoReasons({
    direction: input.direction,
    location,
    hypothesis,
    htfAgreement: agreement,
  });

  const mapWithoutSentence = {
    algorithmVersion: MARKET_CONTEXT_ALGORITHM_VERSION,
    dataQuality: "PASS" as const,
    atr,
    price,
    direction: input.direction ?? null,
    trend: {
      tf5: input.tf5 ?? null,
      tf15: input.tf15 ?? null,
      tf60: input.tf60 ?? null,
      sessionBias: sessionBias(usable),
      htfAgreement: agreement,
    },
    levels,
    location,
    hypothesis,
    nearest,
    wouldBlock: vetoReasons.length > 0,
    vetoReasons,
  };

  return { ...mapWithoutSentence, sentence: buildSentence(mapWithoutSentence) };
}

/** Compact JSON body for the MKT_CTX stamp (rounded for readability). */
export function marketContextStampBody(map: MarketContextMap): Record<string, unknown> {
  const r1 = (n: number | null | undefined) =>
    n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
  const r2 = (n: number | null | undefined) =>
    n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;

  return {
    v: map.algorithmVersion,
    dq: map.dataQuality,
    dir: map.direction,
    atr: r1(map.atr),
    px: r1(map.price),
    t5: map.trend.tf5?.soft ?? null,
    t5s: map.trend.tf5?.strict ?? null,
    t15: map.trend.tf15?.soft ?? null,
    t15s: map.trend.tf15?.strict ?? null,
    t60: map.trend.tf60?.soft ?? null,
    t60s: map.trend.tf60?.strict ?? null,
    sess: map.trend.sessionBias,
    htf: map.trend.htfAgreement,
    sh: r1(map.levels.sessionHigh),
    sl: r1(map.levels.sessionLow),
    pdh: r1(map.levels.priorDayHigh),
    pdl: r1(map.levels.priorDayLow),
    pdc: r1(map.levels.priorDayClose),
    orh: r1(map.levels.openingRangeHigh),
    orl: r1(map.levels.openingRangeLow),
    vah: r1(map.levels.priorVah),
    val: r1(map.levels.priorVal),
    poc: r1(map.levels.priorPoc),
    loc: map.location,
    hyp: map.hypothesis,
    near: map.nearest
      ? {
          n: map.nearest.name,
          lvl: r1(map.nearest.level),
          d: r1(map.nearest.distancePoints),
          da: r2(map.nearest.distanceAtr),
        }
      : null,
    wouldBlock: map.wouldBlock,
    veto: map.vetoReasons,
    sentence: map.sentence,
  };
}
