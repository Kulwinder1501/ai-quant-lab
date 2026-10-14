/**
 * One line per ICT cell per day: which gate kept the strategy from trading.
 *
 * `ict-structure-v1` trades only when four pillars agree and then a setup fires, so a quiet day has a reason, and
 * the reason is in `ict_state_snapshots.alignment_status`, one row per closed bar. Without this the only signal was
 * "no trades", which reads the same whether the strategy is waiting correctly or is broken. On 2026-10-14 it was
 * waiting: a bearish daily bias against a bullish 15m bounce blocked 62% of bars.
 */
export interface IctGateBar {
  readonly alignmentStatus: string;
  readonly biasDirection: string;
}

export interface IctGateSummary {
  readonly bars: number;
  /** The most frequent higher-timeframe bias among the day's bars, or null when there were no bars. */
  readonly bias: string | null;
  /** Bars where every pillar agreed. The setup trigger (sweep, shift, retrace) still has to fire on top of these. */
  readonly alignedBars: number;
  readonly blocked: ReadonlyArray<{ readonly status: string; readonly bars: number }>;
  readonly topBlocker: string | null;
  readonly ideas: number;
  readonly trades: number;
}

const BLOCKER_LABELS: Readonly<Record<string, string>> = {
  BLOCKED_BIAS_STRUCTURE_DISAGREEMENT: "bias and structure disagree",
  BLOCKED_DISCOUNT_SHORT: "already in discount (no short)",
  BLOCKED_PREMIUM_LONG: "already in premium (no long)",
  BLOCKED_MISSING_PILLAR: "a pillar is missing",
};

export function blockerLabel(status: string): string {
  return BLOCKER_LABELS[status] ?? status.toLowerCase().replace(/^blocked_/, "").replaceAll("_", " ");
}

export function summariseIctGates(
  bars: readonly IctGateBar[],
  counts: { ideas: number; trades: number },
): IctGateSummary {
  const blockedCounts = new Map<string, number>();
  const biasCounts = new Map<string, number>();
  let alignedBars = 0;
  for (const bar of bars) {
    biasCounts.set(bar.biasDirection, (biasCounts.get(bar.biasDirection) ?? 0) + 1);
    if (bar.alignmentStatus.startsWith("ALIGNED_")) alignedBars += 1;
    else blockedCounts.set(bar.alignmentStatus, (blockedCounts.get(bar.alignmentStatus) ?? 0) + 1);
  }
  const blocked = [...blockedCounts.entries()]
    .map(([status, count]) => ({ status, bars: count }))
    .sort((a, b) => b.bars - a.bars || a.status.localeCompare(b.status));
  const bias = [...biasCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    bars: bars.length,
    bias,
    alignedBars,
    blocked,
    topBlocker: blocked[0]?.status ?? null,
    ideas: counts.ideas,
    trades: counts.trades,
  };
}

const percent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

export function formatIctGateLine(date: string, cell: string, summary: IctGateSummary): string {
  if (summary.bars === 0) return `ICT ${date} ${cell}: no bars recorded (market closed, or the capture did not run)`;
  const parts = summary.blocked.map((item) => `${percent(item.bars, summary.bars)} ${blockerLabel(item.status)}`);
  if (summary.alignedBars > 0) parts.push(`${percent(summary.alignedBars, summary.bars)} aligned (setup trigger not met)`);
  const topBlockedBars = summary.blocked[0]?.bars ?? 0;
  // When the pillars agreed on more bars than any single gate blocked, the day was quiet because the setup itself
  // (sweep, shift, retrace) never fired, not because a gate held the strategy back.
  const lead = summary.topBlocker === null
    ? "every bar was aligned"
    : summary.alignedBars > topBlockedBars
      ? "mostly aligned: the setup trigger did not fire"
      : `mostly blocked: ${blockerLabel(summary.topBlocker)}`;
  return `ICT ${date} ${cell}: ${summary.bars} bars, bias ${summary.bias ?? "n/a"} | ${lead} | ${parts.join(", ")} | ideas ${summary.ideas}, trades ${summary.trades}`;
}
