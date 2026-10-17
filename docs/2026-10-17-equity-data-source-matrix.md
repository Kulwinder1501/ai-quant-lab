# Equity Intelligence: data source matrix and data flow

Written 2026-10-17 by the planner. Companion to `2026-10-17-equity-intelligence-module-plan.md`.
Every row says how it was checked. Three levels are used and must not be blurred:

* PROBED = I called it from this machine on 2026-10-17 and recorded what came back (one run, 4 tickers).
* READ = I read the publisher's own text or a search result describing it. Not called.
* UNVERIFIED = a claim I could not confirm. Do not build on it until it is promoted to PROBED.

Search results are secondary; where a row rests on one I say so. None of this is legal advice.

## 1. Decisions that shape the sources (from the owner, 2026-10-17)

Full build; Yahoo acceptable; single user; free data only; AEDLS kept separate. Forecast stance: see the plan (D5).
"Free" removes paid vendors and Screener's export (premium). That is what forces the layered design in section 3.

## 2. Matrix

| Need | Source | Status | What was found | Limits and compliance | Role |
|---|---|---|---|---|---|
| Daily/monthly price history | Yahoo `v8/finance/chart/{SYM}.NS` and `.BO` | PROBED | SUZLON.NS 253 monthly bars 2005-10 to 2026-10; TCS.NS from 2002; RELIANCE.NS from 1995; SUZLON.BO same depth, INR, exchange tags NSI / BSE | Unofficial, undocumented. Yahoo's terms (READ, 2025 regional version) bar automated collection without permission; the owner has accepted this risk for personal use. Not for redistribution | PRIMARY for prices (free) |
| Dividends and splits | Same chart call with `events=div|split` | PROBED | SUZLON 4 dividends + 1 split; TCS 90 + 3; RELIANCE 31 + 4 | Bonus issues may be reported as splits or missed: UNVERIFIED. Reconcile against exchange corporate-action announcements | PRIMARY, must be reconciled |
| Adjustment policy | Use raw `close` (already split-adjusted) and keep dividends as events | READ (our own migration 027 audit) | Yahoo `adjclose` back-propagates dividends: using it leaks future information | Compute total return ourselves from close + dividend events. CORRECTION 2026-10-17 (verifier): Yahoo `close` is NOT raw. It is back-adjusted for the split AND, by strong indirect evidence, for rights-type actions that are absent from the events list (see section 7) | Rule, not a source |
| Fundamentals (statements) | Yahoo `ws/fundamentals-timeseries` (annual*/quarterly* types) | PROBED | ANNUAL: 4 periods (FY2023 to FY2026, 2023-03-31 to 2026-03-31) for 10 of 11 requested items on all 4 tickers. QUARTERLY: 5 periods (2025-03-31 to 2026-06-30) for 8 to 10 of 11; patchy (Reliance quarterly debt/equity/inventory only 2 periods; Suzlon quarterly operating cash flow and capex absent). `Receivables` returned for none | Only about 4 years annual, below the spec's 5+. No consolidated/standalone flag, no publication date, no restatement history, so NOT point-in-time. Undocumented, can change | CROSS-CHECK and quick start only, always labelled secondary |
| Authoritative results (consolidated + standalone, with filing time) | NSE and BSE financial-results XBRL (Ind-AS taxonomy) and the PDF | READ | Filings are mandated in XBRL (BSE since 2017; since 2025-04-01 via the "Integrated Filing - Financial" utility, per BSE circular). NSE publishes taxonomy and lets investors download filings | No documented API, endpoint, rate limit or bulk mechanism was found. NSE's Terms of Use (READ) prohibit "systematic or automated data collection, including scraping" from the site and bar copying unless content is offered for download; its data products need a licence. BSE's terms: NOT FOUND, unverified. Support contacts seen in circulars: nsexbrl@nse.co.in, bse.xbrl@bseindia.com (ask about a programmatic route and terms) | PRIMARY truth, ingested by user-assisted import (section 3) |
| Announcements, order wins, contracts | NSE/BSE corporate announcements; company IR pages | READ (no API found) | Same position as above | Same compliance position | Primary evidence, assisted import or user-pasted links |
| Annual reports, presentations, transcripts | Company IR websites (PDF) | UNVERIFIED per company | Suzlon's IR layout and file naming have not been inspected | Company-published, publicly posted; fetch only user-supplied URLs | Primary, assisted import |
| Equity quotes | Fyers REST quotes | READ + OWN INCIDENT | Forum reports 10/s, 200/min, 100,000/day; OUR Standard plan measured 5,000/day, 50/min, 5/s and was exhausted at 11:04 IST on 2026-10-16 (memory note) | Shared with the trading system. Do NOT use REST quotes for the equity watchlist | Not used for bulk |
| Equity quotes | Fyers websocket | UNVERIFIED | Already used for index/F&O ticks; equity-symbol subscription limits and entitlement not checked | Needs a test on a trading day | Candidate for live prices of a small watchlist |
| Equity quotes | Yahoo chart `meta` (last price, time) | PROBED (schema only) | Market was closed (Saturday); latency on a trading day NOT measured | Typically delayed for NSE: UNVERIFIED | Default "DELAYED" quote with its own timestamp |
| Benchmark / sector indices | Existing `candles` for NIFTY50, BANKNIFTY (own DB); Yahoo for sector indices | PARTLY | Own DB has index candles (the trading system collects them) | Sector index tickers on Yahoo: UNVERIFIED | Benchmarks |
| News | Existing RSS ingestion | EXISTS | In the codebase (`news-sentiment`) | Secondary evidence only | Supplementary |
| Free fundamentals APIs | Financial Modeling Prep free tier | READ | 250 calls/day; its own pages list US/UK/Canada tiers; India coverage not confirmed | Treated as unavailable | Rejected |
| Free fundamentals APIs | Twelve Data free tier | READ (page unclear) | Free plan fundamentals for NSE not confirmed | We already hold a Twelve Data adapter (gold); fundamentals not tested | Rejected until a key test says otherwise |
| Screener.in | Export / scrapers | READ | No API; Export is premium (paid). Terms (2018 version) grant personal, non-commercial viewing; the restriction list was cut off in what I read. Third-party scrapers exist (paid per result) | Not free; scraping legality unconfirmed | Rejected for the free constraint |
| Embeddings for retrieval | Gemini embeddings or local model | UNVERIFIED | Not tested; generation via `gemini-client.ts` exists | Free-tier quotas unknown | Phase 8 spike |

