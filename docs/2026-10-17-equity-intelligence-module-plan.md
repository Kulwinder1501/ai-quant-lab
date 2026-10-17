# Equity Intelligence module: fit assessment, plan and effort

Status: PROPOSAL for decision. Nothing here is implemented. Written 2026-10-17 from a read of the repository and
database schema; external provider documentation (NSE/BSE, Fyers, Kite, fundamentals vendors) has NOT been read
and every provider statement below is marked "to verify".

## 1. Verdict in three lines

1. The spec is a different product from this engine. The engine is an intraday NSE index-derivatives trading and
   research system; the spec is a multi-month fundamental research platform for listed equities. They share
   infrastructure, not domain logic.
2. It fits as a NEW bounded module (`equity-research`) that reuses the platform plumbing and the validation
   culture, and shares nothing with the trading path. Nothing in it may be able to place or influence an order.
3. The part most likely to disappoint is the one the spec leans on hardest: statistical price forecasts. This
   repository already built one and discarded it (section 3). The plan therefore ships price outcomes as
   explicit valuation scenarios, with statistical forecasts defaulting to `INSUFFICIENT_EVIDENCE` until measured.

## 2. What already exists and can be reused

| Need in the spec | What we have | Reuse |
|---|---|---|
| Web shell, sidebar, pages, charts | Next.js 16 / React 19, Zustand, lightweight-charts, recharts; sidebar + dashboard pages (journal, news, portfolio, ...) | Direct: add pages and a sidebar group |
| API | Express 4 + zod, module-per-domain layout (`modules/<x>/{domain,application,interfaces}`) | Direct: new module in the same shape |
| Database | Postgres 16 + pgvector image, versioned migrations (latest 136), migration SQL-literal test | Direct. pgvector is already in the image |
| Securities directory | `instruments` (exchange, symbol, ISIN column, `findByIsin`, lot/strike metadata, `is_active` gating the scanner) | Extend, do not replace (see 5.1) |
| Live equity quotes | Fyers live provider, quote client, live-quote cache, streamer; Kite provider code | Reuse the live-quote cache and websocket only; Fyers REST is NOT for this module (5,000/day shared with trading, see section 6) |
| Daily history | `candles` (1d) via Fyers/Kite/Yahoo/CSV providers, provenance columns | Reuse for price series |
| Calendar / sessions | `NseMarketSession`, holiday tables, IST helpers | Direct |
| Background jobs | Scheduler with job claim, abandonment horizons, run ledger (`scheduled_job_runs`) | Direct: add jobs |
| LLM | `gemini-client.ts` (REST, JSON mode, no default model) and the strict JSON contract validator pattern from the pre-market engine | Reuse the pattern; add citation-bearing schemas |
| Immutable forecast snapshots, baselines, scoring | Pre-market engine: first-writer-wins terminal snapshots, deterministic baselines, exact tests with Holm, UNCERTAIN as abstention | Reuse the design almost unchanged |
| News | RSS ingestion, `market_news`, macro-event checker | Reuse as secondary evidence only |
| Alerts | SSE notification stream | Reuse for thesis-change alerts |
| Governance culture | Pre-registration docs, PIT discipline, falsification write-ups | Adopt as the method for the forecast evaluation |

## 3. What the repository tells us about the hard part

* `d81faeb3` (2026-09-09) "discard Stock Intelligence feature code": an earlier engine (outcome distributions,
  analogue search, calibration, replay harness, a "Gate 7" acceptance test: ECE tolerance, Brier vs baseline,
  scenario coverage, tail rate, regime coverage) was deleted after Gate 7 failed. Migrations 099-104 are now
  tombstones. The stored Gate 7 reports (recovered 2026-10-17 before the schema was dropped; archived in
  `db-archive-2026-10-16/stock_intelligence_schema_full.sql.gz`) show WHY, on ~4,650 replayed stock/date pairs:
  8 of 10 criteria failed at both the 6M and 12M horizons. Only 'no look-ahead' and 'reproducible' passed.
  Calibration ECE 0.215 (6M) / 0.264 (12M) vs 0.10 tolerance; Brier 0.310 / 0.332 vs 0.246 / 0.243 for simply
  predicting the base rate (the model was WORSE than the trivial baseline, p~0); median absolute error 0.178 /
  0.269 vs 0.131 / 0.199 for the same-date median; actual returns fell below the model's 10th percentile 19-20%
  of the time (should be 10%); 35% of pairs were censored (survivorship). The code is in git at `d81faeb3^`.
* Project-wide measured evidence (memory index): k-NN/analogue retrieval lost to trivial baselines and matched
  shuffled labels; direction prediction showed no tradable edge on index data; several models "looked good"
  on macro-F1 and failed baselines. Those results are on intraday index data, not 6-24 month single stocks, so
  they do not prove the spec's forecasts cannot work. They do mean the burden of proof sits with the model.
