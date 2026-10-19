# Equity Watch: how to build levels and a buy / sell / neutral stance (research and design)

Written 2026-10-17 by the planner. The owner's goal (stated 2026-10-17): manage important levels for the picked stocks,
and give a buy, sell or neutral signal from levels, support and resistance, news, projects and other aspects. The owner
does not want to define rules; the planner chooses them. This document is the research basis and the proposed design.
It is not a build ticket: section 8 says what the owner must approve first.

## 1. Verdict in five lines

1. Levels (support, resistance, 52-week extremes, averages, volume zones) can be computed now and are useful as
   reference points, risk distances and alert triggers.
2. The evidence that levels or other price technicals predict returns is weak: strong in a few intraday FX studies,
   mostly gone after data-snooping and costs in equity studies, and in our own test on 49 Indian large caps the touches
   show no robust effect while level BREAKS tend to reverse.
3. News and results have real but small and short-lived effects, mostly after bad news, and the stock-level signal is
   faint in noisy headline feeds.
4. So a stance cannot honestly be sold as a prediction. It can be built as a transparent, fixed, versioned rule set with
   a public scoreboard, and it stays labelled UNVALIDATED until it beats baselines net of costs on data it was not tuned on.
5. Order of work: research the exact rules on a broad history first (cheap, no app change), then levels and alerts, then
   the stance with its scoreboard. The odds that the stance passes its own test are not high; levels, risk distances and
   the event calendar stay useful either way.

## 2. What the published evidence says (abstracts and summaries read, not full papers)