## 3. Which fundamentals source is better (decision D4)

Short answer: none of the free automated sources is good enough alone, and the best free design is two layers.

1. PRIMARY, authoritative: the company's own results as filed with the exchanges (XBRL, plus the PDF for context).
   Why it wins: consolidated and standalone are separate and labelled, every filing has a broadcast time (the
   `known_at` date point-in-time work needs), restatements arrive as new filings, and it is the legal source of
   truth. Why it is not simply "scrape it": NSE forbids automated collection and no API exists. So ingestion is
   USER-ASSISTED: you download the XBRL/PDF for a company-quarter (a few clicks) and drop it into an import screen,
   or paste a filing URL for the system to fetch once. Volume is small (a few filings per company per quarter) and
   a human-triggered single download is a different thing from a crawler. Optional, for the owner: email the two
   exchange XBRL desks above and ask whether a programmatic route exists and on what terms; a "yes" removes the
   manual step without redesign.
2. SECONDARY, automatic: Yahoo fundamentals-timeseries, used to (a) bootstrap a new stock instantly, (b) cross-check
   the filed numbers (a mismatch beyond a stated tolerance raises a data-quality warning), and (c) fill gaps,
   always labelled "secondary, not verified". It is never substituted silently for the filing.

Consequences to accept: depth is limited by what is filed and imported (XBRL exists back to roughly 2017 on BSE:
READ, to be confirmed per company); a new stock is "provisional" until its filings are imported; point-in-time
history for the backtest of any forecast exists only for the periods imported with their filing dates.

## 4. Data flow (what moves where)

