# Gold–DXY residual: pre-registered test (DRAFT, not yet frozen)

Status: draft written 2026-10-25. Nothing below has been run. It becomes binding when it is committed, and no result is looked at before that.

## Hypothesis (one sentence)

When gold's last 30 minutes of movement are much larger or smaller than the dollar (DXY) explains, gold gives part of that residual back over the following 30 minutes.

The direction is fixed in advance: **fade the residual**. The opposite direction (continuation) is not a test here; a significant continuation result would be reported as a surprise, not as a confirmed finding.

## Data (read-only)

- `candles`, timeframe `5m`, instruments `XAU_USD` and `DXY` (synthetic from six OANDA FX legs), 2020-01-01 to 2026-10-23.
- Only bars whose `open_time` exists in both series are used. A bar that follows a missing bar is not used as a return.
- Measured 2026-10-25: 410,641 matched bars, all `is_complete`. DXY is thinner in 2020 (45,715 bars) and 2021 (40,613) than later years (about 67,000), so those two years are reported separately.

## Indicator

For each matched bar `t`, with log returns `rg` (gold) and `rd` (DXY):

1. `beta(t)` = OLS slope of `rg` on `rd` over the **previous** 1,440 matched bars (about five trading days), ending at `t-1`. No bar from `t` onward enters the estimate.
2. Bar residual `e = rg - beta(t) * rd`.
3. `E(t)` = sum of `e` over bars `t-5 … t` (six bars, 30 minutes).
4. `z(t) = E(t) / (s * sqrt(6))`, where `s` is the standard deviation of single-bar `e` over the same previous 1,440 bars.

## Signal and trade

- Fires at the close of bar `t` when `|z| >= 2.0`.
- Direction: short when `z > 0`, long when `z < 0` (fade).
- Entry: open of bar `t+1`. Exit: close of bar `t+6` (30-minute hold). No stop or target.
- One position at a time: after a signal, bars `t+1 … t+6` cannot start another.
- Entry window: 03:30–15:30 UTC (the gold bot's 09:00–21:00 IST), Monday–Friday. Signals within 30 minutes after the Sunday open or 30 minutes before the daily break are dropped.
- Return per trade is in basis points of the entry price, signed by direction.

## Cost

Round-trip cost is a fixed **$0.40 per ounce** (assumed OANDA spread; the repository holds no gold cost model, so this must be checked against real fills before any claim). It is converted to basis points at each trade's price. The report also gives the break-even cost: the round-trip cost at which the mean net return is zero.

## Primary test

Mean gross return per trade at the 30-minute horizon, all years pooled.

- Uncertainty: day-clustered bootstrap (resample trading days, 4,000 draws), 95% interval.
- Placebo: circular shifts of the signal series (600 shifts, each at least one trading day); p is the share of shifted means at least as extreme as the observed mean.
- Passes only if **all** hold: gross mean > 0 with the bootstrap interval excluding zero; placebo p < 0.05; net mean after cost > 0.

## Secondary checks (stated now, cannot rescue a failed primary)

- Horizons 3 bars (15 minutes) and 12 bars (60 minutes), Holm-adjusted together with the primary.
- Split-half stability: the sign must agree in 2020–2023 and 2024–2026.
- Year-by-year signs (reported, no pass/fail).
- Threshold 1.5 and 2.5 (sensitivity only).
- Trade count and trading days; the minimum for any claim is 300 trades on 150 days.

## What would count as failure

Any primary condition not met. A failure is recorded as "no edge from this form of the indicator" and the indicator is not re-tuned (window, threshold, horizon) on the same data to find one that works. A different form needs a new pre-registration.

## Known limits

- The beta window is fixed at about five days; a different window is a different test.
- DXY is derived from the same broker's FX legs, so the two series share timestamps and feed quality. Feed gaps can create fake residuals; the matched-bar rule limits but does not remove this.
- This tests a statistical relationship on one gold venue's price. It is not a trading recommendation, and any live use needs the usual human review and the cost check above.
