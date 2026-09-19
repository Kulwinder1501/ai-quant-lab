# AutoBot-Scalp1m time-of-day gating — falsification program v1

**Registered 2026-09-16, before any measurement of a time-of-day filter.** Nothing below may be
revised after a result is seen. If the design turns out to be wrong, this document gets a dated
amendment saying so and the run is discarded, not re-scored.

## Why this exists

`momentum-scalp` on 1m (`AutoBot-Scalp1m`) has a measured, direction-symmetric adverse-signal
problem on both NIFTY50 and BANKNIFTY ([[scalp1m-adverse-signal-both-instruments]]), and the
obvious entry-side fixes are already closed: candlestick-pattern gating made it worse
([[patterns-make-scalping-worse]]), six chop filters mostly had the sign backwards
([[chop-filter-candidates-refuted]]), inverting the signal outright failed significance on fresh
data ([[scalp-signal-inversion-does-not-replicate]]), and a time-*in*-trade stall exit was shipped
to this exact bot and reverted against its own measurement (`a63c947` → `50f4a48`,
[[stall-rule-on-1m-is-a-time-stop]]). Time-of-day gating — restricting *when* the bot is allowed to
enter, rather than filtering *what* it enters on — is a different lever from all of those and has
not been tested here.

**Expected outcome, given the prior established by the four failures above, is NO_EDGE.** Writing
the rule down first is so that "the number went up on one slice" does not get to count as a result,
the same discipline the ICT falsification programs already use.

**One thing already in hand argues against the naive version of this hypothesis.** Today's three
live stop-outs (2026-09-16) fired at 12:05, 13:45 and 14:41 IST — two of three sit at the edge of or
outside the commonly-cited 11:30–13:30 "lunch chop" window, not inside it. The windows below are
therefore not chosen to match that anecdote; they are chosen to separate two different candidate
mechanisms (see Threats, below).

## Prerequisite: disentangle from the known collector downtime

There is an already-documented ~11:00–12:45 IST daily Fyers/collector downtime that causes ~80% of
D2 option-quote coverage failures ([[d2-coverage-lost-to-daily-server-downtime]]). If NIFTY50/
BANKNIFTY momentum-scalp trades placed inside that window lose more, that could be **degraded fills
and stale quotes**, not "institutional volume dries up at lunch." These are different mechanisms
with different fixes (one is an infra problem, the other would be a real market-structure edge).
This program keeps them separate by registering one candidate window that overlaps the known
downtime and one that deliberately sits outside it (Config C below), and by checking each losing
trade inside Config A against `option_premium_ticks` coverage before attributing anything to
"chop."

## What gets measured

**Primary analysis — live trade history, no code change.** Every closed `AutoBot-Scalp1m`
`momentum-scalp` 1m trade to date, both instruments, entry timestamp (IST) bucketed against the
fixed windows below. This uses trades that already happened; it does not touch the live bot.

**Confirmatory analysis — backtest, default-off switch, still not touching production.** A new
`requireTradingWindow: "NONE" | "A" | "B" | "C"` switch on `momentum-scalp`, built the same way
`EmaStrengthFilteredStrategy` / `FreshSetupFilteredStrategy` were
(`backtesting/domain/entry-filters.ts`), run over historical 1m candles for both instruments. This
exists because the live sample is small (see Power, below) — the backtest trades the *same*
strategy logic over a much longer history, which is the only way to get enough clustered sessions
to say anything with a straight face. It ships default-off either way; nothing here changes what
the live bot does today.

## Windows, fixed now, before measurement (IST)

Three candidate configurations, chosen to separate mechanism, not to be searched over:

- **Config A — "lunch-block" (the originally proposed window).** Trading permitted 09:15–11:00 and
  13:30–15:15; blocked 11:00–13:30. This is the version in the original hypothesis. It **fully
  contains** the known 11:00–12:45 downtime, so a pass here is ambiguous between "chop" and "bad
  fills" until checked against tick coverage per the prerequisite above.
- **Config B — "narrow-lunch-block."** Blocked 11:30–13:00 only, permitted otherwise. Still
  overlaps the downtime window (11:30–12:45) but less completely than A.
- **Config C — "post-downtime-block."** Blocked 12:45–14:00 only, permitted otherwise. Chosen to
  sit entirely **outside** the known downtime window. If a real, non-infra midday effect exists,
  this is the config most likely to isolate it; if only A and B show an effect and C does not, the
  effect is downtime, not chop.

No other windows may be added or substituted after seeing a result. If all three miss, the verdict
is NO_EDGE for this program, not "try a fourth window."

## Unit of analysis

**The trade.** R is defined on the option's own premium risk:
`R = realized_pnl / (|entry_price − stop_loss| × quantity)`, i.e. the risk the strategy itself set,
consistent with how `realized_pnl` is already net of fees
([[paper-trade-pnl-convention-is-net]]). Standard errors are clustered by **session** (IST calendar
date), pooled across both instruments on the same day (a NIFTY50 and a BANKNIFTY trade on the same
day are not independent draws — same regime, same news, often the same broad tape).

