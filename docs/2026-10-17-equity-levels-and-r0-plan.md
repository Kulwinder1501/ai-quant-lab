# Equity Watch: R0 research study and Levels engine (work plan, mentor and reviewer edition)

Written 2026-10-17 by the planner. Basis: `2026-10-17-equity-signal-research.md` (evidence, parameter table, stance
proposal) and the lessons of Slices 0 and 1. The planner does not build. The owner is handing the work to another
developer; the planner acts as mentor and code reviewer (section 6 says exactly how reviews work).

## 1. Scope

Two work packages that can run in parallel once Day 0 is done:

* WP-A R0: a pre-registered research study that tests the stance rules (technical part) on a broad Indian stock history.
* WP-B Levels engine: pure calculation of important levels, an API route, a Levels tab and chart overlays.

Out of scope here (later work packages, same research doc): alerts, event and news flags, the live stance and its
scoreboard, fundamentals flags, anything that trades or touches the trading modules.

Why both share one rule file: R0 must test exactly the rules the app will run. The numbers live in one versioned JSON
(appendix A). Python (R0) and TypeScript (engine) both read it, and a parity test proves they compute the same levels.

## 2. Working agreement for the developer

* Branch `feature/equity-levels-r0` from the current `feature/stock-intelligence-m01`; small pull requests, one per step
  below; nothing merges without the reviewer's ACCEPTED.
* No imports from `paper-trading`, `strategy-engine`, `risk-management`, `autonomous-v2`; no reads of the `candles`
  table or any table outside schema `equity_research`; no new Yahoo calls from the app (the engine reads stored bars).
* No new migration unless the reviewer approves one in writing.
* Lessons from Slices 0 and 1 that are now rules:
  1. Reports must carry evidence (command and output). "Tests pass" alone is not accepted; the reviewer re-runs everything.
  2. Tests must never write to or delete from live data: use synthetic symbols with a `TEST` prefix and clean only those;
     never run a cleanup that removes rows you did not create (a watchlist stock disappeared this way once).
  3. Yahoo `range=max&interval=1d` silently returns monthly bars. Use explicit `period1`/`period2` and assert
     `meta.dataGranularity == "1d"`. Yahoo `close` is adjusted for splits and apparently rights issues, not dividends,
     and demergers can appear as a one-day drop (TMPV, 2025-10-14, -40%).
  4. Lint (`npm run lint`, zero warnings), typecheck, production build and all tests must pass; report counts before and after.
  5. UI work is checked in a real browser against the real API, including phone width 375 px.
  6. Colour never implies good or bad; banned words list applies to every UI string (buy, sell, hold, bullish, bearish,
     strong, weak, overbought, oversold, signal, target, outperform, underperform, recommend).
  7. Do not claim a check you did not run; mark it UNVERIFIED.

## 3. Day 0 (before any coding, half a day, the reviewer signs off)

1. Commit `equity-rules-v1.json` (appendix A) to `apps/api/src/modules/equity-research/domain/equity-rules-v1.json`.
2. Write the R0 specification (WP-A section 4.1) and commit it; the reviewer approves it; record the SHA-256 of both
   files in the spec. Any later change to either file is a new version (`v2`) with its own results.
3. Agree the universe file source (WP-A 4.2).

## 4. WP-A: R0 research study (Python, `apps/ml`, 3 to 5 days)

### 4.1 Question and pre-registration

Question: do the technical ingredients of the proposed stance (price location relative to levels, trend context,
liquidity gate) produce forward returns, net of costs, that beat simple baselines on data they were not tuned on?

Frozen before the first full run (follows the lab convention of `run_orderbook01_oos.py`: header with specification,
frozen parameters, verdict cases, trivial baseline):
* Parameters: `equity-rules-v1.json` (no tuning).
* Variants (6, declared now; the Holm correction runs over these): V1 BUY-conditions (technical part), V2 SELL-conditions
  (technical part), V3 support-touch ingredient alone, V4 resistance-touch with stretch alone, V5 trend context alone
  (close above 200-day average), V6 52-week-high proximity (top decile within each month).
