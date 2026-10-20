# Phase 0 Equity Filings Feasibility Spike Report

**Date:** 2026-10-20  
**Status:** Complete  
**Verdict:** NO-GO

---

## 1. Verdict

### **NO-GO**
Automated data collection is explicitly and unconditionally prohibited by the National Stock Exchange of India (NSE). Under the pre-agreed evaluation rules (*"Read the terms before scraping. If automation isn't permitted, the finding is 'not permitted'"* and *"Don't work around blocks, CAPTCHAs or logins"*), this prohibition terminates automated collection feasibility. Scraping exchange websites is closed.

---

## 2. Answers to the Eight Spike Questions

### Q1: Which official or permitted sources exist, and what does each provide?
1. **NSE India (`nseindia.com`)**: Primary national stock exchange. Hosts corporate announcements, board meeting intimations, and quarterly financial result filings. **Automated access is prohibited.**
2. **BSE India (`bseindia.com`)**: Primary national stock exchange. Hosts corporate announcements, board meeting notices, and Ind-AS XBRL filing packages. **Website scraping status is unverified; standard automated requests are rewritten to an SPA shell.**
3. **SEBI (`sebi.gov.in`)**: Capital markets regulator. Publishes regulatory orders, takeover/SAST disclosures, and circulars. Does not host operational quarterly company financial filings.
4. **MCA21 (`mca.gov.in`)**: Ministry of Corporate Affairs portal. Hosts statutory annual filings (AOC-4, MGT-7). Requires user authentication, CAPTCHA, and statutory payment per document; does not host quarterly exchange results.
5. **Commercial Feeds (NSE Data & Analytics / BSE Data)**: Permitted, authorized commercial data feeds. Cost and contractual terms are unverified (commercial quotation required).

---

### Q2: Is automated access allowed?

#### NSE India
* **Inspected URL:** `https://www.nseindia.com/static/nse-terms-of-use` (and `https://www.nseindia.com/robots.txt`)
* **Inspection Date:** 2026-10-20
* **Allowed:** **NO**
* **Exact Verbatim Clause:**
  > "User is prohibited to conduct any systematic or automated data collection activities (including scraping, data mining, data extraction and data harvesting) on or in relation to our Website / Mobile Application."
* **Notes:** Verified directly on `/static/nse-terms-of-use`. The clause contains no consent exception or waiver proviso; it is an outright prohibition. Automated HTTP requests to NSE endpoints are also actively blocked at the network perimeter by Akamai Edge (HTTP 403 / HTTP2 stream error).

#### BSE India
* **Inspected URL:** `https://www.bseindia.com/static/about/terms_condition.aspx` (and `https://www.bseindia.com/robots.txt`)
* **Inspection Date:** 2026-10-20
* **Allowed:** **UNVERIFIED**
* **Notes:** Inspection of `/static/about/terms_condition.aspx` (~3,700 characters) revealed that it governs solely downloadable freeware software and tools provided by the exchange. A search for `"automated"`, `"scrap"`, `"harvest"`, `"data mining"`, and `"systematic"` on that page yielded zero matches. The previously cited clause was an ungrounded secondary attribution and is not present on this page. `bseindia.com/robots.txt` rewrites to an Angular SPA shell. BSE's formal web scraping terms remain unverified from primary sources.

---

### Q3: Completeness (Last 8 SUZLON Quarters)

Because primary exchange feeds could not be accessed automatically, the table below reflects what is currently recorded in our local database (`equity_research.secondary_fact`, ingested from Yahoo Finance during the Slice 0 backfill on 2026-10-17). Secondary filing dates noted below are from third-party media and investor relations summaries, and are **unverified against primary exchange raw feeds**.

| Quarter | Period End | Local `secondary_fact` Revenue (INR) | Local `secondary_fact` Net Income (INR) | Secondary Filing Date (Unverified) | Status in Database |
| :---: | :---: | :---: | :---: | :---: | :--- |
| **Q1 FY27** | 2026-06-30 | 38,193,600,000 (₹3,819.36 Cr) | 3,052,200,000 (₹305.22 Cr) | 2026-07-28 | Present |
| **Q4 FY26** | 2026-03-31 | 54,680,600,000 (₹5,468.06 Cr) | 11,143,500,000 (₹1,114.35 Cr) | 2026-05-25 | Present |
| **Q3 FY26** | 2025-12-31 | 42,281,800,000 (₹4,228.18 Cr) | 4,452,800,000 (₹445.28 Cr) | 2026-02-05 | Present |
| **Q2 FY26** | 2025-09-30 | *None* | *None* | 2025-11-04 | **MISSING IN DATABASE** |
| **Q1 FY26** | 2025-06-30 | 31,173,300,000 (₹3,117.33 Cr) | 3,243,200,000 (₹324.32 Cr) | 2025-08-12 | Present |
| **Q4 FY25** | 2025-03-31 | 37,735,400,000 (₹3,773.54 Cr) | 11,822,200,000 (₹1,182.22 Cr) | 2025-05-29 | Present |
| **Q3 FY25** | 2024-12-31 | *None* | *None* | 2025-01-28 | Dropped (Yahoo rolling window) |
| **Q2 FY25** | 2024-09-30 | *None* | *None* | 2024-10-28 | Dropped (Yahoo rolling window) |

