# Equity Watch: Alerts and Event Flags (work plan, mentor and reviewer edition)

Written 2026-10-19 by the planner. Basis: `2026-10-17-equity-signal-research.md`, the R0 result
(`2026-10-18-equity-stance-r0-results.md`: NOT SUPPORTED), the live Levels engine, and the Slice 0/1 lessons. The planner
does not build; the developer builds, the planner reviews and verifies (same protocol as the levels plan, section 8).

## 1. Is it the right time? Decision: yes, start now

Reasons:

* Nothing blocks it. Alerts claim nothing, so they do not depend on any validation. The one thing R0 could have
  changed (whether a stance deserves to exist) is settled: no tested rule earns one. Alerts and event flags are what is
  left that is honest and useful for the owner's goal ("let me know"): they say *when to look and what happened*, not
  *what to do*.
* Everything they need is already stored: daily bars, the Levels engine, corporate actions, quarterly facts.
* The first real run of the collector (Mon 2026-10-19 17:00 IST) is verified, and Levels is deployed (commit ade5d152).

Conditions that would pause it: Tuesday's 17:00 run failing (fix the collector first), or the owner wanting the Suzlon
filings spike first (they can run in parallel; the spike needs no code in this plan).

## 2. Scope and non-goals

In scope: (A) end-of-day alerts from levels, extremes and data health; (B) event flags: detected events plus owner-entered
cited events; an in-app inbox and per-stock chips.

Not in this plan, on purpose:

* Any buy, sell or neutral stance. R0 found no edge, so none is built. Wording stays descriptive everywhere.
* Intraday alerts. The data is daily bars collected at 17:00; an intraday touch that closes back is not an alert.
  Real-time would need quotes against a 300-a-day Yahoo budget and would invite noise.
* Volume alerts. Yahoo revises the latest day's volume after the fact (known trap), so a 17:00 volume alert would be
  evaluated on a number that later changes. Revisit once a next-day re-check exists.
* News headline ingestion or sentiment. Our own test showed keyword matching on headlines fires on 78% of days, and
  the literature effect is small and short-lived. Events come from structured data or owner entries with a link.
* Push (email, phone). In-app only in v1; see section 11, decision 1.
* Any import from trading modules, any read of tables outside schema `equity_research`, any new external host.

## 3. What the owner gets

* A bell with an unread count on the Equity Watch page, an Alerts list (newest first, filter by stock and status), and
  chips on each stock row ("2 new").
* Each alert is one factual sentence plus its inputs, for example: "Closed at 40.38, 0.3 ATR above support 40.00
  (round number, reference level)". It always shows the level's source and strength, and a fixed footer: "Reference
  only. Not a forecast. In our test of six rule sets on 433 stocks none showed an edge."
* An Events tab in the stock drawer: detected events and owner-entered ones on one timeline, with markers on the chart.

## 4. Alert types (rule set `equity-alerts-v1.json`, versioned and hashed like the levels rules)

All rules read the Levels engine output for the evaluation date T (never recompute levels in the alert code) and the
stored bars. Evaluation uses only bars up to T.

| Kind | Fires when | Default parameters | Why |
|---|---|---|---|
| LEVEL_APPROACH | close is within 1.0 ATR of a qualifying level and was farther away the day before | qualifying = swing level with touches >= 2 and strength >= 1.0, or 52-week high or low, or SMA200; round numbers, gaps and volume-profile levels excluded in v1 | the owner asked for levels; round numbers and profile levels are noisy at v1 |
| LEVEL_ZONE_ENTER | day's high-low range overlaps a qualifying zone and the prior close was outside it | same qualifying set | a touch is only meaningful against the zone, not the line |
| LEVEL_BREAK | the engine's state for a qualifying level changes to BROKEN or FLIPPED on T | uses the engine's own break and flip definition | one definition of a break in the whole app; message adds "In our test, breaks reversed more often than they continued" |
| NEW_52W_EXTREME | close is a new 52-week high or low | none | simple, objective |
| LARGE_MOVE | abs one-day close return >= 2.5 x ATR14% and the move is below the 40% artifact threshold | 2.5 | scaled to each stock's own volatility |
| DATA_EVENT | one-day move of 40% or more, or a new split, or a restated older bar | engine artifact threshold | likely a demerger or corporate action, not a price signal; must not appear as a "big move" |
| DATA_HEALTH | stock SUSPENDED (re-backfill), stale beyond the staleness rule, source DOWN or RATE_LIMITED, INSUFFICIENT_HISTORY | existing state rules | tells the owner when other alerts cannot be trusted |