Reported per config: trade count, session count, mean R, session-clustered SE, t = mean / SE.

## Decision rule

A config passes only by clearing **all four** gates. Failing any one is NO_EDGE for that config.

- **Gate 1 — sign replication.** Mean R inside the *permitted* window is positive on **both**
  NIFTY50 and BANKNIFTY independently, in the confirmatory backtest (the live sample is too thin to
  require this of on its own — see Power).
- **Gate 2 — noise floor.** Pooled session-clustered t > 2.0, Bonferroni-corrected for 3
  configurations (threshold computed and stated at execution time, once the exact trade/session
  counts are known — see the ICT program for the method).
- **Gate 3 — paired delta, done on the control's own trades.** Split the control (unfiltered)
  backtest population by whether each trade's entry falls inside vs. outside the candidate blocked
  window, same bars, no separate run. The permitted-window mean R must exceed the blocked-window
  mean R by more than either standard error. A config that only shrinks trade count without
  separating the two halves is ambiguous, not a pass — the same rule the chop-filter and ICT
  killzone tests already apply.
- **Gate 4 — infra-attribution check (specific to this program).** For every losing trade inside
  Config A or B's blocked window, look up `option_premium_ticks` coverage for the wanted contract at
  entry and exit. If a majority of the losing trades inside the blocked window sit on genuine quote
  gaps (per the D2 audit's own `NO_ENTRY_ASK_WITHIN_60S` / `NO_EXIT_BID_WITHIN_60S` classification),
  the result is attributed to infra, reported as such, and does **not** license a permanent
  time-of-day gate — the fix in that case is the collector, not the strategy.

## Power, stated honestly before running anything

`AutoBot-Scalp1m` has traded on exactly **6 sessions** to date (2026-09-04, 07, 08, 09, 10, 16 — note
the unexplained gap 09-11..09-15, not investigated here), 41 closed trades. That is not enough
clustered sessions to clear Gate 2 on the live sample alone; it is why the confirmatory backtest
over historical 1m candles is the primary source of statistical power, and the live sample is used
only as a sanity check that the backtest's answer matches what actually happened. If the backtest
itself cannot assemble at least ~20 clustered sessions per config after the blocked window removes
trades, the verdict is **INSUFFICIENT_POWER**, not NO_EDGE — those are different conclusions and
must not be conflated.

## Pre-committed threats to validity

- Configs A and B overlap the known collector downtime; Gate 4 exists specifically to keep
  "institutional chop" and "bad fills" from being reported as the same finding.
- Blocking any window shrinks the population, which is the exact failure mode that already killed
  the HTF-confluence veto and the scalp pattern gate. Gate 3 exists for exactly this.
- 1m momentum-scalp has no measured edge overall ([[scalp1m-adverse-signal-both-instruments]]). A
  time-of-day gate that merely turns a large loss into a smaller loss, without any window's mean R
  going positive, is not a pass under Gate 1 — do not report a reduced loss as a win.
- Two instruments is a thin replication set, same caveat the ICT program already recorded for
  itself.

## Amendment 1 — 2026-09-16, control run only, before any window config was measured

The control (`--entry-filter none`) backtest, 2026-08-01..09-15, 1m, both instruments, came back with
a far more extreme win rate than the live paper account shows: **NIFTY50 0/279 (0%), BANKNIFTY
5/313 (1.6%)**, against the live account's ~20-28% on the same strategy. This is recorded before
any config A/B/C result was looked at.

**Why, and why it does not invalidate the program.** `decidePaperTradeExit` correctly checks
intrabar high/low, not close-only, and resolves a candle that touches both levels as
`CONSERVATIVE_STOP_FIRST`. On 1m bars with a tight ATR-scaled 1.5R target, the stop and target sit
close enough together that a single volatile 1-minute bar frequently touches both, and the
conservative rule always awards the stop in that case. This is a real, structural property of
bar-level (not tick-level) settlement at 1m — the live/tick-replayed win rate in
[[stall-rule-on-1m-is-a-time-stop]] is measured against the observed premium tick series, which does
not have this same-bar ambiguity; this backtest, on 1m OHLC candles of the underlying, does.

**Consequence for this program specifically:** Gate 3 is a *paired* split of the *same* control
population by entry time, so a uniform same-bar-ambiguity bias affecting all times of day equally
does not by itself prevent detecting a real window effect — but it does mean the absolute win rates
and R figures below are not comparable to the live account's, only to each other across configs.
Gate 1 is read the same way: "positive" means positive on this backtest's own scale, not on the
live scale.

**New pre-committed threat to validity, added here rather than silently folded into the list
above:** if 1m intraday volatility itself has time-of-day structure (e.g. higher realized range
mid-session), the same-bar-ambiguity rate could itself vary by window, which would be a form of the
mechanism under test (chop) rather than a confound of it — this is not disentangled by this program
and is noted as an open question for any follow-up.

## Stopping condition

If no config clears all four gates, the verdict is recorded as **NO_VIABLE_TIME_WINDOW** and
`momentum-scalp` keeps trading all session hours on `AutoBot-Scalp1m`, unchanged. The
`requireTradingWindow` switch stays in the tree, default-off, with the measurement attached, so
nobody rebuilds it to re-learn the same thing.

## Results

Executed 2026-09-16, same day as registration, immediately after Amendment 1. Backtest:
`momentum-scalp@6`, 1m, both instruments, 2026-08-01..09-15, quantity 1, ₹20/order,
2bps slippage, `initial-capital` 1,000,000. `requireTradingWindow` built as
`TimeWindowFilteredStrategy` in `entry-filters.ts`, wired into `run-backtest.ts` as
`--entry-filter trading-window-a|b|c`; 19 unit tests added, `tsc --noEmit` clean.

**Aggregate, per config (both instruments):**

| config | NIFTY50 trades | NIFTY50 wins | NIFTY50 expectancy | BANKNIFTY trades | BANKNIFTY wins | BANKNIFTY expectancy |
|---|--:|--:|--:|--:|--:|--:|
| control (none) | 279 | 0 | -49.03 | 313 | 5 | -62.67 |
| A (11:00-13:30 blocked) | 184 | 0 | -48.74 | 207 | 5 | -61.64 |
| B (11:30-13:00 blocked) | 225 | 0 | -49.25 | 241 | 5 | -62.13 |
| C (12:45-14:00 blocked) | 235 | 0 | -48.53 | 267 | 5 | -62.47 |

The winning-trade count is identical across every config on each instrument (0 for NIFTY50, 5 for
BANKNIFTY) — none of the three candidate windows contains any of the population's real winners, so
blocking them only removes losers and near-losers roughly in proportion to how many trades each
window contains. Expectancy moves by under 2% of its own magnitude across all four arms on both
instruments.

**Gate 3, done on the control's own trades** (same method as the ICT program's "Gate 4, done
properly" — split by entry time, not by re-running):

| instrument | config | inside blocked: trades/sessions/mean/SE/t | outside (kept): trades/sessions/mean/SE/t | delta (kept − blocked) |
|---|---|---|---|--:|
| NIFTY50 | A | 95 / 17 / -48.15 / 1.42 / -33.8 | 184 / 20 / -48.06 / 1.49 / -32.3 | +0.09 |
| NIFTY50 | B | 55 / 16 / -48.20 / 1.39 / -34.7 | 224 / 20 / -47.75 / 1.03 / -46.3 | +0.45 |
| NIFTY50 | C | 44 / 8 / -50.43 / 1.74 / -29.0 | 235 / 20 / -46.70 / 1.03 / -45.4 | +3.74 |
| BANKNIFTY | A | 107 / 15 / -63.20 / 4.19 / -15.1 | 206 / 18 / -60.40 / 3.22 / -18.7 | +2.79 |
| BANKNIFTY | B | 73 / 13 / -61.31 / 5.00 / -12.3 | 240 / 18 / -60.70 / 2.98 / -20.4 | +0.62 |
| BANKNIFTY | C | 46 / 13 / -64.46 / 5.83 / -11.1 | 267 / 18 / -61.43 / 2.87 / -21.4 | +3.03 |

Every delta is small relative to either side's own SE — none approaches significance, let alone the
Bonferroni-corrected bar for 3 configs. (The very large |t| values on each *side* are not evidence
for the window — they say the strategy loses on nearly every trade almost everywhere, per
Amendment 1's same-bar-ambiguity explanation, not that any subpopulation is distinguishable from
another.)

**Live-sample sanity check** (Config A split, `AutoBot-Scalp1m`, all 41 trades to date, for
consistency only — underpowered per the Power section above, not a gate): inside the blocked window,
8 trades, mean realized P&L -183.62; outside (kept), 33 trades, mean -255.80. The kept population is
numerically *worse* here, the opposite direction from the hypothesis — with n=8 this is pure noise,
but it does not contradict the backtest's null finding, and does not rescue it either.

### Verdict

**NO_VIABLE_TIME_WINDOW.**

- Gate 1 (sign replication) — failed by every config on both instruments. No arm's kept population
  is ever positive; all four (including control) are deeply negative with very tight SE, per
  Amendment 1.
- Gate 2 (noise floor on the delta) — moot. No delta comes remotely close to raw significance, so
  the Bonferroni correction for 3 configs changes nothing.
- Gate 3 (paired delta on the control's own trades) — failed. Deltas of +0.09 to +3.74 against SEs
  of 1.0-5.8; the kept population is never meaningfully better than the blocked one.
- Gate 4 (infra-attribution check) — not reached. There is no "blocked window is worse" finding to
  attribute to the known collector downtime; the windows are indistinguishable from each other, so
  there is nothing here for the downtime to explain either.

`momentum-scalp` keeps trading all session hours on `AutoBot-Scalp1m`, unchanged. This adds a fifth
entry/timing-side lever to the list that did not help this bot, alongside pattern gating, the chop
filters, signal inversion, and the 1m stall extension — see [[scalp1m-adverse-signal-both-instruments]].
The `requireTradingWindow` switch stays in the tree, default-off, with this measurement attached.
