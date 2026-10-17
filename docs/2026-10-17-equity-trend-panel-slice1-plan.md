# Equity Watch (Slice 1): descriptive trend panel

Written 2026-10-17 by the planner. Follows `2026-10-17-equity-watch-slice0-plan.md` (collector, watchlist, page).
Same working agreement: the planner does not build; a builder implements; the planner verifies against section 9.

## 1. Purpose and the line this slice must not cross

Purpose: show, for every watchlist stock, plain facts about how its price has behaved, computed from the bars
Slice 0 already stores. The owner asked for a suggestion such as buy, sell or neutral. This slice deliberately does
not give one:

* The earlier stock forecaster was worse than predicting the base rate (see memory `stock-intelligence-m01-failed-gate7`),
  and the wider lab research found no tested directional or technical signal that held up.
* Slice 0 data is prices plus Yahoo's thin fundamentals. Nothing here supports a valuation call.
* A rating chip implies an edge that has not been shown.

So the panel is descriptive: "what happened", never "what to do" and never "what will happen".

Non-goals (each stays out of Slice 1):
* Any buy / sell / hold / neutral label, score, rating, target price, probability or forecast.
* Any composite or weighted score across metrics.
* Oscillator indicators read as overbought/oversold (RSI, MACD, stochastic): their conventional reading is a signal.
* Comparison against NIFTY50 or peers (needs a benchmark source; a candidate for Slice 1b using Yahoo `^NSEI`).
  Reading the trading system's `candles` table is NOT allowed: it would couple the module to trading data.
* Fundamentals-derived ratios (P/E and similar): the data is secondary and not point-in-time.
* New Yahoo calls, new tables, alerts.

## 2. What is computed (definitions are exact so the verifier can recompute them)

Input: rows of `equity_research.price_bar` for the stock (date, open, high, low, close, volume), the stock's
`rebackfill_needed` flag and `series_version`. Series note: Yahoo `close` is adjusted for splits and apparently
rights issues but not dividends (data-source matrix section 7), so every return here is a PRICE return on an
adjusted series, not a total return, and long-ago price levels are not what traded.

As-of date `T` = date of the last stored bar. All dates are exchange (IST) calendar dates.

| Metric | Exact definition | Needs |
|---|---|---|
| Latest close | `close` on `T` | 1 bar |
| Return 1M, 3M, 6M, 1Y | `close(T) / close(ref) - 1`, ref = last bar on or before `T` minus N calendar months; ref must lie within 5 calendar days of the target date, else INSUFFICIENT_HISTORY | bars back to the target |
| Return YTD | ref = last bar on or before 31 Dec of the previous calendar year (same 5-day rule) | idem |
| 50-day and 200-day average | arithmetic mean of the last 50 / 200 closes | 50 / 200 bars |
| Distance from average | `close(T) / SMA(n) - 1` | the average |
| 50-day vs 200-day average | the two averages and their ratio, stated as a fact ("50-day is x% above/below the 200-day"); no crossover event, no name for it | both averages |
| 52-week high and low | max of `high` and min of `low` over bars with date > `T` minus 365 days | 200 bars minimum in the window, else INSUFFICIENT_HISTORY |
| Position in 52-week range | `(close - low) / (high - low)`, shown as a percentage; if high = low, NOT_MEANINGFUL | the above |
| Distance from 52-week high | `close / high - 1` | the above |
| Volatility, 20-day and 1-year | sample standard deviation (n-1) of `ln(c_t / c_{t-1})` over the last 20 / 252 daily returns, times `sqrt(252)`, shown as annualised percent | 21 / 253 bars |
| Maximum drawdown, 1 year | over bars in the last 365 days: min of `close_t / running_max_close - 1` | 200 bars in the window |
| Relative activity | mean volume of the last 20 bars divided by mean volume of the last 252 bars; the latest day's volume is preliminary and labelled so | 252 bars |
| Large daily moves | count of days in the last 252 where `abs(close_t / close_{t-1} - 1) > 20%`, listed with dates | 253 bars |

Each metric is returned with: value, formula id and text, window, number of bars used, first and last date used,
and a state: `OK`, `INSUFFICIENT_HISTORY`, `NOT_MEANINGFUL`, or `SUSPENDED`. A missing value is never shown as zero.