Cooldown and de-duplication: at most one alert per (stock, kind, level) per 5 trading days; a level that stays inside a
zone does not re-fire daily. Alerts for a stock in a non-OK data state are suppressed and replaced by one DATA_HEALTH
alert.

Threshold calibration rule (pre-registered): thresholds are set by alert *frequency only*, never by what happened
afterwards. Replay the rule set over the 433-stock history already on disk (`apps/ml/research_data`) and require a
median of at most 3 level alerts per stock per month and a 95th percentile of at most 8. If the budget is exceeded,
tighten the thresholds once, record the new values and hash, and ship. No return data is looked at.

## 5. Event flags

Sources are limited to what we legitimately have. Probed on 2026-10-19: Yahoo's calendar endpoint answers
"401 Invalid Crumb" (login handshake needed) and the chart call returns no earnings events, so **upcoming results dates
are not available from our one source**. They come from the owner or from the Phase 0 filings spike.

| Flag | Origin | Rule |
|---|---|---|
| RESULTS_PUBLISHED | detected | a new quarterly period_end appears in `secondary_fact` (first_seen_at is the detection date); show revenue and net income change versus the same quarter a year earlier, descriptive only |
| CORPORATE_ACTION | detected | new split or dividend row in `corporate_action` (ex-date); no future announcements exist in this source, say so |
| LARGE_MOVE_DAY | detected | days from the LARGE_MOVE rule, shown on the timeline; "no note attached" until the owner adds one |
| OWNER_EVENT | manual | kind (RESULTS_DATE_UPCOMING, MATERIAL_NEGATIVE, ORDER_WIN, REGULATORY, MANAGEMENT, OTHER), event date, headline up to 200 characters, **source link required** |

Material-negative categories follow the research document (fraud, auditor exit, regulatory order, default, order
cancellation). Edits create a new revision; nothing is overwritten. An event within the last 10 trading days appears as
a context chip on an alert; it never changes whether the alert fires.

## 6. Data model (one migration, numbered after the latest, currently 139 so 140)

Schema `equity_research`, no foreign keys to other schemas, immutable rows:

* `alert`: id, stock_id, kind, level_key (null if none), evaluated_date, severity (INFO or NOTICE), title, payload_json
  (the exact inputs shown: close, level, ATR, series_version, rules_hash), created_at.
  UNIQUE (stock_id, kind, coalesce(level_key,''), evaluated_date).
* `alert_state`: alert_id primary key, status (NEW, SEEN, DISMISSED), updated_at.
* `event_flag`: id, stock_id, kind, origin (DETECTED or MANUAL), event_date, headline, source_url, detail_json,
  supersedes_id, created_at. CHECK: origin MANUAL requires a non-empty https source_url. Detected events are unique per
  (stock_id, kind, event_date, detail key) so a re-run never duplicates.

The payload snapshot is why a later restatement of a bar cannot silently rewrite what the owner was shown.

## 7. How it runs

* A final step of `equity:collect:eod` (so the order is guaranteed), plus an idempotent CLI
  `equity:alerts:eval --date YYYY-MM-DD` for re-runs and backfill. Evaluation runs only for stocks that stored a new bar
  on the evaluation date; no new bar (weekend, holiday) means no evaluation.
* Failure isolation: if evaluation throws, the collection still reports success and the failure is logged and shown as
  a DATA_HEALTH item. A collector must never fail because of an alert.
* Pure code: `domain/alert-rules.ts` takes (levels at T, levels at T-1, bars, rules) and returns alerts; no I/O.
  Evaluation dates are bar dates, and staleness uses today's IST date, passed in.

## 8. Working agreement and review protocol

* Branch `feature/equity-alerts-events` from `feature/stock-intelligence-m01`; one pull request per step; nothing
  merges without the reviewer's ACCEPTED.
* The reviewer re-runs everything, recomputes independently, forces the failure states, and replies
  ACCEPTED, REJECTED, or ACCEPTED WITH CONDITIONS with PASS, FAIL or UNVERIFIED per gate. The developer's own tests are
  not accepted alone. Reports must state test flags used.
