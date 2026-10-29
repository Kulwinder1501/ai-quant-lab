# Gold liquidity map (session, day, week levels): pre-registered sweep test (DRAFT until committed)

Status: written 2026-10-29, before any sweep event was counted and before any outcome was computed. It binds when committed.

What was read before writing: the table layout and coverage of `XAU_USD` 5m bars, the code's own session conventions, and the size of an ordinary one-hour move (not conditioned on any event). Nothing about how price behaves after a sweep was looked at.

## Question

Stops are assumed to rest just beyond obvious levels: the Asian session high and low, the previous day's high and low, the previous week's high and low. When gold trades a short distance beyond one of them and closes back inside, does it keep moving back by more than the cost of trading it? And does it matter when several levels are swept by the same bar?

This is a test of the market, not of a bot. A bot is only worth designing if this passes.

## Levels (all known before the bar that tests them; `XAU_USD`, 5m, completed bars only)

- **A, Asian**: high and low of bars opening 00:00 up to but not including 06:00 UTC (the window `gold-asian-sweep-v1` uses). Live from 06:00 UTC to the end of that UTC date.
- **D, prior day**: high and low of the previous trading session. Sessions are the code's gold convention (`XAUUSD_OANDA_PROFILE`: the day rolls at 18:00 New York time, DST-aware). Live for the whole following session.
- **W, prior week**: high and low of the previous ISO week, grouped by that same session date. Live for the whole current week.

Not included in this version: equal highs/lows, swing-point levels, monthly levels, volume-profile levels, order-book levels.

## Sweep event

For a **high** level `L` and 5m bar `t` (symmetric for a low):

- The level is **consumed** at the first bar whose high is at least `L × (1 + 3 bps)`, whether or not that bar becomes an event. A consumed level is never used again. Consumption does not depend on the entry window below.
- That bar is a **sweep event** only if all hold: penetration `(high − L) / L` is at most 50 bps, **and** the bar closes back inside (`close < L` for a high, `close > L` for a low).
- A bar that penetrates more than 50 bps, or closes beyond the level, is a breakout. The level is consumed and there is no event.
- 3 bps and 50 bps are inherited from the live Asian sweep configuration, not chosen here. There is no wick-ratio filter.
- **Stack** = the number of distinct live levels on the same side that this one bar sweeps under these rules. A bar that sweeps a high and a low level at once is skipped as ambiguous.

## Trade

- Direction: **fade the sweep**. A high sweep is a short, a low sweep is a long.
- Entry: the open of bar `t+1`. Exit: the close of bar `t+12`. **No stop and no target**; a stop is a separate design and needs its own pre-registration.
- The sweep bar must open between 03:30 and 15:25 UTC, Monday to Friday (the gold bot's 09:00–21:00 IST window, minus the last bar). Bars `t` to `t+12` must be consecutive, with no gaps.
- One position at a time: events are ignored while a trade is open.
- Return per trade in basis points of the entry price, signed by direction.

## Cost

$0.60 per ounce round trip: $0.40 assumed spread plus $0.20 assumed slippage. Same figure as the two earlier gold tests, so results are comparable. **Both parts are assumptions: the stored candles have no bid or ask and the repository has no gold cost model.** The cost is applied in dollars and converted to basis points at each trade's entry price. Gold's price rose from about $1,800 (2020) to about $4,500 (2026), so the same dollars are about 3.3 bps early and about 1.3 bps late; this is reported year by year, not averaged away. The break-even cost is reported in dollars and in basis points. A second line with double the cost ($1.20) is reported as sensitivity.

## Sample

- **Primary window:** 2020-01-01 to 2025-10-31. 5m bars exist for every year (about 69,000 to 71,000 per year, all complete, one source: OANDA).
- **Replication window:** 2025-11-01 to 2026-10-28, not mixed into the primary result.
- This replication window is **not pristine**: the two earlier gold tests read the same price history. No outcome of *this* test has been read.
- **Size floor:** at least 300 trades on at least 150 different days in the primary window. The script reports the event and day counts first. Below the floor the result is recorded as "underpowered" and no outcome is reported.
- **What the size can detect.** A one-hour move in this window has a standard deviation of about 19 to 29 bps by year (about 23 pooled). With that spread, 80% power at a two-sided 5% level detects a true mean of about 3.7 bps at 300 trades, 2.6 at 600, 2.0 at 1,000 and 1.4 at 2,000. Clustering of events within days makes the real figure somewhat worse. A mean smaller than the cost cannot pass anyway, so the floor is a minimum to read the result at all, not a promise of power.

## Primary test

Mean gross return per trade (before cost), primary window, all years pooled, all events (stack 1 and above).

- Day-clustered bootstrap, 4,000 draws, 95% interval, one cluster per entry day.
- Placebo: the same (time, direction) pairs shifted circularly by a random offset of at least 300 bars, rerunning the same entry and exit rules; 600 shifts; `p` is the share of shifts with a mean at least as large as the observed one.
- **Passes only if all hold:** gross mean > 0 with the interval excluding zero; placebo `p < 0.05`; mean after the $0.60 cost > 0; the floor of 300 trades on 150 days is met; **and** the replication window's gross mean is also > 0.

## Checks that cannot rescue a failure

- **Trailing-extreme control:** the same sweep, entry and exit rules applied to the highest high and lowest low of the previous 72 bars (6 hours) instead of named levels. A positive primary only says something about *named* liquidity if it beats this.
- **Stack:** stack 2 and above against stack 1, with a day-clustered interval on the difference. Reported, not pass/fail.
- **By level type:** A only, D only, W only, and mixed. Reported only.
- **Continuation:** the same events traded the other way, net of cost, to show which side the cost hurts.
- Split halves (2020–2022 against 2023–2025-10) and year-by-year means; the sign should agree across halves.
- Sensitivity only: minimum penetration 2 and 5 bps; hold of 6 and 24 bars; long against short; entry hour blocks (03:30–07:00, 07:00–12:00, 12:00–15:30 UTC); US summer against US winter time, because the windows are fixed in UTC while US events move with daylight saving.

## Failure handling

A failure is recorded as "no edge from this form of the liquidity map". Levels, penetration limits, hold, window or cost are not re-tuned on this data. A different form needs a new pre-registration. A pass would only justify a stop and target design with its own pre-registration and a forward paper test, never live use.

## Known limits

- The cost is a guess; real fills are not available and any claim needs them.
- Events cluster on volatile days, so trades are not independent; the day-clustered bootstrap reduces the problem and does not remove it.
- Gold only, one broker's feed, mid-price style bars. The 3–50 bps penetration band is not independent of the price level: 3 bps is about $0.54 at $1,800 and about $1.35 at $4,500.
- Not covered: sweeps after 15:30 UTC (the New York afternoon), order-book liquidity, equal highs and lows, and NIFTY or BANKNIFTY.
- A statistical test of the market, not a trading recommendation; any live use needs the usual human review.

## Frozen implementation

The script is written after this document is committed and is itself committed before its first run. Its first stage only counts events and days; the outcome stage runs only if the floor is met.
