# Implied-move exhaustion on NIFTY50: pre-registered test (DRAFT until committed)

Status: written 2026-10-25, before any result was computed. It binds when committed.

## Question

By 11:00 IST, how much of the day's *implied* move has NIFTY50 already used? Does that tell us anything about the rest of the session: (H1) how big the remaining move is, and (H2) which way it goes?

## Why VIX instead of the option chain

`option_chain_snapshots` covers only about 55 trading days (2026-08-04 onward), too few for any conclusion. India VIX daily closes exist from 2023 and NIFTY50 1m bars for 200 full sessions of 2026, so the implied move is taken from VIX. This is the NIFTY-wide implied volatility, so the test is NIFTY50 only. BANKNIFTY needs its own pre-registration.

## Data (read-only)

- `candles` 1m `NIFTY50`: sessions of 2026 with at least 360 one-minute bars (200 days at time of writing). The Jan-2024 days are not used (22 days, a separate regime).
- `candles` 1d `INDIAVIX` close, `NIFTY50` 1d close, both from the previous trading day. A day is dropped if the previous trading day's VIX or index close is missing.
- A day is also dropped if the bar opening 10:59 IST or the bar opening 15:14 IST is missing, or if the 11:00 bar is missing.
- Unit check only (no outcomes): VIX closes should be in percent (roughly 9–30). If not, stop and report.

## Variables

For session day `d` (IST), with `C` = previous session's close and `V` = previous session's VIX close:

- `sigma = C * (V/100) / sqrt(252)`: the implied one-day move in index points. (VIX is annualised on calendar time; dividing by sqrt(252) gives the per-trading-day figure.)
- `S11` = close of the 10:59 bar. `R = |S11 - C| / sigma`: share of the implied move already used at 11:00.
- `E` (entry) = open of the 11:00 bar. `X` = close of the 15:14 bar (15:15 flatten).
- `Rem = (max high - min low over bars 11:00 … 15:14) / sigma`: remaining range, in implied-move units.
- `Morn = (max high - min low over bars 09:15 … 10:59) / sigma`: morning range (control).
- `dir = sign(S11 - C)`; the fade return is `-dir * (X/E - 1) * 1e4` (basis points).

## Hypotheses (fixed direction)

- **H1 (size):** days with `R >= 0.7` have a *smaller* remaining range than other days. Test: mean `Rem` for `R >= 0.7` minus mean `Rem` for `R < 0.7`, one-sided (negative). Day-bootstrap 95% interval (4,000 draws) and a label-permutation p (5,000 shuffles of which days are "high R"). All 200 days are used.
- **H2 (direction):** on days with `R >= 0.7`, the market gives part of the morning move back, so the fade return is positive. Test: mean fade return in bps, day-bootstrap 95% interval, permutation p (5,000 random draws of the same number of days from all days, each with its own `dir`), one-sided (positive).
- Holm correction across H1 and H2.

## Pass rules

- H1 passes if the bootstrap interval of the difference excludes zero on the negative side and the Holm-adjusted permutation p < 0.05.
- H2 passes if the bootstrap interval of the mean fade return excludes zero on the positive side, the Holm-adjusted permutation p < 0.05, **and** the mean is positive after a cost of 1.9 index points round trip (about 0.8 bp). Costs of trading this through options are much higher (a one-point change in implied volatility is worth roughly 117 index points on an ATM option), so passing H2 would only justify a further option-quote replay, never a trade.
- H2 needs at least 40 eligible days to be assessed; with fewer it is reported as "not assessable", not as a failure.

## Checks that cannot rescue a failure

- Threshold 0.5 and 1.0 for `R`; checkpoint 12:30 instead of 11:00 (sensitivity only).
- H1 control: Spearman correlation between `R` and `Rem` after removing the effect of `Morn` (partial rank correlation). Volatility clusters, so a raw positive link between morning and afternoon is expected and is not evidence of exhaustion.
- Expiry-day split (NIFTY weekly expiry days against others), reported only.
- Descriptive only: Sniper's closed trades entered after 11:00, split by `R` at entry, with counts and mean P&L. No gate claim is made from this.

## Power (stated now)

With about 200 days the test can only detect large effects: a mean fade return difference below roughly 10 bps (all days) or 18 bps (the eligible subset, about 50 days) is not distinguishable from noise. A pass is therefore unlikely and a failure means "no large effect", not "no effect". This is why an inconclusive result is reported as such.

## Failure handling

A failure is recorded and not re-tuned (threshold, checkpoint, window) on the same data. A different definition needs a new pre-registration. Re-run when 200 more days exist.

## Known limits

- VIX is the NIFTY 30-day implied volatility, not the one-day implied move; it understates the move on expiry day and overstates it after events.
- One year of intraday history, one regime.
- This is a statistical test of the market. It is not a trading recommendation, and any live use needs the usual human review.