* Statistical reality: 6/12/24-month forecasts for tens of stocks give very few independent observations
  (cross-sectional returns are highly correlated; a 24-month horizon yields about 1 independent point per stock
  per two years). Validation by elapsed time cannot be sped up by engineering.

Consequence for scope: build the fundamentals, evidence and valuation machinery (which is deterministic and
testable now) and treat the price-forecast layer as a measured, probably-negative research question.

## 4. Gaps (things the spec needs that do not exist)

1. Fundamentals data: no statements, no restatement history, no point-in-time availability dates. Largest gap.
2. Corporate actions: the old adapter was deleted with Stock Intelligence. Nothing ingests splits/bonuses/dividends.
3. Document pipeline: no document table, no object storage, no PDF text/table extraction, no OCR.
4. User model: the API has no authentication. The spec's "private watchlists", access control and holdings
   privacy are meaningless for a single-user local tool and a real project if it becomes multi-user. Decision D3.
5. Personal watchlists: the existing "watchlist" is the scanner's instrument list, not a user's list.
6. Embeddings/RAG for documents: pseudo-embeddings were removed (migration 012); the AEDLS session is building
   pgvector/HNSW retrieval for a different purpose. Coordinate, do not merge.
7. Peer sets, sector taxonomy and benchmark/sector indices.
8. Licensing: see 6.

## 5. Proposed design

### 5.1 Identity
New `equity_securities` (internal stable id) with ISIN, exchange listings (NSE/BSE symbols, series), share class,
status, and a nullable link to `instruments.id` so price history, quotes and candles are reused. Company
(`equity_companies`) is separate from security because one company has several listings and share classes.
Duplicate detection by ISIN first, then (exchange, symbol); never by name.

### 5.2 New module layout
`apps/api/src/modules/equity-research/` with `domain/` (pure: metrics, valuation, scenarios, evidence model),
`application/` (use cases), `interfaces/http/`. A Python worker (extends `apps/ml`) does PDF/table/OCR and any
numerical research; it writes only through the API's repositories or its own tables.
Hard boundary: no import from `paper-trading`, `strategy-engine` or `risk-management`, enforced by a lint/test
like the existing quarantine guard. The module cannot reach an order path.

### 5.3 Data model (all migrations additive, numbered after 136)
`equity_companies`, `equity_securities`, `equity_watchlists`, `equity_watchlist_items` (tags, favourite, note),
`equity_positions` (optional), `equity_corporate_actions`, `equity_filings` (document registry: URL, publisher,
published_at, retrieved_at, period, type, content_hash, revision_of, status, warnings),
`equity_filing_chunks` (page/section refs, embedding), `equity_financial_facts` (company, period, basis
CONSOLIDATED|STANDALONE, line item, value, unit, currency, origin REPORTED|CALCULATED|ESTIMATED, restated_from,
`known_at` = date it became public), `equity_metric_values` (formula id + version, inputs, state
OK|NOT_MEANINGFUL|UNAVAILABLE), `equity_claims` (text, class FACT|MANAGEMENT|THIRD_PARTY|INFERENCE|UNRESOLVED,
evidence passage, strength, verification), `equity_projects` (status enum from the spec + history rows),
`equity_valuations`, `equity_forecast_snapshots` (immutable, first writer wins), `equity_forecast_outcomes`,
`equity_reports` (versioned, with input snapshot ids), `equity_source_health`.

### 5.4 Calculation and forecasting
* Metric functions are pure, versioned and unit-tested; they return a state, never a misleading number
  (negative earnings, zero denominators, accounting changes).
* Valuation engine: DCF, P/E, EV/EBITDA, P/B, SOTP, dividend, with every assumption exposed and sensitivity grids.
  Method chosen per company type by explicit, reviewable rules (not by the LLM).
* Scenario engine turns stated assumptions into bear/base/bull values at 6/12/24 months. These are labelled
  "scenario illustrations". No probabilities unless calibrated on enough outcomes.
* Statistical models are shadow-only until they beat naive baselines (random walk with drift, sector/market
  beta, peer-median) out of sample, using the pre-market engine's baseline/scoring/Holm machinery and a
  pre-registered protocol. Default output: `INSUFFICIENT_EVIDENCE`.
* PIT: facts carry `known_at`; any backtest reads only facts with `known_at <= as_of`.

### 5.5 LLM layer
Gemini behind a provider interface. Extraction and synthesis only; never calculates metrics or prices.
Every claim stores its source passage; reports are assembled from stored claims, so an uncited claim cannot be
rendered. Retrieved text is treated as untrusted: delimited, no tool access, instruction-like content flagged,
output validated against a strict schema (the same fail-closed validator pattern as the pre-market contract).
Conflicting sources are stored as separate claims and shown side by side.

