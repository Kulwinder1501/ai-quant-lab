# Equity Watch (Slice 0): collector, watchlist page, sidebar entry

Written 2026-10-17 by the planner. Companion to `2026-10-17-equity-intelligence-module-plan.md`,
`2026-10-17-equity-data-source-matrix.md` and `2026-10-17-equity-verification-checklist.md`.
The planner does not build. A builder implements this; the planner verifies against section 8.

## 1. Purpose and non-goals

Purpose: start collecting equity data now, cheaply and safely, and give the owner a page to see and manage the
stocks being collected. Slice 0 is the first step of the equity module, not a separate product. Everything it
stores is reused by the full build later (raw landing, first-seen timestamps, source health).

Slice 0 delivers:
1. A watchlist (add, remove, list) for NSE/BSE stocks, single user, no login.
2. A daily end-of-day collector: price bars, dividends/splits, Yahoo fundamentals (secondary), all landed raw first.
3. A source-health record of how reliable Yahoo is over time (feeds the full-build go/no-go).
4. A sidebar entry "Equity Watch" opening a page with the visible stocks and an add box.

Non-goals (stay out, each belongs to a later phase): valuation, filings import, XBRL parsing, LLM reports,
forecasts, ISIN-based identity, intraday history, alerts, news linking, any Fyers call, any login, any trading link.

## 2. Hard rules (inherited, restated because they decide design)

* No coupling: `apps/api/src/modules/equity-research/` imports nothing from paper-trading, strategy-engine,
  risk-management or any order path. A test enforces it.
* Own schema: every table lives in a dedicated Postgres schema `equity_research`, with no foreign key to or from
  any other schema. Reason: the discarded Stock Intelligence schema could be archived and dropped in one step
  (2026-10-17) because it was self-contained. Keep that property.
* Fyers is never used. Equity data comes from Yahoo only, through one per-host gate.
* Land first, parse later. Raw response bytes, hash, status and timestamp are stored before interpretation.
* Yahoo `close` plus dividend/split events are stored. Yahoo `adjclose` is NOT requested or stored (it back-propagates
  dividends, see our migration 027 audit). Note (verifier, 2026-10-17): Yahoo `close` is itself adjusted (split and
  apparently rights issues), so it is called `close` or `adjusted-for-capital-actions close`, never "raw" (matrix section 7).
* Every shown number carries source, as-of timestamp and a label: DELAYED, LAST-TRADED or PREVIOUS-CLOSE. No
  label may claim real-time.
* No retry on a rate-limit (HTTP 429 or equivalent); circuit breaker; per-endpoint cooldown, never global
  (lesson of the Fyers incident 2026-10-16).

## 3. Data collected

| Data | Call | When | Stored as |
|---|---|---|---|
| Daily bars (raw close, volume) | Yahoo `v8/finance/chart/{SYM}.NS`, `interval=1d`, `range=1mo`, `events=div|split` | Daily after the close; one call also returns events | raw record, then `equity_price_bars` and `equity_corporate_actions` |
| One-time history on add | Same call with `range=max`, `interval=1d` | Once when a stock is added | raw record, then the same tables |
| Fundamentals (secondary) | Yahoo `ws/fundamentals-timeseries`, annual* and quarterly* item set used in the 2026-10-17 probe | Daily; a new row is written only when a value changes | raw record, then `equity_secondary_facts` |
| On-demand quote | Yahoo chart `meta` (last price, `regularMarketTime`) | Only when the page is open, cached 15 min, only inside market hours | `equity_quote_cache`, plus a latency sample in source health |

Call budget (my arithmetic): at most 3 calls per stock per day, so a 50-stock cap is at most 150 calls/day at
1 request/second, about 2.5 minutes of work. Hard cap of 50 active stocks (configurable) and a per-day request
budget of 300 enforced by the gate. The cap exists so a mistake cannot become a quota problem.

The on-demand quote path doubles as the measurement for open verification 1 in the data-source matrix: every
quote fetch records `regularMarketTime` against wall clock, so Yahoo's real NSE latency is learned from use.

## 4. Schema (schema `equity_research`, migration numbered at build time)

The latest migration in the repo on 2026-10-17 is 137; the builder takes the next free number after re-checking.
Additive only. All tables new. SQL-literal test must pass.

* `watchlist_stock`: id, exchange (NSE|BSE), symbol, yahoo_symbol, display_name (from Yahoo meta), currency,
  active, note, added_at, removed_at. Unique (exchange, symbol). Removal sets active=false and keeps all history.
  ISIN is deliberately absent: Yahoo does not provide it; it arrives with the full build's identity phase.
* `raw_record`: id, source, endpoint, symbol, requested_at, http_status, body_sha256, body (jsonb), outcome
  (OK|EMPTY|RATE_LIMITED|ERROR), warnings. Never updated after insert.
