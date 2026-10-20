# Equity Intelligence: verification checklist (planner as verifier)

The planner does not build. When a phase is declared done, the planner checks it against this list and reports each
gate as PASS, FAIL or UNVERIFIED with the evidence (command output, SQL result, file and line). A phase is accepted
only when every gate is PASS or an UNVERIFIED gate is explicitly waived by the owner. "Tests pass" is never
accepted alone: tests written by the builder can pass on mocked data while the feature is wrong.

## 0. How evidence is judged

1. Re-run, do not read. The verifier runs the test suite, typecheck and the real-data command itself.
2. Independent recomputation. For numerical features the verifier recomputes at least five values by hand from
   source documents (not from the builder's fixtures) and compares.
3. Real vs mocked. Every test is labelled UNIT, MOCKED-INTEGRATION, PROVIDER-INTEGRATION (real network) or E2E.
   Provider and E2E claims need a real run on record with its output saved.
4. Negative tests. The verifier tries to break each rule (see the red flags) rather than only confirming it works.
5. Claims in docs are checked against the code and the database, not trusted.

## 1. Gates that apply to every phase

* G1 No trading coupling: a test fails if `equity-research` imports `paper-trading`, `strategy-engine`,
  `risk-management` or any order path; the verifier greps imports and tries adding one.
* G2 No hard-coded financials: grep the module and fixtures for Suzlon prices, revenue, order-book or targets; every
  such figure must come from a stored source row or a clearly named test fixture.
* G3 Labels: every number shown carries source, timestamp, and one of REAL-TIME / DELAYED / LAST-TRADED /
  PREVIOUS-CLOSE / SIMULATED. Simulated data is visibly marked everywhere it appears.
* G4 No silent substitution: kill a provider (bad host) and confirm the UI shows the failure state, not another
  provider's value under the same label.
* G5 Localhost: compose ports for API, web and DB remain `127.0.0.1`; a test asserts it (the tool has no login).
* G6 Secrets: `.env.example` has no real values; grep logs and report output for key patterns; keys never reach the
  browser bundle.
* G7 Migrations: additive, numbered after the latest existing one (137 on 2026-10-17), pass the SQL-literal test, apply cleanly to a copy of the live DB.
* G8 Full suite, typecheck and lint green; count of tests before/after reported.
* G9 Every external call goes through the per-host gate with budget, no retry on rate-limit, breaker, per-endpoint
  cooldown, and a request counter (see the data-source matrix, section 5). Verifier forces a 429 and watches.

## 2. Per phase

### Phase 0 Feasibility
* Written go/no-go exists. The open verifications in the data-source matrix section 6 are each PROBED, with output.
* A real quote, a real Suzlon results filing and a real corporate action were fetched by code (not by hand).
* Recovery note on Gate 7 is accepted as already done (plan section 3).
* RED FLAG: a "verified" source with no recorded response.

### Phase 1 Foundation
* Identity: ISIN-first, then (exchange, symbol); two listings of one company map to one company, two securities.
  Verifier adds a duplicate and a second share class and checks the result.
* Watchlist CRUD with tags, favourite, note, multiple lists; deleting a watchlist does not delete a security.
* RED FLAG: matching on company name; a watchlist that stores prices.

### Phase 2 Market data
* Adjusted series: for a known split and a known dividend the adjusted prices equal hand calculation. The series
  uses raw close plus events, NOT Yahoo `adjclose` (check the request and the stored columns).
* Stale / missing / auth failure / holiday / weekend states each render as their own state.
* Quote label correct on a TRADING day: the verifier compares `regularMarketTime` to wall-clock and checks the
  DELAYED label and age are right.
* Corporate actions reconciled against exchange announcements for Suzlon; any bonus treated correctly.
* RED FLAG: any quote shown without a timestamp; fake demo price without the SIMULATED mark.

### Phase 3 Filings and documents
* Raw landing: bytes and hash stored before parsing; re-importing the same file creates no second fact set;
  a revised filing creates a new revision, not an overwrite.
* Reprocess from storage works with the network disabled.
* Extraction on three real Suzlon filings (XBRL and PDF): verifier compares at least 10 extracted numbers per file to
  the document, including units (crore vs lakh vs rupees).
* Ingestion log shows failures, warnings and retries; source-health page matches the log.
* RED FLAG: a parser that guesses units; a PDF number accepted without a cross-check against the XBRL or statement
  identities (assets = liabilities + equity).

### Phase 4 Fundamentals
* Every metric states formula, inputs, period, basis, source and state (OK / NOT_MEANINGFUL / UNAVAILABLE).
* Negative earnings, zero denominators and restated periods produce states, not numbers (verifier feeds them).
* Consolidated and standalone never mix: a query that mixes bases must fail a test.
* `known_at` is the filing broadcast time, NOT the period end: verifier checks 5 rows.
* Reconciliation: filed numbers vs Yahoo secondary, mismatch above tolerance raises a warning and is visible.
* RED FLAG: ratios computed by the LLM; `known_at = period_end`.

### Phase 5 Projects and guidance
* Each project row has status (spec enum), source passage and last-verified date; MOU vs contract vs under
  execution vs revenue recognised stay distinct. Verifier walks one order through the lifecycle.
* Conflicting sources produce two claims shown side by side, not a merged "best" one.
* RED FLAG: an announced order counted as revenue; a status with no evidence.

### Phase 6 Peers and valuation
* Each method's formula has unit tests; assumptions (growth, margin, discount rate, terminal growth, share count,
  net debt) are shown; sensitivity grid recomputes correctly (verifier recomputes three cells).