### 5.6 UI
Nine screens from the spec as a "Research" sidebar group. Business logic stays server-side; components render
state (loading / empty / stale / error / insufficient-evidence are first-class states).

## 6. Data sources and licensing

Fully worked out, with what was PROBED versus only READ, in
`2026-10-17-equity-data-source-matrix.md`. Summary of what changed after checking:

* Yahoo price history, dividends and splits: PROBED and good (Suzlon back to 2005, TCS 2002, Reliance 1995).
* Yahoo fundamentals: PROBED and thin: about 4 annual and 5 quarterly periods, no receivables, no
  consolidated/standalone flag, no filing dates. Useful as a cross-check, not as the source of truth.
* NSE's Terms of Use prohibit automated collection from its website and no public XBRL/announcement API was
  found; BSE's terms were not found. So authoritative filings come in by user-assisted import (download, drop,
  or paste a URL), not a crawler. The existing `nse-api-client` has the same compliance exposure and should not
  be reused for equities.
* Free fundamentals APIs checked (Financial Modeling Prep, Twelve Data): no confirmed India coverage on a free
  plan. Screener's export is paid. Rejected under the "free only" rule.
* Fyers REST is off limits for the equity watchlist: our Standard plan measured 5,000 requests/day and was
  exhausted on 2026-10-16. Equity quotes come from Yahoo (labelled DELAYED); Fyers websocket is a candidate to
  test.

## 7. Phases, deliverables, acceptance, effort

Effort unit: engineer-days for one full-stack engineer working with AI assistance. Ranges, not promises;
the widest ranges are where an external data decision is unresolved.

| Phase | Deliverable | Acceptance (tested) | Days |
|---|---|---|---|
| 0 Feasibility and decisions | Provider verification, recovery of why Gate 7 failed, source inventory for Suzlon, answers to D1-D5, docs set | Written go/no-go; a real quote, a real result filing and a real corporate action retrieved by code | 4-6 |
| 1 Foundation | Schema (companies/securities/watchlists), identity resolution, search, watchlist CRUD, notes/tags, stock page shell, sidebar group | CRUD + identity + duplicate/share-class tests; boundary test (no trading imports) | 6-9 |
| 2 Market data | Equity quote adapter with freshness states, daily history, corporate-actions ingestion, adjusted series, benchmark/sector, dev mock clearly labelled | Stale/missing/auth-failure/holiday tests; adjusted-price tests against known splits; no fake price shown as live | 7-11 |
| 3 Filings and documents | Document registry, fetch with retry/dedup/hash/revisions, storage, PDF text+table extraction, OCR path, ingestion monitor and reprocessing | Dedup, extraction-failure, unit-validation tests on real filings; source health page | 12-20 |
| 4 Fundamentals | Normalised statements (consolidated vs standalone), restatements, `known_at`, 40-60 metric functions with states | Formula tests incl. negatives/zero denominators; period alignment; no silent basis mixing | 10-15 |
| 5 Projects and guidance | LLM-assisted extraction of orders/projects with citations, lifecycle statuses, guidance-vs-outcome tracker | Status-transition tests; every project row has a source; conflicts preserved | 8-12 |
| 6 Peers and valuation | Peer selection (curated + rules, with reasons), valuation methods, sensitivity, "priced-in" check | Formula tests; method-selection rule tests; assumptions visible | 10-15 |
| 7 Scenarios and validation | Scenario engine, immutable snapshots, revision log, outcome capture, baselines, pre-registered evaluation | Snapshot immutability; no-look-ahead (PIT) tests; baseline comparison | 8-12 |
| 8 LLM research reports | RAG with citations, claim ledger, conflict surfacing, injection defence, 18-section report, versioned and reproducible | Prompt-injection corpus; citation-required rendering; reproduce a saved report from stored inputs | 10-15 |
| 9 Frontend | Nine screens, comparison, timeline, admin, evaluation | State coverage tests (loading/empty/error/stale); responsive check | 14-22 |
| 10 Hardening | Security pass, perf, E2E journey (search -> report -> reopen), deploy docs, `.env.example` | The E2E journey on real providers where credentials exist; mocked runs labelled as such | 8-12 |
| Total | | | about 97-149 |

Calendar for one person: roughly 5-7 months for everything. Phase 3 and Phase 4 are the schedule risk
(document variety, OCR and XBRL quirks, vendor decision).