* `price_bar`: stock_id, bar_date, open, high, low, close, volume, source, raw_record_id, first_seen_at.
  Unique (stock_id, bar_date). A later fetch that differs for an existing date is written to a revisions table
  (below), not overwritten: Yahoo does restate bars.
* `price_bar_revision`: stock_id, bar_date, previous values, new values, seen_at, raw_record_id.
* `corporate_action`: stock_id, ex_date, kind (DIVIDEND|SPLIT), value, source, raw_record_id, first_seen_at.
  Unique (stock_id, ex_date, kind).
* `secondary_fact`: stock_id, item, period_type (ANNUAL|QUARTERLY), period_end, value, currency, raw_record_id,
  first_seen_at. A new row only when the value for (stock_id, item, period_type, period_end) differs from the
  latest stored value, so the history of restatements accumulates. Basis (consolidated/standalone) is recorded as
  UNKNOWN because Yahoo does not say; that is a stored fact, not an omission.
* `quote_cache`: stock_id, last_price, market_time, fetched_at, label, latency_seconds.
* `source_health`: source, endpoint, last_success_at, last_failure_at, status, consecutive_failures, calls_today,
  budget_today; plus `source_call_log` (one row per call: time, endpoint, status, duration) for the later
  reliability analysis.

## 5. Components (module `apps/api/src/modules/equity-research/`)

* `domain/`: symbol validation, state derivation (OK | STALE | NEVER_FETCHED | UNAVAILABLE), label rules. Pure.
* `infrastructure/yahoo-client.ts`: the only code that talks to Yahoo. Per-host gate (1 req/s), request budget,
  no retry on rate-limit, breaker, per-endpoint cooldown, request counter logged every 5 minutes, every call
  recorded in `source_call_log`. Symbols are validated against `^[A-Z0-9&-]{1,20}$` before being put in a URL
  (no free-form text reaches the request).
* `infrastructure/` repositories for the tables above.
* `application/`: `addStock` (validate by a real chart call, land raw, backfill, return), `removeStock`,
  `collectEndOfDay` (per stock; one stock failing never stops the others), `getWatchlistView`.
* CLI `collect-equity-eod.ts` plus scheduler job `EQUITY_EOD_COLLECT`. The scheduler job needs, as for the ICT
  shadow jobs: an `ABANDONED_AFTER_MS` entry, a cron schedule (weekdays, about 17:00 IST, after the close and
  after the Yahoo daily bar is final), and an entry in the hand-maintained job manifest list.
* Routes under `/api/v1/equity/`: `GET watchlist`, `POST watchlist` (symbol, exchange), `DELETE watchlist/:id`,
  `GET watchlist/:id/detail`, `GET source-health`. zod on every input. No auth (single user), reachable only on
  localhost, see gate S6.

## 6. Sidebar and page: the design

My view: the sidebar entry should open a page, not list the stocks in the rail itself.
* The sidebar is a navigation rail that collapses to icons; fifty stock rows would crowd it on every page and
  change a shared layout that all other screens depend on.
* A page can hold what the owner asked for: the visible stocks, a box to add more, and per-stock state.
* If the owner later wants a quick glance, an optional compact "pinned" list (max 5, shown only when the rail is
  expanded) can be added without redesign. Not in Slice 0.

Concrete change: in `apps/web/src/components/layout/sidebar.tsx` add a section `EQUITY` with one item
`Equity Watch` -> `/equity` (a lucide icon such as `LineChart`). Check `mobile-sidebar.tsx` and the dashboard
`layout.tsx` so the item also appears on phone width. Route `apps/web/src/app/(dashboard)/equity/page.tsx`,
feature code in `apps/web/src/features/equity/` (no formulas in components).

Page contents:
1. Header: "Equity Watch", count of stocks, last collection time, source status badge (Yahoo OK / degraded / down).
2. Add box: symbol field plus NSE/BSE selector, "Add" button. Adding validates with a real fetch and shows the
   result: found (name, currency, exchange) or a specific error (not found, rate-limited, already in list, list
   full). Nothing is added if validation fails.
3. Table: symbol, name, last close, change %, as-of date/time, label (PREVIOUS-CLOSE / DELAYED / LAST-TRADED),
   state badge, history depth (first bar date), data-gap flag, remove button (with confirm).
4. Row detail (drawer or page): a price chart from stored bars, dividends/splits list, the secondary fundamentals
   table clearly headed "Secondary, from Yahoo, not verified", and the stock's own collection log.
5. Every state is designed: loading, empty ("add your first stock"), error, stale, source-down, add-failed.

Seeding: nothing is seeded by migration. The owner adds SUZLON through the page. Peers are not hard-coded
anywhere (the checklist rule against hard-coded company data applies).

## 7. Operational notes

* Stack dependency: API, web and scheduler containers must be running to deploy and to collect; at the time of
  writing only the database container is up.
