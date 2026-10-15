# ICT daily-bias variants: does a faster daily bias help `ict-structure-v1`? (pre-registered 2026-10-15)

Written and committed **before any variant result was produced.** Nothing here changes a live bot; the question is whether it should.

## Question

`ict-structure-v1` trades only with the **daily** bias, and the daily bias is the daily swing structure's trend. On 2026-10-15 it was BEARISH on both indices through a 4% BANKNIFTY and 2% NIFTY bounce, and the strategy sat out the move. The bias flips only on a daily close above the last confirmed lower high (BANKNIFTY 58,025 from 31 Aug, NIFTY 23,489 from 22 Sep). A trader reading the same chart says a demand-zone bounce followed by a structure shift is already a bullish bias. Would giving the strategy that faster bias have made it better, or only busier?

## The one thing that changes

Only the **daily bias series** fed to the engine. Everything else is identical between arms: the strategy and its configuration, the execution timeframe, the engine config, the costs, the sizing, the window and the data. The variants are implemented as an override of the base daily bias, so where they do not fire the series equals the control's.

| Arm | Daily bias |
|---|---|
| `CONTROL` (`own-structure`) | what ships today |
| `A` (`internal-choch`) | the base bias, unless the daily close breaks the latest confirmed daily swing point against it: a close above the latest swing high flips a BEARISH bias to BULLISH, a close below the latest swing low flips a BULLISH bias to BEARISH |
| `B` (`zone-tap-choch`) | as A, but a flip requires the swing point that was just left to have tapped an order block of the matching kind: a BULLISH flip needs the latest swing low inside an active bullish order block (low <= top and low >= bottom - 0.5 daily ATR); a BEARISH flip mirrors it on the latest swing high and a bearish block |

Rules shared by A and B: daily swing points are confirmed pivots with length 3 (the engine's own default); the flip is evaluated at each completed daily close, so it is causal; once flipped, the override holds until the opposite flip, or until the base bias itself changes direction, when the engine's own bias is used again. Both directions are symmetric: the change is not a long-only one.

B is the user's wording ("CHoCH after a demand-zone tap"); A is B without the zone condition, so any difference between them is the zone's contribution.

## Cells and windows (fixed now)

Primary, the two live bots:

| Cell | Window |
|---|---|
| NIFTY50 15m | 2023-01-02 to 2026-10-14 (all history) |
| BANKNIFTY 5m | 2026-01-01 to 2026-10-14 (all history; only ~9.5 months exist) |

Secondary, only to add trades and to see whether a result is one cell's accident; **never** used to rescue a failed primary:

| Cell | Window |
|---|---|
| BANKNIFTY 15m | 2023-01-02 to 2026-10-14 |
| NIFTY50 5m | 2024-01-01 to 2026-10-14 |

The daily bias inside a run is built from the run's own window, as in every earlier ICT backtest, so the first weeks of each window carry no bias and place no trades.

Execution: 2 bps slippage per side and up to 5 concurrent positions, the settings the closing note in `strategy-registry.ts` quotes for the earlier ICT numbers. **No fee is charged**, so every figure is gross of commissions and option costs and overstates any live result; the comparison between arms is still like for like.

## Measures

Per arm and cell: closed trades, net P&L, profit factor, win rate, and P&L in each calendar half of the window.

## Decision rule (before seeing results)

A variant is **worth taking forward to a live paper observation** only if **all** hold:

1. On **both** primary cells, net P&L is higher than control **and** the variant's profit factor is above 1.
2. On each primary cell, the improvement appears in **both halves** of the window (split by date at the window's midpoint), not in one.
3. The variant did not simply add trades: its **extra** trades (those the control did not take) have a positive total P&L on each primary cell.

Anything else is reported as **no evidence the variant helps**, and the rule stays as it is. A variant that fails on one primary cell and wins on a secondary one is a failure.

## What this cannot show

- The control itself is not a validated strategy: its earlier 20-month result was sign-unstable across cells and windows. Beating it is a weak bar.
- BANKNIFTY 5m has about 9.5 months and the strategy takes roughly 5-6 trades a month per cell, so that cell will have tens of trades at most. A null there is mostly low power, not evidence of no effect.
- Two variants on two primary cells is four comparisons; with so few trades a single favourable cell is not significant. This is why the rule needs every condition, rather than one p-value.
- The backtest prices the underlying index, not the options the bots actually buy.
- Even a pass is a hypothesis for forward paper trading, not a reason to change a live rule.