Rules for states:
* `rebackfill_needed = true` -> every metric `SUSPENDED` with the reason (a corporate action or restatement was
  detected and the full series is being re-synchronised). The panel shows the banner already used by the chart.
* Last bar older than 4 calendar days (same threshold as the STALE state) -> metrics still computed, panel shows
  "as of <date>" and the stale notice.
* A gap of more than 10 calendar days inside a metric's window -> a warning on that metric (it is still computed).
* Non-positive or non-finite closes are excluded and listed as warnings.

## 3. Where it is computed (architecture)

* Pure functions in `apps/api/src/modules/equity-research/domain/trend-metrics.ts`. No database, no clock, no
  rounding inside; the as-of date is an input. Every function has unit tests. No business logic in web components
  (checklist phase 9).
* Application: `EquityWatchlistService` gains `getTrend(id)` and a small `trendSummary` on each watchlist item.
  It reads the last 400 bars per stock (about 1.6 years: enough for every window above; one indexed query), not the
  full history.
* Routes (additive): `GET /api/v1/equity/watchlist/:id/trend` returns the full panel; each item of
  `GET /api/v1/equity/watchlist` gains `trendSummary` (1M return, 1Y return, position in 52-week range, state only).
* No migration, no new table, no Yahoo call. Nothing is stored: the panel is recomputed on read from stored bars.
* No import from trading modules; no read of the `candles` table. The existing no-coupling test must still pass.

## 4. Screen design

Detail drawer: a new first tab `Trend` (the drawer already has Price Chart, Secondary Fundamentals, Actions &
Revisions, Collection Logs). Content, top to bottom:
1. As-of line: "Based on daily bars up to <date>" plus the stale / suspended banner when applicable.
2. Returns row: 1M, 3M, 6M, YTD, 1Y (percent; the sign shown by colour and a +/- character).
3. Averages block: close, 50-day and 200-day average, distance of the close from each, 50-day vs 200-day fact.
4. 52-week block: low, high, a range bar with a marker, position percent, distance from high.
5. Risk block: 20-day and 1-year annualised volatility, 1-year maximum drawdown, large-move days with dates.
6. Activity: relative volume with the preliminary-volume note.
7. Footer, always visible: "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns
   only (dividends excluded). Not a recommendation, rating or forecast."
8. A "How these are calculated" disclosure that shows each metric's formula text and bars used.

Watchlist table: three compact columns `1M`, `1Y`, `52W position` (a small bar) from `trendSummary`; hidden on phone
width, where the row opens the drawer. No column carries a verdict word.

Wording rules (enforced by a test, see T5):
* Allowed phrasing is factual: "above", "below", "x% from its 52-week high", "annualised volatility".
* Banned in any UI string or API text field: buy, sell, hold, bullish, bearish, strong, weak, overbought,
  oversold, signal, target, outperform, underperform, recommend (except in the footer's "Not a recommendation").
* Colour: green / red only for the sign of a return or drawdown. State of a moving-average comparison, volatility
  level or range position uses neutral colours, so colour never implies "good" or "bad".

## 5. Edge cases the builder must handle

* Newly added stock with fewer than 200 bars: show what exists, mark the rest INSUFFICIENT_HISTORY with the number of
  bars needed.
* A stock whose first bars are recent (IPO): returns older than the history are INSUFFICIENT_HISTORY.
* Bars on weekends or special sessions (SUZLON has 3 weekend bars): treated as bars, never skipped by weekday rules.
* Reference date falls on a holiday: the 5-day rule picks the last earlier bar; if none within 5 days, INSUFFICIENT_HISTORY.
* Leap-year and month-end arithmetic for "N months back" (for example 31 May minus 3 months).
* Zero or very low volume days: volume ratio still defined; zero denominator -> NOT_MEANINGFUL.
* All-equal prices (halted stock): high = low -> NOT_MEANINGFUL for range position, zero volatility is a value, not an error.
* Stock removed (inactive): the endpoint still answers for its id (history is preserved), clearly marked removed.

## 6. Risks

| Risk | Treatment |
|---|---|
| The panel is read as advice despite the wording | Footer on every view, no verdict words, no composite, no green/red on states; verifier checks T5 and T6 |
| Wrong numbers on an adjusted series after a corporate action | `SUSPENDED` while `rebackfill_needed`; the adjusted-series caveat is shown; independent recomputation (T1) |
| A metric is computed on too little data and looks authoritative | Minimum-bars rule per metric with an explicit INSUFFICIENT_HISTORY state |
| Preliminary latest-day volume distorts relative activity | Labelled preliminary; the ratio uses 20 bars, so one day moves it little |
| Slow watchlist with many stocks | Last 400 bars per stock only; T9 measures it |
| Scope creep into signals (RSI, crossovers, scores) | Listed as non-goals; verifier rejects them |

## 7. Effort (builder estimate, planner's arithmetic)

| Item | Days |
|---|---|
| Pure metric functions plus unit tests (all edge cases in section 5) | 1 to 1.5 |
| Service methods and the two route changes, with tests | 0.5 |
| Drawer tab, table columns, states, responsive layout | 1 to 1.5 |
| Wording test, formula disclosure, verifier fixes | 0.5 |
| Total | 3 to 4 |

Suggested order: 1) functions and tests, 2) service and routes, 3) UI. Verify each step before the next.