* Deploy order: migration -> API image -> scheduler -> web image; use a clean worktree, not the dirty main checkout
  (Docker build context includes untracked files, see memory), and `-p aiquantlab --env-file .env`.
* Size: raw landings are the growth risk (the biggest table in the old schema was TOAST). My rough estimate is a
  few tens of MB per year at 50 stocks; this is an estimate and gate S9 measures it.
* Weekends and exchange holidays produce no new bar and must not raise failures. If the repo has a trading
  calendar the collector should use it; if not, "no new bar on a weekday" is recorded as EMPTY, not ERROR.

## 8. Acceptance gates for the verifier

Evidence format as in the checklist (PASS / FAIL / UNVERIFIED with command output). All of G1, G3 to G9 of the
checklist apply; those below are specific to Slice 0.

* S1 Identity and validation: add SUZLON (NSE) works; adding it again is rejected as a duplicate; `SUZLON;DROP`,
  an empty string, 21 characters and lower-case junk are rejected before any network call (verify no request was
  made); an unknown symbol returns not-found and stores nothing; BSE and NSE listings of one company are two
  rows, not merged.
* S2 Raw first: for one collection run, every row in `price_bar`, `corporate_action` and `secondary_fact` points at
  a `raw_record` whose hash matches its stored body; deleting derived rows and re-running the parse from stored
  raw (network disabled) rebuilds identical rows.
* S3 Idempotent: running the daily collector twice in a row creates no duplicate bars, actions or facts; the second
  run's new rows are zero.
* S4 Restatement handling: the verifier plants a changed bar and a changed fundamental value in a fixture response;
  the old values survive in `price_bar_revision` / as earlier `secondary_fact` rows, nothing is overwritten.
* S5 Adjustment policy: grep the client and tables for `adjclose`; none requested or stored. For one known split and
  one known dividend of SUZLON the verifier recomputes an adjusted figure by hand from raw close plus events.
* S6 Localhost and no auth: compose ports for web, API and DB are bound to 127.0.0.1 (a test asserts it); the
  equity routes are not reachable from another host; no secret in the browser bundle.
* S7 Rate discipline: force a 429 against a fake host; exactly one request is sent, the endpoint cools down, other
  endpoints keep working, the UI shows the source state, and the collector logs the counter. Kill the host
  entirely: the page shows "source unavailable", never a stale number under a fresh label.
* S8 Failure isolation: make one stock's symbol fail; the other stocks still collect; the failed one shows
  UNAVAILABLE with the reason.
* S9 Growth: after 7 real days of collection the verifier reports table sizes (`pg_total_relation_size` for
  `equity_research.*`) and the extrapolated yearly size; above 200 MB/year triggers a retention decision.
* S10 No coupling: the import test exists and fails when an import from a trading module is added (verifier tries).
* S11 Sidebar and page: the item appears expanded, collapsed (icon with tooltip) and at phone width, shows the
  active state on `/equity`, and the page's six states are each forced and screenshot-checked. Adding and removing
  a stock through the UI works end to end; removal keeps history in the database.
* S12 Scheduler: the three registration points exist (abandon horizon, cron, manifest); the job appears in the
  scheduler log on its first scheduled run; a trading-day run is checked against a manual Yahoo call for three
  bars.
* S13 Real run on record: one real collection against live Yahoo for SUZLON with its output saved. A mocked-only
  claim is reported as mocked.
* S14 Regression: full API and web test suites, typecheck and lint pass; test counts before and after are reported.

Red flags: any quote shown without a timestamp; a symbol concatenated into a URL without validation; a cron that
retries a 429; tables outside the `equity_research` schema; fundamentals shown without the "secondary" heading;
Yahoo numbers labelled as real-time.

## 9. Effort (builder estimate, planner's arithmetic)

| Item | Days |
|---|---|
| Migration, repositories, schema tests | 0.5 to 1 |
| Yahoo client with gate, budget, breaker, call log | 1 |
| Collector, CLI, scheduler registration | 0.5 to 1 |
| API routes with zod | 0.5 to 1 |
| Web page, add box, detail, sidebar | 1 to 1.5 |
| Tests and verifier fixes | 0.5 to 1 |
| Total | 4 to 6.5 |

This is slightly above my chat estimate of 3 to 5 days because the page was added. The page is the largest
single piece and can be shipped last: collection starts as soon as the API side lands.

Suggested order so collection starts early: 1) migration + client + collector + scheduler, 2) API routes,
3) page and sidebar. Verify each step before the next.

## 10. After Slice 0

* After about 7 days: size report (S9) and the first Yahoo reliability read.
* After 2 to 3 months: decide the full build with real reliability data, and run Phase 0 (one real Suzlon results
  XBRL parsed and reconciled) before that decision.
* The first trading-day check of the on-demand quote latency closes open verification 1.
