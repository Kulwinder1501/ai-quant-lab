# Results: `price-action-v4` against v3 on the pattern strategy AutoBot-Sniper ran

Run 2026-10-30 under `docs/2026-10-30-pattern-strategy-v3-vs-v4-price-action-preregistration.md` (commit `bddf6ffe`), unchanged. Analysis script: `sniper_v4_analysis.mts` (session scratchpad), seed 20261030.

## Verdict, as pre-registered: **no demonstrated difference**

| | A (v3) | B (v4) |
|---|---|---|
| Trades, pooled | 3,362 | 3,359 |
| Mean return per trade | 0.0059% | 0.0059% |
| Win rate | 41.0% | 41.1% |
| NIFTY50 trades / mean return | 1,692 / 0.0110% | 1,692 / 0.0114% |
| BANKNIFTY trades / mean return | 1,670 / 0.0007% | 1,667 / 0.0004% |

Primary: B minus A, pooled, **0.0000** percentage points per trade, 95% session-bootstrap interval **[-0.0006, +0.0007]** over 200 sessions. NIFTY50 +0.0004 [-0.0002, +0.0011]; BANKNIFTY -0.0003 [-0.0014, +0.0006]. Rule: interval above zero false; positive in each index false; trade ratio 1.00 within 0.70 to 1.30 true. Not "helps", not "hurts".

## What the numbers say beyond the verdict

1. **v4 hardly changes this strategy.** 3,334 of 3,362 trades (99.2%) are in both arms with identical outcomes. Only 28 trades exist only in A and 25 only in B (0.8% each). Signals: NIFTY50 3,706 vs 3,690, BANKNIFTY 3,829 vs 3,820. The test is not "inconclusive for lack of power": there is almost nothing for v4 to move, because a +2 score point only matters when a signal sits on the threshold.
2. **The base strategy is roughly break-even before any cost.** 41% wins at a 1.5 reward-to-risk with zero fee and zero slippage is about +0.03R per trade, 5,096 index points over 3,362 trades (about 1.5 points a trade). Sniper's real losses (Rs 24,809.68 of costs in a Rs 64,152.93 loss, 276 trades) are consistent with a signal that has almost no margin to pay costs; nothing in v3 versus v4 touches that.
3. **Sniper's own live window** (2026-10-12 to 2026-10-28), descriptive: A 206 trades, -0.0134% per trade, 38.3% wins; B 207 trades, -0.0110%, 39.1%. Both negative, the gap far inside the noise.
4. **Excluding 2026-10-26 to 2026-10-30** (the days v4 was designed on): B minus A 0.0000 [-0.0006, +0.0007], the same.
5. Exit mix is identical: 59% stop, 41% target in both arms.

## Limits (as declared before the run)

Underlying-index signal quality, not option P&L; one position at a time, so the arms' trade sets interact; both arms read rows backfilled for dates before 2026-10-10; zero costs. The question "does v4 change signal quality for this strategy" is answered: not measurably. The question "would v4 have saved Sniper" is answered by point 2: no, and no change in S/R could have.

## Side effects of running it

- v4 rows were generated for 5m NIFTY50 and BANKNIFTY from 2026-01-01 (10,307 and 10,425 events written). They are experimental rows no live reader can see. The same CLI also re-wrote the candlestick-v2 detections for those series (upserts of the same engine's output).
- Backtest runs stored in `backtest_runs` / `backtest_trades`: one smoke run (NIFTY50 5m, 2026-10-26 to 2026-10-27, format check only, not used) and the four runs above.
- Per-session v3 and v4 level coverage was checked equal before the runs (every session has both; v4 emits about 13% fewer support/resistance rows because of its retest rule).