## 8. Deploy notes

No migration. API and web images change; the scheduler image is unaffected. Build from a clean worktree and deploy
with `-p aiquantlab --env-file .env`, as for Slice 0.

## 9. Acceptance gates for the verifier

Evidence format as in the checklist. Gates G1 to G9 of the checklist still apply; those below are specific.

* T1 Independent recomputation: for SUZLON and INFY the verifier recomputes at least 10 values each (returns for
  three horizons, both averages, 52-week high and low, position, both volatilities, drawdown) with a separate script
  working from the stored raw Yahoo response, not from the builder's fixtures or functions, and reports every
  mismatch. Tolerance: equal after the stated display rounding.
* T2 Windows and boundaries: fixtures with exactly 199 and 200 bars (SMA200 flips from INSUFFICIENT_HISTORY to OK),
  a reference date on a holiday, a month-end ("31 May minus 3 months"), a leap day, and a 5-day-rule failure.
* T3 Suspension: with `rebackfill_needed` set on a throwaway stock, every metric is SUSPENDED and the banner shows;
  clearing the flag restores values. The verifier does this itself.
* T4 Stale: a stock whose last bar is older than 4 days shows the as-of date and the stale notice; values are not hidden.
* T5 Wording: an automated test scans every UI string and API text field for the banned terms; the verifier also
  greps the built bundle and the API payloads, and checks there is no aggregate score and no state-implying colour.
* T6 Disclaimer: the footer text and the adjusted-series caveat appear in the drawer on every state, and a
  `disclaimer` field is present in the API payload.
* T7 No new data or schema: after loading the panel for every stock, `source_call_log` and `raw_record` counts are
  unchanged (zero Yahoo calls) and no migration was added.
* T8 Coupling: no imports from trading modules and no read of `candles`; the no-coupling test passes and the
  verifier tries to add one to see it fail.
* T9 Performance: with 50 throwaway stocks of about 6,000 bars each, `GET /watchlist` answers in under 500 ms warm
  (my target; the verifier reports the measured median and worst case). Throwaway data is removed afterwards.
* T10 No hard-coded company data: grep the module and fixtures for SUZLON or INFY figures; every number comes from
  stored bars or a clearly named fixture.
* T11 UI states: loading, empty, error, stale, insufficient-history, suspended, and phone width (375 px, no
  horizontal page scroll), each forced and checked in a real browser against the real API.
* T12 Regression: full API and web suites, typecheck, lint (`eslint . --max-warnings=0`) and production build pass;
  test counts before and after reported; tests leave no rows in the live schema.
* T13 Real run on record: the panel for SUZLON and INFY opened in a browser against the deployed stack, values
  compared with T1, screenshot saved.

Red flags: any verdict word; a number shown without its as-of date; a metric computed with fewer bars than its
minimum; a return labelled "total return"; green/red used on a state; a Yahoo call made by the panel.

## 10. After Slice 1

If the owner later wants an actual rating, the route is the one in the master plan: valuation scenarios first, then
any statistical view only through a pre-registered evaluation against baselines (naive drift, market, peers), shown as
INSUFFICIENT_EVIDENCE until it passes. The metric functions here are reusable as features for that evaluation.
