/**
 * The paper-trading bot sandboxes, in a module that does not run on import.
 *
 * Extracted from `run-paper-trading-bot.ts` on 2026-09-03 when a third arm was added.
 * That file calls `main()` at module scope -- the scheduler's own comment records why it refuses to
 * import from there: "importing its `DUAL_BOT_SANDBOX` would run the whole bot inside this process
 * on startup -- opening positions and closing the pool out from under the scheduler."
 *
 * The rosters are the one thing about the bots that a test must be able to check, because arm
 * disjointness is what the entire Classic-vs-Sniper comparison rests on and nothing enforced it.
 */

export interface BotSandboxSpec {
  name: string;
  allowedStrategies: readonly string[];
  initialBalance: number;
}

/**
 * Two scalping sandboxes whose only intended difference is candlestick and price-action patterns.
 *
 * ## The arms are disjoint, and the question is "instead of", not "in addition to"
 *
 * Classic runs the base scalp. Sniper runs the pattern strategies and nothing else. A difference
 * between them therefore answers "do the pattern strategies beat the base strategy", not "do patterns
 * add to it".
 *
 * The additive question is the more interesting one and it is what this file attempted from
 * 2026-08-17, with Sniper carrying `momentum-scalp-index` as well so both arms saw the same base
 * signal. It was abandoned on 2026-08-19 because it is not measurable here, and the reason is
 * structural rather than a matter of tuning:
 *
 * Both strategy families fire on the same instrument and timeframe, so `prepare-option-entry`
 * resolves their signals to the *same* ATM contract. Sniper is therefore already holding the contract
 * from its base trade when the pattern signal arrives, and `heldContracts` refuses it as
 * ALREADY_HOLDING. Measured over the two sessions the nested arrangement actually ran: pattern
 * strategies raised 31 ideas on 08-18 and 4 on 08-19, of which Sniper converted **2 and 0**. Of the
 * four refusals recorded on 08-19, three were ALREADY_HOLDING. The treatment arm was being absorbed
 * into positions it already held, so the experiment had a control and almost no treatment.
 *
 * Note what it was *not*: there were zero POSITION_LIMIT refusals, so this was never
 * `MAX_CONCURRENT_POSITIONS` crowding the pattern trades out. Loosening the contract guard would
 * "fix" it only by letting one account hold two positions in the same contract with different stops,
 * which is the thing that guard exists to prevent.
 *
 * ## Why disjoint is safe now, having failed before
 *
 * Sniper listed the pattern strategies alone until 2026-08-17 and took **no trade at all** that day
 * against Classic's eleven, which is what motivated nesting. That was not a flaw in the disjoint
 * design: `pattern_detections` was empty on 1m/5m/15m, so the pattern strategies reported
 * RULES_NOT_MET against a table with nothing in it. Detection has since been fixed and is healthy
 * (2,145 detections on 1m and 529 on 5m over the last two sessions), and the strategies now raise
 * ideas of their own. Sniper will get a thin sample rather than an empty one -- and, unlike under
 * nesting, it will get *all* of it instead of losing three signals in four to the contract guard.
 *
 * The other objection to disjoint arms is also gone. Before 2026-08-18,
 * `openFromTradeIdeaWithinTransaction` required an idea to be `PROPOSED` and then set it to
 * `ACCEPTED`, so whichever bot ran first consumed a shared signal outright. Disjoint arms never share
 * an idea, so that gate no longer bears on this either way -- but it is why every Classic-vs-Sniper
 * comparison from before that date is confounded rather than merely noisy, and should be discarded.
 *
 * `trend-breakout` was removed from Classic on 2026-08-17 -- it is a 15m-and-slower trend strategy
 * rather than a scalp, so it was both an asymmetry between the arms and outside the band these bots
 * own.
 *
 * That leaves `trend-breakout` traded by no bot. It is still registered, so idea generation still
 * runs it and its ideas remain available to research and backtesting; the autonomous agent does
 * not read this registry and is unaffected. Not a bug, but an unowned strategy produces ideas
 * nothing will act on, which is worth knowing before reading an idea count as intent to trade.
 *
 * `momentum-scalp` was unowned for the same reason until 2026-09-03 and now has its own arm below.
 * The cost of leaving it unowned was measurable: **0 of 37 ideas traded** across 08-31, 09-01, 09-02
 * and 09-03 while every other strategy's ideas were being acted on. It was generating signals into
 * a void, and the proposals grid displayed them indistinguishably from ideas a bot would take.
 */
export const DUAL_BOT_SANDBOX: readonly BotSandboxSpec[] = [
  {
    name: "AutoBot-Classic",
    allowedStrategies: ["momentum-scalp-index"],
    initialBalance: 1_000_000,
  },
  {
    name: "AutoBot-Sniper",
    // Patterns only. `momentum-scalp-index` was here from 2026-08-17 to 2026-08-19 to make the arms
    // nested; see above for why that could not be measured.
    allowedStrategies: [
      "momentum-scalp-pattern",
      "momentum-scalp-pattern-v2",
    ],
    initialBalance: 1_000_000,
  },
  /**
   * The 1m base scalp, which nothing traded until 2026-09-03.
   *
   * ## Why a third arm rather than adding it to an existing one
   *
   * Classic and Sniper answer one question -- "do the pattern strategies beat the base strategy" --
   * and that answer depends on the arms being disjoint and differing in exactly one thing. Adding
   * `momentum-scalp` to either would change what its arm *is*, and every Classic-vs-Sniper
   * comparison from that day forward would be measuring two changes at once. The A/B is already
   * confounded before 2026-08-18 for a related reason; doing it again deliberately would be worse.
   *
   * A third arm is safe precisely because `momentum-scalp` appears in neither existing roster, so
   * the existing comparison is untouched. It is also the only strategy on `1m`, so this arm cannot
   * compete with the others for the same bar.
   *
   * ## What this does not claim
   *
   * Nothing here says the strategy works. `momentum-scalp` has **no measured edge** -- it loses on
   * 1d even frictionless, and the low-volatility edge that looked real decayed out of sample. It has
   * never traded live, so there is no per-strategy evidence either way, which is the point: an
   * unowned strategy cannot accumulate any.
   *
   * Sides are left unrestricted for the same reason. LONG is the measured loser on *both* other live
   * scalps, so there is a real prior that it will lose here too -- but that is evidence about
   * `momentum-scalp-index` and `momentum-scalp-pattern`, not about this rule. Importing another
   * strategy's finding as this one's restriction would pre-decide the question the arm exists to
   * answer. Restrict it when its own trades say so.
   *
   * Uncapped and at the same opening balance as the other two, so a later comparison is not
   * confounded by the sandbox rather than the strategy. The account is created on first run, and the
   * exit sweep finds its positions from the data rather than from this roster, so nothing else needs
   * to change.
   */
  {
    name: "AutoBot-Scalp1m",
    allowedStrategies: ["momentum-scalp"],
    initialBalance: 1_000_000,
  },
];