* Primary horizon: 63 trading bars. Secondary (reported, not used for pass or fail): 21 and 126 bars.
* The event, news and fundamentals ingredients cannot be tested historically (no history); R0 says so in its verdict and
  they stay UNVALIDATED until the live scoreboard exists.
* Verdict cases per variant: PASS, FAIL, INCONCLUSIVE (not enough independent events). Overall: the stance is
  "supported", "not supported" or "inconclusive" for the technical part.

### 4.2 Data

* Universe: current Nifty 500 constituents (fallback Nifty 200) from a CSV that the owner or developer downloads from the
  exchange's index page by hand (no scraping); store it as `apps/ml/data/equity_universe_nifty500.csv` with source URL and
  download date in the header comment. Benchmark: `^NSEI` from Yahoo.
* Prices: Yahoo daily history through a script that uses explicit `period1=0&period2=now`, 1.2 s between requests,
  `dataGranularity` assertion, raw JSON stored with SHA-256 under `apps/ml/research_data/` (gitignored), manifest CSV
  (symbol, first date, last date, bars, sha256). About 500 calls, about 10 minutes. This is research use outside the app.
* Quality rules fixed in advance: drop series with fewer than 756 bars; mark any bar with an absolute one-day move above 40%
  as a suspected corporate-action artifact and exclude every event whose lookback or forward window contains one (count them
  and report results with and without the exclusion); drop zero or negative closes.
* Liquidity gate: median traded value (close x volume) over the previous 60 bars at least the value in the rules file.
* Survivorship: Yahoo has no delisted names, so the universe is survivors. Report this as a bias, not a footnote; the
  results section must say in which direction it pushes each variant.

### 4.3 Method

* Point-in-time only: a pivot is usable from bar `i + pivotHalfWindow`; nothing after bar `t` may influence a decision at `t`
  (test it by truncating the series and recomputing; section 4.5 gate R3).
* Level and stance definitions are exactly those of section 5.2 and appendix A. Python implements them independently of
  the TypeScript engine; parity fixtures prove equality (gate R4).
* Events: one event per stock per side per `cooldownBars`; additionally at most one event per stock per calendar month for
  the independence count.
* Outcome: forward return from the signal bar's close to the close `H` bars later, minus round-trip cost (large caps: 0.3%;
  others: 1%, tier from the median traded value rank in the rules file). For SELL variants the outcome is the avoided
  loss: baseline average minus forward return, minus the cost of exiting and re-entering.
* Baselines (all three must be beaten): (a) the same stock's average forward return in the same calendar year; (b) NIFTY 50
  (`^NSEI`) over the same window (buy and hold); (c) 1,000 random-date placebos with the same number of events per
  stock-year.
* Inference: bootstrap in calendar-month blocks (resample months, average within month), 5,000 draws, 95% interval, one-sided
  on the lower bound; Holm correction across the 6 variants at the primary horizon.
* Stability: results by two time halves and a holdout of the last 24 months that is evaluated once, at the end, and never
  inspected before.
* Reporting: for every variant, number of events, number of stocks, independent events, mean net excess, interval, share of
  positive events, median, results by half and holdout, and with/without the artifact exclusion.

### 4.4 Pass criteria (frozen)

A variant PASSES only if, at the primary horizon: the lower end of the 95% interval of net excess is above zero against all
three baselines; the sign is the same in both halves and in the holdout; independent events at least 300 across at least
40 stocks; and it survives Holm at 5%. FAIL if the upper end of the interval is below zero or the sign flips between halves.
INCONCLUSIVE otherwise. The developer must not change the criteria after seeing results.

### 4.5 Deliverables and acceptance gates (reviewer checks each)

Deliverables: frozen spec with hashes; `apps/ml/equity_stance_r0/` (fetch, features, events, evaluation, report) with unit tests
(`apps/ml/tests`); run manifest; results JSON and a markdown verdict; one command that reproduces the run from the stored raw data.

