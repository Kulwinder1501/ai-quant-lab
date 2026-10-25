# Forward test of the reversed-sign gamma-exposure (GEX) signal on NIFTY50: pre-registered (DRAFT until committed)

Status: written 2026-10-25, before any option-chain snapshot from 2026-10-26 onward has been looked at (the stored snapshots end on 2026-10-23). It binds when committed. The script `docs/research-scripts/2026-10-25-gex-forward-rerun.py` is frozen with it.

## Where this comes from, and why it must be tested forward

On 2026-10-24 and -25, 49 days of NIFTY50 snapshots (2026-08-05 to 2026-10-23) were tested for whether gamma exposure says anything about the next move. The textbook reading (price keeps going when gamma is negative and snaps back when it is positive) came out **backwards** on NIFTY50 at 60 minutes: signed that way the mean was −3.14 bp (day-bootstrap interval −5.16 to −0.86, shifted-signal placebo p = 0.003). Read the other way round it is **+3.14 bp**: after a positive reading the previous hour's move continued (+3.05 bp, 519 snapshots), after a negative one it reversed (−3.34 bp, 225 snapshots).

That is a hypothesis found in the same data, and it is weaker than it looks:
- It is one of 12 looks (2 indices × 2 signals × 3 horizons). The adjusted p for the four-test family at 30 minutes was 0.19 for NIFTY50 GEX; the 60-minute result was not in that family.
- The two halves of the days are very uneven: +0.76 bp and +4.98 bp.
- BANKNIFTY showed nothing in the same direction (−1.85 bp at 60 minutes; day-bootstrap p = 0.16, shifted-signal placebo p = 0.13).
- A 49-day estimate that was picked as the best of 12 is expected to shrink.

So the only honest next step is a pre-declared test on data that did not exist when the hypothesis was formed.

## What "GEX" means here

`GEX = Σ over strikes of (call open interest − put open interest) × gamma × S² × 0.01`, with gamma from Black-Scholes at each contract's own solved implied volatility (risk-free rate 6.5%, the out-of-the-money side prices each strike). Calls count positive and puts negative **by convention**. Open interest does not say who holds a contract, so this is not dealer positioning and nothing is inferred about dealers. The test is only about the sign of this number.

## Hypothesis (fixed direction and horizon)

On NIFTY50, over the next **60 minutes**, the move of the previous 60 minutes **continues when GEX is positive and reverses when GEX is negative**. The signal return for a snapshot is `sign(GEX) × sign(move of the previous 60 minutes) × (index return over the next 60 minutes)`, in basis points. The textbook direction, other horizons, BANKNIFTY, and the open-interest-imbalance signal are **not** tested here.

## Data and rules (identical to the in-sample analysis)

- Snapshots of NIFTY50 from `option_chain_snapshots` (one expiry per snapshot) observed between 09:35 and 14:45 IST, with at least 10 strikes that solve; snapshots within about 4 hours of expiry (T ≤ 0.0005 year) are skipped.
- The index level at the snapshot, 60 minutes earlier and 60 minutes later comes from the 1-minute closes (a bar must be within 3 minutes of the time). Snapshots whose previous 60-minute move is exactly zero are dropped.
- Round-trip cost is 1.9 index points at each snapshot's level (about 0.81 bp).

Exports (save as CSV, then `python -I -W ignore <script> chain.csv m1.csv`):

```sql
select underlying_symbol u, observed_at, expiry_date, strike_price k, option_type ty, bid, ask, last_price,
       open_interest oi, underlying_value s
from option_chain_snapshots
where underlying_symbol = 'NIFTY50' and observed_at >= '2026-10-26 00:00:00+05:30'
order by observed_at, strike_price, option_type;

select i.symbol, c.close_time, c.close
from candles c join instruments i on i.id = c.instrument_id
where i.symbol = 'NIFTY50' and c.timeframe = '1m' and c.close_time >= '2026-10-25 00:00:00+05:30'
order by c.close_time;
```

## One look, at 100 trading days

The test is evaluated **once**, on the **first 100 trading days from 2026-10-26 that have usable snapshots**, about 20 weeks later (mid to late March 2027). Between now and then the only things looked at are data-quality counts (snapshots and usable days per week), never the signal. If fewer than 85 usable days exist, the result is "not assessable" and the look waits for more days. Later days are reported descriptively and cannot change the verdict.

## Pass rule (all four must hold)

1. Mean signal return above zero with the lower end of the **day-clustered bootstrap 95% interval** (4,000 draws, resampling days) above zero.
2. **Shifted-signal placebo** (600 circular shifts of the GEX sign series against the unshifted price path, each by at least 30 snapshots): one-sided p < 0.05.
3. The mean is **larger than the round-trip cost** (about 0.81 bp).
4. **Both halves of the days** (first 50 and last 50) have a positive mean.

## Power (stated now)

The in-sample standard error was about 1.1 bp on 49 days. With 100 days it should be about 0.8 bp, so an effect of about 2.2 bp or more can be separated from noise (80% power). If the true effect is half the in-sample value (about 1.6 bp), the chance of passing is roughly one in two. A failure therefore means "not confirmed", not "shown to be absent".

## What each outcome does

- **Pass:** the reversed-sign pattern is recorded as confirmed on 100 forward days for NIFTY50 at 60 minutes. It is a statistical regularity of the index, not a strategy: option execution costs are far larger than 0.81 bp (one volatility point is worth roughly 117 index points on an at-the-money option), so a pass would justify an option-quote replay and a paper test, never a trade.
- **Fail or not assessable:** the signal is dropped. No re-tuning of horizon, window, sign or convention on these days. A different form is a new pre-registration.

## Known limits

- Snapshots arrive every 12–18 minutes, so 60-minute windows overlap heavily and consecutive snapshots are not independent; the day-clustered bootstrap handles this, the shifted-signal placebo handles it only partly.
- Open interest changes through the day only slowly and is partly previous-day; gamma changes quickly with the index. The sign can flip between nearby snapshots.
- One broker's chain, one underlying, one regime (the in-sample months).
- The collector must keep running; any long gap lowers the usable-day count.
- This is a test of a market regularity, not a trading recommendation; any live use needs the usual human review.