```
 SOURCES                      LANDING (immutable)          NORMALISE              COMPUTE                 SYNTHESISE            SHOW
 Yahoo chart/fundamentals --> raw_records (url, hash,  --> equity_financial_  --> metric_values    --> scenarios/valuation --> claims ledger --> report (versioned)
 user-imported XBRL/PDF   --> retrieved_at, source,        facts (basis,           (formula+version,    (assumptions stored)    (LLM, cited)       + screens
 user-pasted URLs         --> status, warnings)            period, known_at,        NOT_MEANINGFUL
 RSS news, announcements                                   origin, restated_from)   states)
                                  |                              |                       |
                          reprocess without refetch       reconcile Yahoo vs filing   deterministic, unit-tested
```

Rules that make it smooth:

* Land first, parse later. Raw bytes and hash are stored before anything is interpreted, so a parser fix replays
  from storage, never from the network, and the same input cannot be counted twice.
* One normalised fact carries its origin (REPORTED from a filing, SECONDARY from Yahoo, CALCULATED), its basis
  (CONSOLIDATED or STANDALONE) and `known_at`. A metric names which facts it used.
* Idempotent, resumable jobs with the existing scheduler's claim and abandonment horizons.
* Order of backfill for a new stock: identity -> prices and corporate actions -> Yahoo fundamentals (provisional)
  -> import filings -> reconcile -> metrics -> valuation -> report.
* Quotes are cached and labelled DELAYED with their own timestamp; a stale or failed fetch shows its state and is
  never replaced by a different provider silently.

## 5. Rate and failure discipline (lesson from 2026-10-16)

Our own Fyers incident: retries on every 429 multiplied the failure, collectors crash-looped, and one shared
cooldown would have paused healthy jobs. Required for every external call in this module:

* One HTTP gate per host (start at 1 request/second to Yahoo, as in the probe), a per-job daily budget, and a
  request counter logged every 5 minutes.
* No retry on a classified rate-limit; exponential backoff with a cap on transient errors; a circuit breaker that
  fails fast and shows "source unavailable" in the UI.
* Cooldowns per endpoint and per job, never global.
* Source-health table updated on every call (last success, last failure, status, count today).
* Budget sanity: a 50-stock watchlist refreshed every 5 minutes through Yahoo would be roughly 50 x 75 = 3,750
  calls/day; use on-demand and 15-minute caching instead.

## 6. Open verifications (each must become PROBED before it is relied on)

1. Yahoo quote latency for NSE on a trading day (compare `regularMarketTime` to wall clock).
2. Whether Yahoo reports bonus issues and rights issues correctly (compare Suzlon's history to exchange records).
3. Which basis (consolidated or standalone) Yahoo's fundamentals reflect for each stock.
4. BSE terms of use and robots.txt; NSE and BSE answers on a programmatic route (owner emails).
5. A real Suzlon results XBRL file: parse a quarter end to end and reconcile to Yahoo.
6. Fyers websocket equity subscription limits.
7. Suzlon investor-relations page structure and document formats.
8. Embedding provider free quota.

## 7. Verifier finding, 2026-10-17: Yahoo `close` is not a raw traded price

Evidence (SUZLON.NS, 5,179 usable daily bars, 2005-10-19 to 2026-10-16): NSE equities traded on a 0.05 tick before 2024, so a true traded close sits on a multiple of 0.05. In every year 2005 to 2021 almost no closes do (for example 0 of 248 in 2007, 0 of 251 in 2020), while 2023 is 245 of 245. Only one split (5:1, 2008-01-21) is in the events list, which would give a clean multiple. So the older closes carry an extra back-adjustment factor, most likely for rights issues, that Yahoo applies silently and does not list as an event. Dividends are NOT in `close` (adjclose/close was 0.985 at the start, 1.0 at the end).

Consequences: stored prices are a consistent adjusted series, good for returns and charts, but historic price levels do not match what traded, and the adjustment factors cannot be recomputed from the events table. Never label them "raw" or "as traded". Do not mix them with exchange-sourced unadjusted prices (for example bhavcopy) without a documented factor. To confirm the cause, compare one pre-2022 date with the exchange's own record of that day's close (user-supplied bhavcopy). Not yet done.