* R1 Spec frozen before the run: commit order and hashes prove the spec and rules file precede the results.
* R2 Data integrity: manifest matches the raw files (hashes); every series daily granularity; the artifact exclusion counts reported.
* R3 No look-ahead: a test truncates each of three stocks' series at 20 random dates and shows identical signals at that date
  with and without later data; reviewer repeats it on stocks of their choice.
* R4 Parity: Python and TypeScript produce identical levels and stance fields on at least 5 golden fixtures (shared file),
  plus 3 real stocks at 3 dates each, to 1e-9 on prices and exact on counts and flags.
* R5 Hand check: the reviewer recomputes 10 events (levels, ATR, distance, forward return, cost) from the raw data with an
  independent script and gets the reported numbers.
* R6 Baselines and placebo implemented as specified; the reviewer sets the placebo to the true event dates and sees about
  zero excess, and sets one stock's returns to a known drift and sees it recovered.
* R7 Statistics: a planted-edge test (synthetic series with a known +1% edge at events) is detected; a no-edge test is not
  detected at the 5% level more often than about 5% of the time over 200 simulations.
* R8 Costs and gates applied and reported; large-cap and other tiers separately.
* R9 Verdict text matches the numbers; no sentence claims more than the pass criteria allow; survivorship bias direction stated.
* R10 Reproducibility: the reviewer runs the single command on stored data and gets byte-identical results JSON (fixed seeds).

## 5. WP-B: Levels engine (TypeScript, 3 to 4 days)

### 5.1 Placement

* Pure functions: `apps/api/src/modules/equity-research/domain/levels.ts` with `levels.test.ts`. No database, no clock, no imports
  from outside `domain`. Parameters come from `equity-rules-v1.json`.
* Service: `EquityWatchlistService.getLevels(id)` reads the last 600 bars of one stock (one indexed query; the batched helper
  from Slice 1 can be reused) and the stock's re-backfill flag, as in `getTrend`.
* Route: `GET /api/v1/equity/watchlist/:id/levels` (UUID check, 404 on unknown, answers for removed stocks, no Yahoo call).
* Web: a `Levels` tab in the detail drawer, level lines on the existing chart (`equity-chart.tsx`, lightweight-charts price
  lines), a short list of the nearest support and resistance. Logic stays in the API, not in components.
* No migration. No change to the collector. No alerts yet (the output is designed so alerts can use it next).

### 5.2 Exact definitions (the reviewer recomputes with these; the numbers are in appendix A)

Inputs: bars sorted ascending (date, open, high, low, close, volume); `T` is the last bar.
* True range `TR_t = max(high_t - low_t, abs(high_t - close_{t-1}), abs(low_t - close_{t-1}))`; `ATR14` is the plain mean of the
  last 14 true ranges (not Wilder smoothing, so it is easy to verify); `ATR%` is `ATR14 / close_T`.
* Swing pivots: bar `i` is a swing low if `low_i < min(low_{i-k..i-1})` and `low_i <= min(low_{i+1..i+k})`, with
  `k = pivotHalfWindow`; swing high symmetrically. A pivot is known from bar `i + k` and is used only if `T - lookbackBars <= i <= T - k`.
* Clusters: take all pivot prices (lows and highs together); sort ascending; start a new cluster whenever the gap to the
  previous price exceeds `clusterGapPct` of the lower price (single linkage). Level price = mean of the cluster prices.
  `touches` = number of pivots; `strength` = touches weighted by recency `sum(0.5 ^ (age_in_bars / recencyHalfLifeBars))`;
  a swing level is valid only with `touches >= minPivots`. Record first and last pivot dates and the volume on the pivot bars.
* Side: a valid level below `close_T` is SUPPORT, above is RESISTANCE (levels act both ways; a level can change side).
* Zone half-width `w = max(zoneMinPct * level, zoneAtrMultiple * ATR14)`; distance to a level is shown in percent and in ATR
  units `(close_T - level) / ATR14`.
* Break and flip: a level is BROKEN if a close beyond it by more than `w` occurred within the last `brokenLookbackBars`
  bars after its last pivot became known; report the date; FLIPPED if price now sits on the other side.