| Topic | Finding | Read |
|---|---|---|
| Support / resistance, FX | Levels published by six dealers predicted intraday trend interruptions for 1996-98, with large differences by firm and pair; a later paper explains it by clustering of stop-loss and take-profit orders at round numbers | [Osler 2000, NY Fed](https://www.newyorkfed.org/medialibrary/media/research/epr/00v06n2/0007osle.html) |
| Support / resistance, US stocks | Support levels beat resistance at predicting interruptions, but no excess return against buy and hold | [Canterbury study](https://repository.canterbury.ac.uk/item/871vw/identifying-and-evaluating-horizontal-support-and-resistance-levels-an-empirical-study-on-us-stock-markets) |
| Technical rules and data snooping | After correcting for the whole universe of rules, no significant profitable rule on US indices; the best rule of the original study was insignificant on the next 10 years | [Sullivan, Timmermann, White 1999 (summary)](https://researchonline.lse.ac.uk/id/eprint/119144) |
| Chart patterns | Several patterns carried incremental information in US stocks 1962-96; patterns good at detecting anomalies need not be good for profit | [Lo, Mamaysky, Wang 2000](https://www.nber.org/papers/w7613) |
| Indian technical rules | Moving-average rules detect direction but returns could not be fully captured after costs; RSI and MACD gave no reliable risk-adjusted gain; an older working paper is more positive | [Mitra 2011](https://ideas.repec.org/a/taf/quantf/v11y2011i2p287-297.html), [Muruganandan 2020](https://mgmt.cmb.ac.lk/cbj/index.php/testing-the-profitability-of-technical-trading-rules-across-market-cycles-evidence-from-india/) |
| 52-week high | US: nearness to the 52-week high predicts returns (George and Hwang 2004); India: a working paper (2004-2023) reports the effect; index-level tests in emerging markets were unprofitable | [Quantpedia summary of the India paper](https://quantpedia.com/?p=745) |
| News tone | Reuters tone predicts small, transitory daily returns, mostly market level; India aggregate news sentiment has short-lived effects | [IMF WP 2018](https://imf.org/-/media/Files/Publications/WP/2018/wp18274.ashx), [Chari et al. 2023](https://ideas.repec.org/a/gam/jjrfmx/v16y2023i8p376-d1218076.html) |
| Earnings drift, India | Mixed: drift after bad earnings news for about a week in one study, little drift in another | [Nottingham event study](https://eprints.nottingham.ac.uk/26569), [Gupta and Dhusia 2021](https://journals.vutbr.cz/index.php/trends/article/view/541) |

Reading: effects exist in places, are small, shrink out of sample and after costs, and are fragile to definitions.

## 3. Our own test (research only, outside the app)

Data: Yahoo daily history for 49 NSE large caps (about 325,000 daily bars, 2000s to 2026-10-16), the same adjusted
series the app stores (matrix section 7 caveat applies). Scripts: `docs/research/equity-signal-study/`.
Levels were defined once, in advance, and not tuned: swing pivots with 5 bars on each side, looked back 252 bars,
pivots within 1.5% grouped into a level, a level needs at least 2 pivots, zone is plus or minus 1%, approach means the
prior close was at least 2% away, one event per 10 bars. Outcome: the 20-day (and 10-day) forward return minus the same
stock's average 20-day return in the same calendar year.

| Event | What a "levels work" view expects | Result at 20 days (event-weighted) | Month-weighted view |
|---|---|---|---|
| Touch of support | above 0 | +0.14%, 95% CI -0.04% to +0.33% | +0.6%, t about 1.9 (median event -0.02%) |
| Touch of resistance | below 0 | -0.04%, CI -0.18% to +0.10% | -0.3%, t -1.1 |
| Close below support | below 0 | +1.0%, CI +0.1% to +2.4% (reversal) | +4.3%, t about 2.0 |
| Close above resistance | above 0 | -0.54%, CI -0.89% to -0.24% (reversal) | -1.1%, t -3.6 (still -3.3 without the 2008-09 and 2020 crashes) |

Monthly cross-section (non-overlapping 21-day horizon): stocks nearest their 52-week high minus furthest: -1.6% a month,
t -1.7 (negative in both halves of the sample; the literature expects positive); close above the 200-day average minus
below: +0.4% a month, t +1.2, unstable (first half +1.1%, second half -0.3%); new 52-week highs against all stocks:
-0.1%, t -0.3.

What it says: touches carry no robust information; breaks of levels are more often false than followed through (the
resistance result is consistent across weightings); the 52-week-high and trend effects did not show up in 49 large caps.
Limits, stated plainly: survivors only (today's large caps), which favours rebounds after drops and may explain part of the
"close below support" result; 49 stocks is a thin cross-section; one level definition, one horizon family; no costs
(a round trip on a large cap is roughly 0.2-0.4%, comparable to the effects above); about a dozen tests were run, so one or
two borderline results can be chance; overlapping events share market moves. This is evidence of absence of a strong, easy
edge, not proof that none exists.

## 4. What this means for the design

Do not claim that levels predict. Use levels for what they do reliably:
* Reference: where is price relative to places the market has reacted before.
* Risk: distance to the nearest support in ATR units sets a sensible stop distance and position size (arithmetic, not forecast).
* Alerts: the owner is told when price reaches or breaks a level; no forecast is implied.
* Context for a stance, with its limits shown.

## 5. Parameters (chosen by the planner, fixed in advance, versioned; the exact numbers are the pre-registered rule set)

| Group | Parameter | Default | Why | Available |
|---|---|---|---|---|
| Levels | swing pivot half-window | 5 bars | standard, as tested | now |
| Levels | lookback | 252 bars | one trading year | now |
| Levels | cluster tolerance, min pivots | 1.5%, 2 | filters one-off wicks | now |
| Levels | zone width | max(1%, 0.5 x ATR14) | adapts to volatility | now |
| Levels | strength score | pivots in cluster, recency-weighted, volume at pivot | more evidence, more weight | now |
| Levels | other levels | 52-week high and low, 50 and 200-day averages, round numbers, gap edges, volume-profile POC and value area (daily bars, 60 bins, 252 days) | the Osler mechanism and common reference points | now |
| Trend | close vs 200-day average, 50-day slope, 12-1 month momentum | as defined | context, not a trigger on its own | now |
| Risk | ATR14 and ATR%, 1Y volatility, 1Y max drawdown, large-move days | as in Slice 1 | sizing and caution | now |
| Liquidity | median daily traded value, zero-volume days, circuit-limit days | thresholds per cap class | essential for small caps | now |
| Events | results date window, material negative events (fraud, auditor exit, regulatory order, default, order cancellation) in last 10 trading days | rule-based categories | bad news carries the stronger evidence | partly now (manual), fully with filings import |
| Fundamentals | YoY revenue and profit trend over 4 quarters, margin trend, debt and interest cover, cash flow vs profit, order book (Suzlon) | flag "improving / flat / deteriorating" | only from verified filings | after master-plan Phases 3-5 |
| News | event-type counts and recency from announcements and headlines, shown with source and citation | no sentiment score as a driver | effect small and short-lived, feed noisy | context only until validated |

## 6. The stance (proposal)

An ordinal rule over four ingredients, not a weighted score (weights invite over-fitting). Wording is "conditions met",
never "buy now".

* BUY-CONDITIONS MET: price within 1.5 ATR above a level of strength 2 or more, and the close is not below it; trend
  context not broken (close not more than 10% below the 200-day average); no material negative event in the last 10
  trading days; results not due within 5 trading days; fundamentals flag not "deteriorating" (when known); liquidity
  gate passed.
* SELL-CONDITIONS MET: price within 1 ATR below a resistance of strength 2 or more while stretched (close at least 25%
  above the 200-day average), or a close below support by more than 1 ATR together with a material negative event or a
  "deteriorating" fundamentals flag.
* NEUTRAL: everything else. Also INSUFFICIENT_DATA and SUSPENDED (re-backfill) states, as in Slice 1.

Each stance shows its checklist ("5 of 6 conditions met"), the level used with its strength and source, the distance in
ATR, the risk distance, and the scoreboard figure for that stance type. Thresholds are a single versioned file; changing
one creates a new version with its own scoreboard.

Given section 3, the planner expects the plain level-touch ingredient to add little. It stays in because the owner asked
for levels, and because the research step below decides, with data, whether any ingredient earns a place.

## 7. How it earns the word "validated"

1. Research step R0 (before any stance UI): test the exact rule set above, unchanged, on a broad history (Nifty 200 or
   500 from Yahoo, about 10 minutes of calls), walk-forward (design on the earlier half, one untouched holdout on the
   later half), net of costs (0.3% round trip large caps, 1% small caps), against three baselines: the same stock's
   unconditional return, NIFTY 50 buy and hold, and random dates with the same frequency. Pass requires: the lower
   end of a time-clustered 95% interval above zero, same sign in both halves, at least 300 independent events across at
   least 40 stocks. Survivorship is reported as a bias because Yahoo does not provide delisted stocks.
2. Live scoreboard: every stance for every watchlist stock is written once per day to an immutable table; a job
   fills in 1, 3, 6 and 12-month forward returns against the same baselines. The panel shows the running record.
3. Until both pass, every stance carries "UNVALIDATED" and the record next to it. A short watchlist cannot validate a
   rule by itself (too few independent events), so R0 on the broad universe is the real test.

## 8. Effort, order, and what the owner must approve

Estimates (planner's arithmetic, not commitments):

| Step | What | Days |
|---|---|---|
| R0 | broad-history research of the exact rule set, scripts and a report | 3 to 5 |
| 1 | level engine (pure functions, tests), Levels tab, levels on the chart | 3 to 4 |
| 2 | alerts (in-app first): price reaches or breaks a level, zone entered, stance change | 2 to 3 |
| 3 | event flags: results calendar, manual and cited event entries | 3 to 4 |
| 4 | stance engine, immutable daily log, forward-return job, scoreboard panel | 4 to 6 |
| 5 | fundamentals flag, after the filings import (master plan Phases 3 to 5) | separate |

Order: R0 first, then 1, 2, 3, 4. Steps 1 and 2 are useful whatever R0 finds.

Owner decisions needed (defaults chosen; only confirm): (a) R0 before the stance UI; (b) alerts are in-app only for now
(email or phone push is a later choice); (c) the holding horizon assumed is weeks to months, so daily bars.

## 9. Do not

* Describe any stance as a forecast, a recommendation or a promise of timing.
* Tune thresholds after looking at the scoreboard without making a new version.
* Use a headline-sentiment number as a trade trigger.
* Reuse the trading system's tables or execution path (G1 still applies).
* Add short-term oscillators (RSI, MACD) as signals: the evidence for them is the weakest, and they invite over-fitting.
