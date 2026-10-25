# Gold compression → breakout: pre-registered test (DRAFT until committed)

Status: written 2026-10-25, before any result was computed. It binds when committed.

## Question

Volatility expansion is the one signal that has survived earlier tests here. It says *size*, not *direction*. So the tradable question is: after gold has been unusually quiet for an hour, does the first break out of that quiet range keep going, by more than the cost of trading it?

## Own indicator: compression score

For each 5m bar `t` of `XAU_USD` (12 consecutive bars `t-11 … t`, no gaps):

- `range12(t) = (max high - min low over the 12 bars) / close(t)`: relative range of the last hour.
- `CS(t)` = percentile rank of `range12(t)` among the values of `range12` at the **same 5-minute slot of the day** on the previous 60 sessions (at least 40 valid). Low `CS` = unusually quiet *for that time of day*. Comparing like with like at the same clock time stops the test from rediscovering that the Asian session is quiet.
- The box is `[min low, max high]` of those 12 bars.

## Signal and trade

- Signal: `CS(t) <= 0.10` at the close of bar `t`.
- Entry: a stop-entry order in the 12 bars after `t` (`t+1 … t+12`): the first bar that trades above the box high goes long at the box high (or at the bar's open if it opens above), the first that trades below the box low goes short at the box low (or open if it opens below). If one bar trades through both sides, the signal is skipped (ambiguous). If neither side breaks in 12 bars, no trade.
- Exit: close of the 12th bar after the entry bar. **No stop and no target**; a stop is a separate design and needs its own pre-registration.
- The entry bar must fall in 03:30–15:30 UTC (the gold bot's 09:00–21:00 IST), Monday–Friday, and the 13 bars from the entry bar must be consecutive.
- One position at a time: signals are ignored from the signal bar until the trade exits or the 12-bar entry window ends without a break.
- Return per trade in basis points of the entry price, signed by direction.

## Cost

$0.60 per ounce round trip: $0.40 assumed spread plus $0.20 assumed slippage on a stop-entry fill. Both are assumptions (the repository has no gold cost model) and must be checked against real fills before any claim. The break-even cost is reported.

## Primary test

Mean gross return per trade (before cost), all years pooled. Trades are expected in the thousands.

- Day-clustered bootstrap, 4,000 draws, 95% interval, one cluster per entry day.
- Placebo: circular shifts of the compression flag (600 shifts of at least 300 bars) against the unshifted price path, rerunning the same entry rules.
- **Passes only if all hold:** gross mean > 0 with the interval excluding zero; placebo p < 0.05; mean after the $0.60 cost > 0; at least 300 trades on 150 days.

## Checks that cannot rescue a failure

- Manipulation check (reported, not pass/fail): after a signal, is the absolute move over the next 24 bars larger than after a non-signal bar? This is the known "compression is followed by expansion" result.
- **Generic-breakout control:** the same entry and exit rules applied to boxes with `0.40 <= CS <= 0.60`. A positive primary only means something about *compression* if it beats this.
- Split halves (2020–2023, 2024–2026) and year-by-year means; the sign must agree across halves.
- Thresholds `CS <= 0.05` and `<= 0.20`; hold of 6 and 24 bars (sensitivity only).
- Long versus short, and entry hour block (03:30–07:00 UTC against 07:00–15:30 UTC), reported only.

## Failure handling

A failure is recorded as "no edge from this form of the indicator". Window, threshold, percentile baseline or hold are not re-tuned on this data. A different form needs a new pre-registration. A pass would only justify a stop/target design and a forward paper test, never live use.

## Known limits

- Stop-entry fills at the box edge are optimistic in fast markets; the $0.20 slippage is a guess.
- Signals cluster on quiet days, so trades are not independent; the day-clustered bootstrap handles this, not removes it.
- Gold only; one broker's feed; the 2020–2021 history is thinner for the DXY pair but this test does not use DXY.
- A statistical test of the market, not a trading recommendation; any live use needs the usual human review.