* Reference levels (each with its source name): 52-week high and low (date > `T` minus 365 days, on high and low), 50-day and
  200-day simple averages of close, round numbers (magnitude `m = 10^floor(log10(close_T))`, multiples of `m/2` within
  `roundNumberRangePct` of price), unfilled gap edges in the last `lookbackBars` bars where the gap is at least `gapMinAtr` x ATR
  (a gap up is `low_t > high_{t-1}`; unfilled if no later low reached `high_{t-1}`; mirror for gaps down), volume profile
  over `lookbackBars` bars (`volumeProfileBins` equal bins from the lowest low to the highest high; each bar's volume split equally
  over the bins its high-low range touches; POC = the heaviest bin midpoint; value area = contiguous bins around the POC holding
  `valueAreaPct` of volume, expanding to the heavier neighbour; report VAH and VAL).
* Output contract: `asOfDate`, `isStale`/`staleDays` (against today's IST date, as in Slice 1), `rebackfillNeeded` (then
  state SUSPENDED and no levels), `atr14`, `atrPercent`, `levels[]` (price, kind, source, side, touches, strength, firstDate,
  lastDate, distancePct, distanceAtr, zoneLow, zoneHigh, state INTACT/BROKEN/FLIPPED, brokenOn), `nearestSupport`,
  `nearestResistance` (valid swing levels only; null when none), `riskDistanceAtr` (distance to nearest support in ATR),
  `warnings`, `disclaimer`, `formula` text per source. States per section as in Slice 1: OK, INSUFFICIENT_HISTORY (fewer than
  `lookbackBars + pivotHalfWindow + 1` bars: swing levels not produced, reference levels that can be computed still shown),
  SUSPENDED, NOT_MEANINGFUL.
* Warnings: large one-day moves (above 20%) inside the lookback are listed and flagged as possible unadjusted corporate actions
  (same rule as Slice 1); latest-day volume is preliminary.

### 5.3 Screen

* Levels tab: the nearest support and resistance with price, distance in percent and ATR, touches, source; the full level list
  sorted by distance with a filter for source; a "How these are calculated" disclosure; the note "Levels come from past prices and
  show where the market reacted before. In our test on 49 large Indian stocks, touches of such levels did not reliably predict
  the next 20 days, and breaks of resistance were followed by lower, not higher, returns."; the disclaimer footer.
* Chart: up to 6 lines (the strongest levels within 15% of price) as dashed price lines with a small label; supports and resistances
  distinguished by line style and label, not by good or bad colours; reference levels in a lighter style; a toggle to hide all.
* States: loading, empty, error, stale, suspended, insufficient history; phone width 375 px with the close button reachable.

### 5.4 Acceptance gates (reviewer checks each)

* L1 Hand-computed fixtures: at least 8 small bar series with levels, ATR, clusters, volume profile worked by hand in the test file.
* L2 No look-ahead: for 5 stocks and 20 dates each, levels computed on the full series cut at date `d` equal levels computed on the
  series cut at `d` (and a planted later spike changes nothing before it).
* L3 Parity with Python (shared with R4).
* L4 Independent recomputation by the reviewer on SUZLON and TMPV (and one more stock): pivots, clusters, strength, nearest
  support and resistance, 52-week levels, averages, POC and value area, at the as-of date, from the stored raw responses.
* L5 Edge cases: flat series, fewer than 258 bars, bars with gaps over 10 days, a halted stock (high equals low), duplicate prices,
  a demerger-style drop, zero-volume days, a series with a single pivot cluster, round numbers across a power of ten (99 to 101).
* L6 Determinism and purity: same input twice gives identical output; the file imports nothing outside `domain`.
* L7 Contract and states: route returns 400 on bad id, 404 on unknown, answers for a removed stock, SUSPENDED when the re-backfill
  flag is set, stale flag against today's IST date, disclaimer present; no Yahoo call (call log unchanged).
* L8 Wording and colours: banned-word test over every string in all states (including warnings, formulas and the note); no good/bad colour.
* L9 UI in a real browser: all six states, chart lines appear and toggle, desktop and 375 px, drawer close button reachable.
* L10 Performance: `GET /levels` under 200 ms for a 6,000-bar stock (the reviewer measures); the watchlist endpoint is not slowed.
* L11 Coupling and data: the no-coupling test passes and still fails if an import from a trading module is added; no new table; tests leave
  no rows in the live schema.