* Peer list has a stated reason per peer; method choice follows a written rule, not the LLM.
* "Priced in" check reproduces the implied growth by hand for one stock.
* RED FLAG: one valuation method forced onto every company; terminal value dominating with no warning.

### Phase 7 Scenarios and validation
* Forecast snapshots are immutable: the verifier attempts an UPDATE and a delete and both fail; first writer wins.
* Point-in-time: any backtest reads only facts with `known_at <= as_of`; verifier plants a future fact and confirms
  it is ignored.
* Baselines present (naive drift, market/sector, peer median) and results reported against them.
* Output states are honest: scenario illustrations labelled as such; statistical forecast shows
  INSUFFICIENT_EVIDENCE unless a pre-registered evaluation supports more.
* RED FLAG: probabilities without calibration data; directional accuracy used as the headline.

### Phase 8 LLM reports
* Every rendered claim has a stored source passage; a claim without one cannot render (verifier deletes a passage
  and re-renders).
* Prompt-injection corpus (instructions hidden in a PDF, HTML comment, transcript) does not change output or leak
  secrets; verifier writes new cases, not only the builder's.
* The report reproduces from stored inputs (same input snapshot ids gives the same facts and numbers).
* Numbers in prose equal the computed values (verifier diffs 10).
* RED FLAG: the LLM output contains a number not present in any input.

### Phase 9 Frontend
* Each screen shows loading, empty, error, stale and insufficient-evidence states; verifier forces each.
* No business logic in components (grep for formulas in `apps/web`).
* Responsive check at phone width.

### Phase 10 Hardening and E2E
* The E2E journey (search Suzlon -> add -> quote -> financials -> disclosures -> milestones -> report -> three
  horizons or INSUFFICIENT_EVIDENCE -> reopen and reproduce) is run by the verifier against REAL providers, with the
  output recorded. A mocked run is reported as mocked.
* Security pass: input validation on every route, upload validation, no secrets in logs.
* Docs match reality: the six spec documents exist and each claim in them is spot-checked.

## 3. Report format the verifier returns

```
Phase N: ACCEPTED | REJECTED | ACCEPTED WITH WAIVERS
Gates: G1 PASS (evidence) ... G9 UNVERIFIED (reason)
Independent checks: 5 values recomputed, N matched, list mismatches
Real vs mocked: what ran on live providers
Defects found: numbered, with file/line or SQL
Waivers requested from the owner: ...
```

## 4. Annual Operations Checklist (Year-End Maintenance)

### Year-End NSE Calendar Refresh
* **Action**: Prior to December 20, 2026 (before January 1, 2027), fetch the official NSE Trading Holidays circular for the forthcoming year (Calendar Year 2027) from the National Stock Exchange of India.
* **SQL Seeding**: Insert the new holiday dates into the `nse_holidays` table with valid holiday date, official description, and verified provenance.
* **Verification**: Run `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name FROM nse_holidays WHERE holiday_date >= '2027-01-01' ORDER BY holiday_date ASC;` and confirm that all exchange closures are recorded.
* **Provenance Rule**: Cite only the official exchange circular reference number actually inspected. Never extrapolate or cite unverified circular numbers.