* Test hygiene (lessons already paid for): tests use `TEST_*` sources and synthetic symbols only, never touch or delete
  live rows, and must pass in the default parallel mode.

## 9. Steps and effort (planner's arithmetic, not commitments)

| Step | What | Days |
|---|---|---|
| 1 | `equity-alerts-v1.json`, pure rules, unit tests, historical replay script for the frequency budget | 2 to 3 |
| 2 | migration, repositories, eval CLI, hook into the collector, DATA_HEALTH and DATA_EVENT handling | 2 |
| 3 | API: list alerts, set status, list and add events (revision on edit) | 1 to 2 |
| 4 | UI: bell, inbox, chips, Events tab and add form, chart markers, empty, loading and error states, phone width | 2 to 3 |
| 5 | detected event flags (new quarter, corporate action, large-move day) | 1 to 2 |
| 6 | verification, then a 5 trading day soak counting alerts per stock | reviewer, 1 week |

About 8 to 12 developer days plus the soak.

## 10. Gates the reviewer will check

| Gate | What must be true | How the reviewer proves it |
|---|---|---|
| E1 | Idempotent: evaluating the same date twice adds no rows | run twice, compare counts and hashes |
| E2 | No look-ahead: alerts for date T use bars up to T only | truncate the series at 60 random dates, results before the cut identical |
| E3 | Break and flip alerts agree with the engine's states | my independent run of the engine against alert output on 15 cases |
| E4 | Cooldown works: no daily re-fire inside a zone | forced scenario with a price sitting in a zone for 10 days |
| E5 | Non-OK stocks (SUSPENDED, STALE, INSUFFICIENT_HISTORY) produce one DATA_HEALTH alert and no level alerts | force each state |
| E6 | A 40%+ day yields DATA_EVENT, never LARGE_MOVE | use the TMPV demerger day (2025-10-14, -40.15%) |
| E7 | Frequency budget met on the 433-stock replay (median <= 3, p95 <= 8 per stock-month) and reported | rerun the replay script, recompute the percentiles |
| E8 | Manual events cannot be saved without an https source link, at the API and the database | direct SQL insert and API call both refused |
| E9 | Immutability: an edit creates a revision, the old row is unchanged | inspect rows before and after |
| E10 | Collector isolation: a forced evaluation error leaves the collection successful | inject a throw, check job result and bars |
| E11 | Wording: no banned words (buy, sell, hold, bullish, bearish, strong, weak, overbought, oversold, signal, target, outperform, underperform, recommend) in any alert or event string, apart from the fixed footer, which is on a short allow-list | automated string scan plus my reading |
| E12 | Time handling: IST dates, weekends and holidays produce no evaluation | forced dates |
| E13 | No coupling: no imports from trading modules, no reads outside the schema | the existing no-coupling test extended |
| E14 | UI: loading, empty, error, populated; phone width; drawer and inbox usable | my own browser checks |
| E15 | Test hygiene and default parallel mode pass | I run them |

## 11. Decisions (defaults chosen by the planner; the owner only confirms)

1. Delivery is in-app only in v1. Honest limit: the owner sees alerts only when the page is open, which is weaker than
   "let me know". Recommended first follow-up after the soak: a once-a-day digest sent by a channel the owner picks
   (email or chat). It is a separate step because it needs credentials and a recipient.
2. Evaluation is end-of-day only (17:00 run). Intraday is out of scope for the reasons in section 2.
3. Upcoming results dates: owner enters them (with a link) until the Phase 0 filings spike, or a legitimate calendar
   source, replaces that. No unauthenticated scraping of Yahoo's crumb-protected endpoints.
4. Thresholds are calibrated by frequency only, once, before shipping, and then frozen under a hash.

## 12. Risks, stated plainly

* Alert fatigue is the main way this fails. Hence the frequency budget and the cooldown.
* Alerts can be read as advice. Hence descriptive wording, the fixed footer, and the banned-word gate.
* Yahoo can restate recent bars or add rights-type adjustments silently (known). Payload snapshots, the DATA_EVENT
  path and the restatement handling from Slice 0 cover this, but older levels can shift after an adjustment.
* Deleted or missing watchlist rows (INFY has disappeared three times without a found cause) would orphan alerts.
  Alerts keep their payload and stock symbol; the cause of the deletions stays an open item.