* L12 Regression: full API and web suites, typecheck, lint with zero warnings, production build; counts before and after in the report.

## 6. How reviews work

* Each pull request is one step: Day 0, then (A1) data fetch and manifest, (A2) features and events, (A3) evaluation and report,
  (B1) pure functions and tests, (B2) service and route, (B3) web. Steps of A and B may proceed in parallel after Day 0.
* The developer sends the reviewer: the diff or commit hash, the commands run with their output, test counts, and for numbers
  the files that produced them. The reviewer re-runs, recomputes independently, forces the failure states, and replies in the
  usual format: `Step: ACCEPTED | REJECTED | ACCEPTED WITH CONDITIONS`, gates with PASS/FAIL/UNVERIFIED and evidence, independent
  checks and mismatches, defects numbered with file and line.
* Red flags the reviewer rejects on sight: a parameter changed after results were seen; results without the manifest hashes; a
  claim without its command; tests that touch live rows; a verdict word stronger than the pass criteria; colours or words that
  imply advice; any import from a trading module.

## 7. Order, effort and risks

| Step | What | Days |
|---|---|---|
| Day 0 | rules file, R0 spec, universe source, hashes, reviewer sign-off | 0.5 |
| A1 to A3 | R0 data, events, evaluation, report | 3 to 5 |
| B1 to B3 | Levels engine, route, web | 3 to 4 |
| Parity (R4/L3) | shared fixtures, both sides | inside A and B |

Risks: Yahoo throttling during the 500-stock fetch (resume support, 1.2 s gap, no retries on 429, stop and report); survivorship
bias (stated, not fixable with free data); definitions drifting between Python and TypeScript (parity test is the guard);
temptation to tune after seeing results (the frozen spec and the reviewer prevent it); R0 may conclude "not supported", which is a
valid result and still leaves levels, risk distances and alerts useful.

## Appendix A: `equity-rules-v1.json` (proposed; frozen at Day 0)

```json
{
  "version": "equity-rules-v1",
  "levels": {
    "pivotHalfWindow": 5,
    "lookbackBars": 252,
    "clusterGapPct": 0.015,
    "minPivots": 2,
    "zoneMinPct": 0.01,
    "zoneAtrMultiple": 0.5,
    "atrPeriod": 14,
    "recencyHalfLifeBars": 126,
    "roundNumberRangePct": 0.15,
    "gapMinAtr": 1.0,
    "volumeProfileBins": 60,
    "valueAreaPct": 0.70,
    "brokenLookbackBars": 20,
    "largeMovePct": 0.20,
    "artifactMovePct": 0.40
  },
  "stance": {
    "buy": {
      "maxAtrAboveSupport": 1.5,
      "minStrengthTouches": 2,
      "maxBelowSma200Pct": 0.10,
      "negativeEventLookbackTradingDays": 10,
      "resultsBlackoutTradingDays": 5
    },
    "sell": {
      "maxAtrBelowResistance": 1.0,
      "minStrengthTouches": 2,
      "stretchAboveSma200Pct": 0.25,
      "breakBelowSupportAtr": 1.0
    },
    "liquidity": {
      "medianTradedValueBars": 60,
      "minMedianTradedValueInr": 20000000
    }
  },
  "costs": {
    "roundTripLargeCapPct": 0.003,
    "roundTripOtherPct": 0.01,
    "largeCapTradedValueRankMax": 100
  },
  "evaluation": {
    "primaryHorizonBars": 63,
    "secondaryHorizonBars": [21, 126],
    "cooldownBars": 10,
    "minIndependentEvents": 300,
    "minStocks": 40,
    "bootstrap": "calendarMonthBlock",
    "bootstrapDraws": 5000,
    "ciLevel": 0.95,
    "placeboDraws": 1000,
    "holdoutMonths": 24,
    "holmAlpha": 0.05,
    "seed": 20261017
  }
}
```
