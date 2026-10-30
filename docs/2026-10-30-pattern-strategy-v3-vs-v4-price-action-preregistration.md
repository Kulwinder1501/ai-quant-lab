# Pre-registration: does `price-action-v4` improve the pattern strategy AutoBot-Sniper ran?

Written 2026-10-30, before any v4 rows were generated for the test window and before any result of it was seen.

## Why this exists

`AutoBot-Sniper` was decommissioned on 2026-10-28 after an autopsy of its 276 closed trades (-Rs 64,152.93 net, 35.1% win rate, Rs 24,809.68 of it transaction costs). The operator asked whether `price-action-v4` (the corrected support/resistance and trend/breakout rules, running beside v3 since 2026-10-29) would have given it better results, and asked to make v4 the version the bots read.

Two facts found first, which bound what this test can say:

1. **No live bot reads the current price-action version.** `AutoBot-Scalp1m` (`momentum-scalp`) and the gold scalps pin the literal `"price-action-v2"`, which stopped being written on 2026-10-09; the two ICT bots read ICT snapshots. The only strategies that follow the current version are Sniper's (`momentum-scalp-pattern`, `momentum-scalp-pattern-v2`), now unowned. Switching "for the bots" would change shadow-decision logs and research, not trading.
2. **v4 can change at most four of the strategy's nine score points** (nearness to a support/resistance level, +2; chart-pattern confluence, +2). Trend, VWAP, candlestick and volume points are untouched, and so is the whole option-execution layer, where most of Sniper's loss came from.

So this test measures **signal quality on the underlying**, not Sniper's option P&L. A positive result would not by itself make a Sniper-like bot profitable.

## Design

- **Strategy:** `momentum-scalp-pattern`, the registered version, default configuration (`scoreThreshold 5`, `atrStopMultiple 1.0`, `rewardRiskMultiple 1.5`).
- **Arm A (v3):** the registered configuration, reading `price-action-v3`.
- **Arm B (v4):** identical, with `--strategy-config '{"priceActionAlgorithmVersion":"price-action-v4"}'`. This is the only difference. Both arms read the same candles, indicators and candlestick-v2 patterns; the backtest loader reads v4 only when a run pins it (see the loader change in the same commit series), and no other reader is changed.
- **Series:** NIFTY50 5m and BANKNIFTY 5m, the two series Sniper traded in the v3 regime (31 and 19 of its 55 trades; 5 more were BANKNIFTY 1m, excluded).
- **Window:** every session from 2026-01-01 to 2026-10-30 (about 205 per index). Coverage was checked before this was written: v3 support/resistance and candlestick-v2 rows exist on every session except one in September.
- **Execution model:** the backtester's defaults and nothing else: next eligible candle open, fixed quantity 1, zero fee, zero slippage, one position at a time. Costs are left out on purpose; this asks whether the signals differ in quality, and Sniper's costs would apply equally to both arms.
- **v4 rows:** produced by `analysis:detect-patterns --engine v4` for 5m on both indices from 2026-01-01 before the runs (the CLI has no end bound, so it also re-writes 2026-10-26 onward, which the scheduled job already wrote; the upsert makes that a no-op). They are experimental rows excluded from every live reader. Their per-session counts are checked against v3's before any backtest runs.

## Metric and decision rule (fixed now)

Unit: one backtest trade, identified by its entry time, assigned to the IST session of its entry. Metric: `backtest_trades.return_pct` (underlying return, so the two indices pool). Pooled across both indices, A and B are compared by **mean return per trade, B minus A**, with a 95% interval from resampling sessions with replacement 10,000 times (seed 20261030).

- **"v4 helps"** only if all three hold: (1) the 95% interval for B minus A lies entirely above zero; (2) B minus A is positive in each index taken alone; (3) B takes between 70% and 130% of A's number of trades (outside that it is a different strategy, not a better filter).
- **"v4 hurts"** if the interval lies entirely below zero and the point estimate is negative in both indices.
- **Otherwise: no demonstrated difference.** That includes a positive point estimate with an interval that crosses zero; it is not reported as "slightly better".

Nothing about v4, the strategy, the window or these thresholds will be changed after the runs. Any further analysis is labelled exploratory.

## Reported alongside, not decisive

Trades only in A, only in B and in both; win rate and exit-reason mix per arm; per-index results; the result with 2026-10-26 to 2026-10-30 excluded (see below); Sniper's live window 2026-10-12 to 2026-10-28 on its own; the width of the interval, so the reader can see what size of difference could have been detected.

## Known limits, stated before the result

- **v4 was designed after looking at v3 on NIFTY 5m of 2026-10-29.** That session and the days around it are in the window, which flatters v4 slightly. The run excluding 2026-10-26 to 2026-10-30 is reported for that reason.
- **One position at a time** means the arms' trade sets interact: a signal taken in one arm may be skipped in the other because a position was open. The "only in A / only in B" split therefore overstates how many signals truly differ.
- **The backtester trades the underlying, not options.** Sniper's real results include option premium, spread and a time-stop pattern the backtester does not model.
- **A and B both use rows backfilled after the fact** for dates before 2026-10-10 (v3's were; v4's will be). They are written with the same point-in-time rule (`known_at` is the closing time of the confirming candle) and the strategy reads only rows known at the cutoff, so neither arm sees the future, but neither is a record of what was live.
- **Smoke run disclosed:** one arm-A run on NIFTY50 5m for 2026-10-26 to 2026-10-27 was made only to learn the command and the output format. Its numbers were not looked at and are not used.

## Commands

```
npm run analysis:detect-patterns -- --instrument <NIFTY50|BANKNIFTY> --timeframe 5m --from 2026-01-01 --engine v4
npm run backtest:run -- --strategy momentum-scalp-pattern --instrument <NIFTY50|BANKNIFTY> --timeframe 5m --from 2026-01-01 --to 2026-10-30
npm run backtest:run -- --strategy momentum-scalp-pattern --instrument <NIFTY50|BANKNIFTY> --timeframe 5m --from 2026-01-01 --to 2026-10-30 --strategy-config '{"priceActionAlgorithmVersion":"price-action-v4"}'
```