*Summary:* Only **5 of the last 8 quarters** are present in our local database. Quarter ended `2025-09-30` is missing from Yahoo's payload, and earlier quarters have aged off Yahoo's 5-quarter rolling window.

---

### Q4: Structured XBRL Availability

* **Finding:** **UNVERIFIED FROM PRIMARY EXCHANGE INGEST**
* **Context:** Under SEBI LODR, listed companies submit Ind-AS financial results in XBRL `.xml` format to exchange portals. However, because automated collection from NSE/BSE was blocked and unauthorized scraping was ruled out, no raw exchange XBRL instance document was directly downloaded or parsed in this spike. The structured numbers available in this project come exclusively from Yahoo Finance's `timeseries` JSON payload.

---

### Q5: Comparison with Local `secondary_fact`

* **Finding:** The "official" numbers in the previous draft were circular—they were copied directly from our local `secondary_fact` table, not independently derived from primary exchange filings.
* **Verified Database Facts:**
  1. For SUZLON, `equity_research.secondary_fact` contains 5 quarterly entries for `quarterlyTotalRevenue` and `quarterlyNetIncomeCommonStockholders`.
  2. The quarter ending **2025-09-30 is completely missing** from Yahoo's feed and our database.
  3. **Consequence for Live Operations:** When SUZLON reports its results for the quarter ending 2026-09-30, our `RESULTS_PUBLISHED` alert evaluator will lack the prior-year comparison (`2025-09-30`), meaning the YoY change cannot be computed and will be omitted by the alert engine.

---

### Q6: Timeliness (Yahoo Lag)

* **Finding:** **UNMEASURED / UNVERIFIED IN LIVE OPERATIONS**
* **Rationale:** In our database, all existing rows in `equity_research.secondary_fact` show `first_seen_at = 2026-10-17 11:08:08 UTC` because Slice 0 ran an initial historical backfill on that day. Because no new earnings release has occurred during the live observation window, the actual post-filing latency between a company's exchange announcement and Yahoo's ingestion has not been empirically measured by our collectors. Any specific lag estimate (such as 24–72 hours) is unsourced conjecture and has been removed.

---

### Q7: Advance Reading of Next Board Meeting Date

* **Statutory Requirement:** Under **Regulation 29(1)(a) and 29(2) of the SEBI (LODR) Regulations, 2015** (as amended on May 17, 2024), a listed entity must give prior intimation to the stock exchange about a board meeting considering financial results **at least two working days in advance** (excluding the date of intimation and the date of the meeting).
* **Earlier Historical Baseline:** Prior to the May 2024 amendment, the rule had required 5 days for financial results.
* **Empirical Lead Times:** Secondary sources indicate SUZLON intimations typically appeared 7 to 9 calendar days prior to the meeting. However, reading this date ahead of time via automated exchange collection is blocked by the same Terms of Use prohibition that prevents scraping results filings.

---

### Q8: Cost and Stability

* **Public Web Scraping:** Terminated. NSE's terms prohibit automated harvesting, and requests are blocked at the perimeter by Akamai WAF.
* **Commercial Feeds:** Authorized machine-readable data feeds from exchange subsidiaries exist, but exact institutional pricing is unverified without a formal sales quotation.

---

## 3. Recommended Path Forward

Given the NO-GO on automated exchange scraping:

1. **Retain Yahoo for Descriptive Fundamentals:** Continue utilizing the existing Yahoo `secondary_fact` ingestion for descriptive `RESULTS_PUBLISHED` flags, accepting that older quarters roll off and occasional quarters (such as SUZLON 2025-09-30) will lack YoY comparison data.
2. **Human-in-the-Loop Results Calendar:** Maintain board-meeting and results dates manually via the existing manual events system, accompanied by an official HTTPS source link (e.g. exchange announcement PDF link). This remains fully compliant, stable, and requires zero automated scraping infrastructure.
3. **No Feature Code or Migrations:** In accordance with the spike plan, no product code was written, no database migrations were applied, and alert rules remain completely frozen during the soak.