### MVP vertical slice (recommended first release, "Suzlon end to end")
Phases 0-2, a reduced 3 (exchange announcements and quarterly/annual results only), a reduced 4 (annual and
quarterly statements, core 20 metrics), a reduced 5 (order/project tracker from announcements), 6 with multiples
and a simple DCF, 7 snapshots with scenarios only (no statistical model), 8 report without the 18-section polish,
and the six most important screens. About 40-55 engineer-days, 8-11 weeks for one person. It proves the
pipeline on one company and exposes the data-source reality before the large spend.

### Elapsed time that engineering cannot remove
Forecast evaluation needs outcomes: first 6-month readings arrive 6 months after launch, 12-month at one year,
24-month at two. Until then every statistical forecast is `INSUFFICIENT_EVIDENCE`, and a backtest needs
point-in-time fundamentals for several years, which exist only if the data source in Phase 0 provides them.

## 8. Risks

1. Data access and licensing may constrain or cancel parts of the spec (largest).
2. Document extraction accuracy: a wrong extracted number silently corrupts every metric; needs cross-checks
   (statement identities, unit validation, reconciliation against a second source).
3. LLM misreading and injection; mitigated by storage-first, citation-required rendering and fail-closed schemas,
   not by prompt wording.
4. Forecasts that look credible and are not. Mitigation: scenario labelling, baselines, pre-registration.
5. Scope creep from the spec's breadth (9 screens, 18-section report, multi-market). Mitigation: MVP slice.
6. Compliance: personal research is one thing; offering a personalised Buy/Hold/Sell to others under Indian
   securities law needs legal review before it is enabled. Ship without personalised recommendations.
7. Operational: the stack runs on a laptop that has been put into standby and has just had every container
   stopped; ingestion needs to tolerate gaps and catch up.

## 9. Decisions (answered by the owner 2026-10-17)

* D1 Scope: FULL BUILD (the MVP slice in section 7 stays as the first internal milestone, not the scope).
* D2 Data policy: Yahoo accepted. NSE/BSE: no automated collection; user-assisted import only (see the matrix).
  The owner accepts Yahoo's terms risk for personal use; this is not legal advice.
* D3 Users: SINGLE USER, no login. Safe only while API, web and DB stay bound to 127.0.0.1 (they are today in
  `docker-compose.v2.yml`); verification gate G5 keeps it that way. Saves the 8-12 days of multi-user work.
* D4 Fundamentals, free: two layers. PRIMARY = exchange-filed XBRL/PDF by assisted import (authoritative,
  consolidated/standalone, has filing time). SECONDARY = Yahoo timeseries for bootstrap, cross-check and gaps,
  always labelled. Reason and trade-offs in the matrix, section 3.
* D5 Forecast stance (owner unsure, so the planner's default applies; change it any time): price outcomes are shown
  as valuation SCENARIOS, i.e. "if earnings grow X and the market pays Y times, the price would be Z". They are
  what-ifs, not predictions. Any statistical or machine-learned price forecast stays hidden and says
  INSUFFICIENT_EVIDENCE until it beats simple baselines on data it has never seen. Why: the earlier engine here was
  worse than just predicting the base rate (section 3), so a confident-looking number would mislead.
* D6 AEDLS: kept separate. No shared schema, code or retrieval index. A one-line note in each project's docs
  records the boundary.

## 10. Effort after the decisions

Total stays about 100-155 engineer-days for the full build (Phases 0-10 in section 7). Changes versus the first
estimate: single user removes the optional 8-12 day auth work; assisted import adds an import screen and an XBRL
parser (+6-10 days in Phase 3) and removes a crawler with its anti-bot upkeep (-4-8 days); Yahoo adapters and the
reconciliation layer are in Phases 2 and 4. Biggest remaining uncertainty: Ind-AS XBRL taxonomy mapping and the
quality of real Suzlon filings, which Phase 0 must test before the estimate is trusted.

## 11. Roles

The planner (this document set) plans, writes acceptance gates and verifies. It does not build. Builders implement
a phase and hand over the artifacts listed in `2026-10-17-equity-verification-checklist.md`; the planner re-runs,
recomputes and reports ACCEPTED, REJECTED or ACCEPTED WITH WAIVERS per phase.

## 12. First step chosen (2026-10-17)

The owner chose to start with Slice 0 (collector, watchlist page, sidebar entry) before the full build; see `2026-10-17-equity-watch-slice0-plan.md`. The full-build decision waits for about 2 to 3 months of collected reliability data and a Phase 0 Suzlon XBRL parse.

## 13. Slice 1 chosen (2026-10-17)

The owner asked for a buy/sell/neutral suggestion. The planner recommended against any rating (no tested edge, see the Gate 7 memory) and wrote the descriptive trend panel instead: `2026-10-17-equity-trend-panel-slice1-plan.md`.
