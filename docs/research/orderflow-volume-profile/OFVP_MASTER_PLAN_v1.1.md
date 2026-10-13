# AI Quant Lab — Order Flow + Volume Profile Master Research Plan

**Document ID:** `OFVP-MASTER-PLAN-v1.1`  
**Supersedes:** `OFVP-MASTER-PLAN-v1.0` (unchanged original kept; see the revision note below)  
**Created:** 2026-10-13 (v1.0); **revised:** 2026-10-13 (v1.1, after verification against the repository and the transcripts)  
**Status:** Research specification — **not a live-trading authorization**  
**Scope:** Convert 22 supplied ZIP transcripts plus the separately supplied *Introduction to ORDER FLOW (+How to Read DOM)* transcript into an auditable, falsifiable research programme for intraday futures and, only later, separately tested options execution.

---

## Revision note: what v1.1 changes, and what was verified

v1.0 was checked against the AI Quant Lab repository, the database, and the transcript files themselves. The method and the transcript audit held up. These parts did not, and are corrected here:

| Where | v1.0 said | v1.1 |
|---|---|---|
| §11.1 | `H_OFI_REPLENISHMENT` is "an existing OOS PASS" waiting out a 30-session lock | It is **EVIDENCE (Stat) / FAIL (Econ)**: modelled net **-1.27 bps**, "falsified as a retail market-taking strategy" (Phase 28 manifest and cost-stack record, both sealed 2026-10-09). The 30-session window is a *future confirmatory test on new data*, gated on a dual-instrument L2 capture qualification. It is not a lock after a pass. |
| §11.1 | `H_OFI_CONDITIONAL` is a held candidate with a fixed `OFI_30s > 0.032` | It was **falsified** (2026-10-07 resiliency preregistration). The repo's own code comments say **no validated threshold exists** and that `0.032` compares incompatible units. Nothing is held. |
| §11 | Six named "AI Quant Lab architecture invariants" already exist | They were **not found** in the repository's architecture documents (only "Default Deny" appears, in one ICT spec). They are re-stated as this plan's own operating rules, to be mapped onto real code owners before implementation. |
| §5.5 (new) | (absent) | A verified inventory of what the lab holds. Result: **no trade prints and no aggressor side**, depth for **BANKNIFTY futures only**, futures minute bars for **about 29 sessions**. By the plan's own stop gate the project is `REDUCED_SCOPE`, and Delta, CVD and footprint cannot be built today. |
| §5.6 (new) | (absent) | A **cost-floor gate**: round-trip friction is about **9.7 bps** on the lab's own sealed numbers (about 53 BANKNIFTY points, about 22 NIFTY points), so a setup whose typical move is smaller is rejected before any backtest. |
| §9.6 | 200 events across 60 sessions, stated without a timeline | Kept as the default, with the lab's current data against it, and a requirement that each study justify its own bar. |
| §11.2 (new) | (absent) | How this plan relates to the closed first FRVP study, the live FRVP observation, and the lab's earlier no-edge results. |
| Throughout | Hypotheses named H1-H8 | Renamed `OFVP-H1`..`OFVP-H8`: `H1`/`H2` already name different hypotheses in the FRVP protocol. |
| §3 rows 4, 18, 19 | Line citations | Row 4's range ran one line past the file; rows 18 and 19 cited a "four profile outcomes" passage that is not at the cited lines. Corrected. |

**Verified and unchanged:** the 22 files in the zip plus the separate introduction file are all present and match the register; the spot-checked claims in rows 7-11, 14 and 20-22 are faithful to the transcripts; the cited line ranges fit inside the files; NSE's description of Level 1, Level 2 (5 levels), Level 3 (20 levels) and tick-by-tick feeds matches NSE's own wording as quoted in search results.

**Not verified:** the NSE pages themselves timed out when fetched, so the NSE wording was confirmed through search-result quotations, not the live pages; anything in the transcripts that depends on a chart or image shown on screen; and where the six invariants came from.

---

## 1. Executive decision

### The plain-English verdict

**There are several useful ideas to test, but these transcripts do not establish a profitable strategy.** They provide a vocabulary and hypotheses for understanding how trade aggression, resting liquidity, and trading activity by price interact. Most examples are visual, discretionary, retrospective, promotional, or based on a small number of sessions. Reported account profits, win rates, “world's best scalper” labels, and “1,000 stop hunts” are not independently auditable evidence as supplied.

The correct output is therefore **not** to combine every indicator into one “master signal.” It is to construct one common data/feature foundation and then test separate, competing setups. Start with two relatively clear hypotheses:

1. **Failed auction / rejection back into prior value** — a potential mean-reversion setup when price probes outside a previously known value area and fails to remain there.
2. **Accepted breakout / value migration** — a potential continuation setup when price leaves prior value, demonstrates sustained acceptance outside it, and order flow confirms initiative rather than a one-tick excursion.

Keep stop-run, CVD divergence, absorption/iceberg, low-volume-node transit, and VWAP ideas as separate follow-up experiments. Do not require all of them simultaneously, and do not let any of them authorize an order by itself.

### Master design principle

> **Market state → profile location → observable order-flow evidence → executable trigger → independent risk veto → measured outcome.**

Volume profile tells us **where** the market has previously conducted business. Footprint/delta/time-and-sales tell us **what traded and which side was aggressive**. DOM/heatmap/MBO tell us **what displayed liquidity was present and how the visible book changed**. Those are related but distinct facts. A good-looking chart confluence is not a validated edge.

### What this plan does not claim

- It does not certify any video creator's performance claims.
- It does not prove that absorption, CVD divergence, a stop sweep, an iceberg, an HVN or an LVN predicts the next price move.
- It does not treat displayed orders as proof of a specific bank, fund, retail trader, or stop order.
- It does not authorize live trading. Research PASS, OOS PASS, shadow readiness, and production authorization remain separate states.

---

## 2. Source-handling rules and evidence hierarchy

Each transcript was mapped by subject and key line/time regions. Transcript numbers and timestamps below are **source pointers** to the supplied text, not endorsements of the speaker. Transcription quality varies (including malformed timestamps, omitted visuals, promotional inserts, and speech-to-text errors); where a key claim depends on an image, chart, proprietary indicator, or missing data table, the text alone cannot validate it.

Use four evidence classes throughout AI Quant Lab:

| Class | Meaning | Permitted use |
|---|---|---|
| **A — Mechanics / definition** | A reasonably testable description of order matching, trade classification, profile calculation, or market-data structure | Implement after checking it against the actual feed/specification |
| **B — Trading hypothesis** | A plausible market behavior or pattern, but predictive value is not established by the transcript | Pre-register and falsify in isolated experiments |
| **C — Anecdote / discretionary example** | A live or replayed trade, selected example, creator's reported results, or subjective interpretation | Generate ideas only; never use as evidence of an edge |
| **D — Marketing / unverified claim** | “best,” “unfair advantage,” “banks use this,” high accuracy, returns, funded-account claims, or unreported methodology | Exclude from model decisions unless independently verified |

**Rule:** No idea is elevated from B/C to validated edge because several creators repeat it. Correlated creator narratives are not independent evidence.

### What counts as evidence for this programme

A feature or setup becomes a candidate only after it has (a) an exact point-in-time definition, (b) a reproducible event label and trade policy, (c) plausible net economics after all costs, (d) stability across chronological periods and regimes, and (e) a clean untouched out-of-sample (OOS) result. A feature can be useful for interpretation yet add no incremental trading value; that is a valid research outcome.

---

## 3. Transcript-by-transcript audit

The following is the source register for the complete bundle: **22 files in `transcripts (1).zip` plus one separate introduction file**. The line regions are approximate anchors for the relevant material; use the transcript text and timestamps together when revisiting a passage. “Disposition” is the proposed engineering/research treatment, not a claim made by the video.

| # | Transcript | Main source-derived idea and useful region | What we should take from it | What we must not assume / disposition |
|---:|---|---|---|---|
| 1 | **Introduction to ORDER FLOW (+How to Read DOM)** (separate upload) | Lines 36–96 (~01:13–03:14): order flow as a real-time perspective, not a strategy. Lines 195–255 (~06:23–08:48): bid/ask resting limits and aggressive executions. Lines 263–349 (~09:09–12:13): aggressive consumption/withdrawal of passive liquidity; two-way trading and consolidation. | Learn passive versus aggressive liquidity; price impact depends on executed flow relative to available liquidity and liquidity changes. | Do not infer that aggressive buyers automatically make price rise: price may be absorbed, hidden liquidity may exist, and book quantities can change. This is mechanics, not alpha. |
| 2 | **Complete Guide on Futures Contracts (Orderflow Full Course Beginner to Advanced EP.1)** | Opening/course map; roughly lines 111–260 discuss centralized futures trading, market transparency, data, contract/margin and platform issues. | Correct instrument and exchange feed matter; order flow requires a feed whose traded-volume/order-book scope is understood. | Hype such as “X-ray vision” and sweeping claims about brokers are not evidence. A CFD/spot proxy must not be represented as a complete exchange order book. |
| 3 | **The Only Orderflow Basics Video You'll Ever Need… EP. 2** | Early section (~first half): orderbook as resting orders, market/stop orders as aggressive execution, bid/ask/spread and depth. | Implement bid/ask, spread and book-side semantics clearly in data contracts. | A passive order is not necessarily a market maker, institution, or signal. “Order-flow tool” does not itself mean profitable. |
| 4 | **Full MBO Orderflow Guide [Complete Beginner Course EP3]** | Roughly lines 176–317: market-by-order (MBO), order IDs, order updates/queue positions, native versus synthetic iceberg interpretation; source says this is a specialized/advanced use. | Consider MBO only if the exact exchange/vendor feed actually provides usable order-level event identity and replay data. | Never infer participant identity from a large order ID. Do not build the initial system around an expensive, unverified or unavailable MBO feed. Exchange priority rules must be verified against the actual venue and product. |
| 5 | **How Banks Hide their Orders Behind Price — a Guide on Icebergs** | Lines ~213–263 (~07:29–09:22) and ~307–340 (~10:47–11:56): high aggressive volume/Delta with little price progress and repeated tests may indicate absorption/replenishment; the level can hold or eventually break. | Define measurable “effort versus result” and book-replenishment features; test fade and breakout outcomes separately. | A chart pattern cannot establish an actual iceberg or “bank” order. A large Delta plus stalled price is a proxy, not proof. Promoted iceberg indicators are not ground truth. |
| 6 | **EXPOSING How Banks Hide their Trades** | Lines ~31–100 (~00:20–01:17) introduces resting liquidity and icebergs; lines ~350–634 (~04:36–08:33) explain passive versus aggressive orders and slippage; lines ~1276–1318 (~17:00–17:40) distinguish market-by-price from order-by-order views; later sections demonstrate vendor-specific detection. | Strong source for order matching, book consumption, spread/slippage, slicing and the limitations of market-by-price depth. | Creator's statements about institutional intent, front-running, or “where smart money is entering” are not directly observable from the feed. Use exchange/vendor docs rather than video claims for feed semantics. |
| 7 | **I Analyzed 1,000 Stop Hunts with Orderflow — Here's What I Found Out** | Selected examples across the transcript compare ordinary high/low breaks with bursts that consume liquidity, and examine what happens after the breach. | A high/low breach should be separated into at least two outcomes: accepted continuation or failed break/re-entry. Flow, speed, volume and post-break acceptance are candidate measurements. | Despite the title, the supplied transcript does not provide an auditable event-level dataset, full labelling protocol, denominator, cost model or prospective test. Treat its chart examples as C — not as a validated study of 1,000 events. |
| 8 | **I COPIED the World #1 Scalper** | Lines ~145–271 (~01:56–03:35) describe short bias, opening-range/option context, a mean-reversion attempt near a level, aggressive buyers being absorbed and dynamic trailing; the rest is a discretionary live session. | Useful examples of combining a location/context with flow response and explicit invalidation. | The result is not a fully specified, reproducible strategy. It changes bias/stop/trade decisions dynamically and mentions gamma/option context that is not defined in machine-ready terms. Do not copy its position additions, promotional P&L or discretionary calls. |
| 9 | **I Got Funded $150,000 with This Strategy** | Early sections describe stop-run, iceberg and CVD divergence setups; source suggests high relative volume/Delta and entries near event extremes. Late sections report account stats without a complete independently verifiable trade ledger/cost definition. | Convert these three ideas into independent hypotheses; candidate volume thresholds must be relative to instrument and time-of-day. | Reported funded returns, win rate, risk and drawdown are self-reported and not sufficiently documented in the transcript. Its suggestion that rare trades do not need thorough backtesting is rejected. |
| 10 | **I Traded with the World #1 Scalper** | Lines ~45–121 discuss higher-timeframe context, specific area/volume-profile location, waiting for reaction; around ~131–173 the creator describes trapped buyers and notes that contrarian reversal setups may be less reliable than momentum in that trader's experience. | Patience and conditional confirmation can be turned into explicit “no signal until trigger” rules. Profile areas are context, not auto-entry levels. | Setup grading and risk changes are discretionary. No proof that the specific trader's rankings or self-reported setup quality generalize. Keep sizing fixed by risk rules, not confidence or profits. |
| 11 | **My Favorite Orderflow Indicator Beginners Guide to CVD** | Lines ~43–73 (~01:25–02:48): ask volume, bid volume, Delta = ask minus bid, Delta %. Later sections (~03:34 onward, and ~08:18–14:14) discuss absorption and divergence, including examples where divergence fails or continuation wins. | Define Delta/CVD arithmetically; measure divergence only over a specified short window and in context of a level/regime. The transcript itself contains a useful counterexample to treating divergence as a reversal trigger. | Delta is not a trader-identity label or a directional oracle. Reset window, classification and data source materially affect CVD. Do not optimise divergence windows after looking at the OOS outcomes. |
| 12 | **My Top 3 Trades from the World Cup** | Entire short transcript (~196 lines): a few selected NASDAQ trades using range/balance, pressure/CVD, large prints and follow-through/exit when pressure stalls. | Useful hypothesis: participation that fails to move price can be exhaustion/absorption; renewed initiative may confirm continuation. | Three winning/selected trades are not a sample. No edge, expectancy or generalizability can be inferred. |
| 13 | **Stop Drawing Liquidity Lines… Use THIS Instead** | Early-to-middle material (~first 200 lines): heatmap shows visible resting-depth history and changing liquidity; balance versus price discovery. | Test order persistence, cancellations/withdrawals and approach/reaction at levels. Use heatmap as a context view, not as a static support/resistance line. | Resting orders can be canceled, replenished or spoof-like without being executed. A bright heatmap band neither guarantees a target nor proves a stop pool. |
| 14 | **The BEST Trading Indicator** | Roughly lines 112–395: volume profile, HVN/LVN; ~601–835: value-area rotation vs breakout hypotheses; ~889–1099: proxy/tick volume caveat; ~1417 onward: session/composite profiles; ~1894–1969: don't over-anchor on one POC tick and examples may be hindsight-selected. | Good starting source for profile definitions, session-specific versus composite context, and separate balance/continuation hypotheses. Test zones/areas, not a magical POC tick. | This source sometimes conflates “70% value area” with a standard-deviation range. These are different algorithms unless a platform explicitly defines them that way. Some examples are acknowledged as hindsight. |
| 15 | **The Indicator Banks ACTUALLY Use — Full Guide to VWAP** | Roughly lines 108–245 (~03:42–08:xx): session VWAP, deviation bands and warnings that trends may persist through the bands. | VWAP can be an independent context feature; define session reset, price/volume inputs and band algorithm exactly. | “Banks use it” is not proof of predictive edge. VWAP and volume profile are different calculations. A band touch alone is not a trade. |
| 16 | **The Only FOOTPRINT Chart Guide You'll Ever Need** | Lines ~99–179: executed volume at price, POC and diagonal imbalance examples; later (~08:21 onward) absorption/initiative flow, low-volume pockets and unfinished auctions. | Build footprint features from actual bid/ask classified trade volume; quantify imbalance clusters, per-bar POC migration, price progress, and follow-through. | 2:1/4:1 imbalance thresholds are examples, not universal constants. “Unfinished auction returns” and “high probability” must be tested, not assumed. |
| 17 | **Trading Orderflow Made Me $4,000 in 67 minutes** | Lines ~259–388: uses a composite profile and prior-session profile; lines ~728–846: rejects at a range top/failed auction; ~910–1008: opening-range breakdown; ~1039–1090: summarises a few reversals and a continuation. | Test failed-auction and acceptance/continuation separately using prior profile context and order-flow confirmation. This is a useful idea source for a small number of entry-state definitions. | The P&L is a selected single-session walkthrough; it is not evidence of expectancy, costs or repeatability. Do not reuse the creator's exact labels without formal definitions. |
| 18 | **The Only Trading STRATEGY You'll EVER Need** | Lines ~562–760 (~06:09–08:35) describe balance/imbalance and failed auction; ~1681–1801 discusses profile/value/acceptance; failed auctions are described inside the balance/imbalance discussion (~706–988). No four-outcome profile taxonomy was found in this file at the range an earlier draft cited. The title's “only/best” language is promotional. | Auction market theory provides a useful state model: balance, directional price discovery, failed auction/return to value, continuation/acceptance. Convert states into deterministic rules. | Do not assume the claimed performance or treat visual “narrative” as code. The definition of value area must be fixed, and each transition needs an unambiguous timestamped criterion. |
| 19 | **The Ultimate Guide to PRO Trading** | Opening (~first 150 lines) emphasizes expectancy, risk-adjusted strategy, overfit caution; ~1813–2050 discusses profile/strategy concepts; ~2180–2270 profile/value-area/POC; ~2355–2410 discusses continuation versus failed-auction outcomes; later sections include discretionary examples. | Most useful methodological message: specify risk/reward, test enough trades, beware overfit and forward-test before live. Its balance → failed auction → imbalance → balance phases (~386–408) can inspire a state machine. | It is a large, mixed guide; not every suggestion is independently supported. Its “one profile fits all” interpretations and performance examples need instrument- and session-specific validation. “70% value area” is not synonymous with one standard deviation by default. |
| 20 | **Trading Live with the #1 Scalper in the WORLD (EXTREME Accuracy)** | Long live session (~3,725 lines): extensive discretionary interpretation of Delta/CVD, footprint, value areas and absorption; repeatedly moves/trails stops, changes bias and discusses aggression/no follow-through. | Good source of examples and counterexamples: strong Delta may be absorbed; low-volume response can mean little participation; a move through a level must be assessed by follow-through. | This is not a fixed strategy specification. The speaker makes many live, changing judgments and trade-management choices; the title's accuracy claim is not substantiated by a complete forward-tested ledger. No copying of dynamic risk escalation or adding positions. |
| 21 | **How To Make your First 10k Trading [No BS Guide]** | Around lines ~1280–1520 discusses large meta-orders, order slicing, passive absorption and VWAP/TWAP/percentage-of-volume execution; ~1880–2065 discusses simple strategy examples, risk and acknowledges order-flow is harder to formalize. | Useful explanation of why participants may use passive and aggressive execution and why size/liquidity affect impact; also helpful reminder to start with a narrow measurable baseline. | Large numerical examples, return/Sharpe/drawdown figures and claims about institutional intent need source datasets and assumptions. It contains strategies across unrelated horizons/markets; don't bundle them into the OFVP model. |
| 22 | **banks don't hunt for your stop loss… here's how it ACTUALLY works** | Lines ~113–195 reject a simplistic “banks hunt retail stops” story; lines ~360–478 distinguish a high/low crossing from a genuine burst of aggressive flow; balanced Delta/high volume alone cannot prove stop activity. | Model a “sweep-like event” from observable variables only: level breach, aggressive volume/Delta, pace/depth consumed, and acceptance or re-entry afterwards. | No way to identify retail stops or the trader class from just a wick/Delta. Treat “stop run” as a descriptive event label, not a claim about intent. |
| 23 | **3 Order-flow Trading Tricks for Beginners** | Lines ~23–70: high buyer Delta with no upward progress as possible absorption; ~75 onward maps “true FVG” to low traded activity within a price zone; ~126–179: CVD/pricing mismatch and later initiative candle. | Three candidate feature families: effort-versus-result, low-volume zone, and short-window Delta divergence with follow-through. | These are post-hoc chart interpretations. A “true FVG” definition based on a profile low-volume zone is different from a candle-based ICT FVG; do not silently merge semantic definitions. |

### Overall source audit outcome

| Category | Disposition |
|---|---|
| Order matching, spread, trade aggressor, visible depth and profile arithmetic | **Implementable definitions**, subject to feed verification |
| Failed auction/re-entry and accepted breakout/value migration | **Highest-priority hypotheses** to test separately |
| Absorption, Delta/CVD divergence, LVN transit, VWAP context | **Secondary hypotheses** with strict definitions and ablation tests |
| Stop-run / iceberg detection | **Exploratory only** until event detection and labels are reproducible |
| MBO/native-vs-synthetic iceberg | **Later phase** and only if order-level history and identity semantics are available |
| Claimed win rates, account returns, “best” labels, bank/retail-stop stories | **Not accepted as evidence** |

---

## 4. Architecture: three separate evidence planes

Do not implement “order flow” as one opaque score. Preserve source types and their meaning.

### Plane A — Executed transactions

From exchange trades/time-and-sales: timestamp, price, quantity, instrument and, if available or reliably inferable, aggressor side. From these build total volume, ask-aggressive volume, bid-aggressive volume, Delta, Delta%, CVD, trade rate, volume bursts and traded-volume-by-price.

**Critical data caveat:** aggressor classification must be confirmed from the feed (exchange flag if available; otherwise a documented quote-based rule, with an “unknown” bucket). A tick-rule inference is not ground truth. Report the share of unknown/ambiguous volume and whether results survive alternative classification policies.

**Lab status (verified 2026-10-13):** the lab stores **no trade prints and no aggressor side**. Its depth feed carries book levels only, its option feed carries last price and best bid/ask, and its futures history is 1-minute OHLCV. Plane A as written here cannot be built from current data. See §5.5.

### Plane B — Resting/visible liquidity

From L1/L2/L3/Tick-by-Tick book events: bid/ask levels, displayed size, adds/modifies/cancels, book lifetime, spread, depth imbalance, book consumption, cancellations as price approaches, and refill/replenishment. MBO/order-ID features are allowed only where true order-by-order IDs and message semantics are supplied.

A displayed level is **available liquidity at that instant**, not a promise that it will remain there. Distinguish trade-driven depletion from cancellation/withdrawal. Never equate a wall with actual executed volume.

### Plane C — Volume distribution by price

From executed transactions, build a fixed-algorithm profile over a declared window: prior session, current developing session (as-of timestamp), or a fixed composite window. Candidate features: POC, VAH, VAL, HVN/LVN areas, profile shape (single/double distribution), value migration, current price relative to prior value, and low-volume transit zones.

**Point-in-time rule:** the 10:00 signal cannot use the final 15:30 profile of the same session. It may use the completed prior session's profile and a developing profile computed using only trades received/available by 10:00.

### Plane D — Independent reference features

VWAP, opening range, prior-session extremes, volatility, time-of-day and instrument/session regimes are separate inputs. VWAP must never be substituted for volume profile or vice versa. Treat each as a candidate filter and prove its incremental value via ablation.

---

## 5. Data-readiness gate (must pass before strategy coding)

### 5.1 Instrument and feed choice

For initial intraday research, use the **actual exchange-traded futures contract** that corresponds to the desired market exposure, rather than treating a cash index value as if it had an executable order book. NIFTY and BANKNIFTY index spot prints, futures trades, options trades, and their order books are distinct data-generating processes. Decide whether the signal is computed on the future and later executed in options; if so, document that the options execution layer is a separate model.

The NSE's public data pages currently describe real-time Level 1, Level 2 (five best bid/ask levels), Level 3 (twenty levels) and tick-by-tick feeds with full order-book data, and list historical order/trade products. That confirms the data categories exist, **not** that the user's current broker/API subscription supplies them. Verify vendor entitlement, history, timestamps, sequence IDs, book semantics, backfill/replay access, permitted use, storage and total cost before choosing the architecture. References: [NSE real-time data subscription](https://www.nseindia.com/static/market-data/real-time-data-subscription), [NSE EOD/historical data](https://betanseapi.nseindia.com/static/market-data/eod-historical-data-subscription), [NSE data and information vending](https://www.nseindia.com/static/nse-data-and-analytics/data-information-vending).

### 5.2 Non-negotiable data inventory

| Dataset | Minimum required fields | Required checks |
|---|---|---|
| Instrument master | symbol, exchange, segment, expiry, lot size, tick size, price multiplier, active dates | correct contract roll; no stale/expired contract joins |
| Trade prints | exchange timestamp, receive timestamp, sequence if available, instrument, price, quantity, trade condition, aggressor classification and source | duplicate/out-of-order prints, sequence gaps, time-zone/DST rules where relevant, corrections and auctions identified |
| Quote/depth events | event timestamp, side, price, quantity, update type, sequence, depth level; order ID only if truly supplied | reconstructible book; crossed/locked state; missing updates; sequence-gap recovery; adds/cancels vs executions |
| Session calendar | exchange/product, date, open/close, pre-open/auction, special sessions, holidays, expiry/roll | no hard-coded generic “RTH/ETH” for a market that does not use it; version calendar |
| Cost schedule | brokerage, exchange/regulatory charges, taxes, spread, slippage, impact, funding/roll if relevant | per-instrument, per-order and as-of effective date; use the sealed line-item cost artifact where applicable |
| Reference market data | prior-day levels, underlying/futures mapping, events if used | point-in-time availability and symbol mapping |

### 5.3 Data-quality kill switches

Set a decision to `NO_TRADE / FEATURE_UNAVAILABLE` if the feed cannot safely support the requested feature. Examples: a book sequence gap without recovery, stale data beyond a frozen threshold, unknown aggressor side above the allowed limit, impossible negative depth/volume, price outside valid tick grid, unrecognised contract roll, or time/sequence order ambiguity. Do not forward-fill order book state silently across a stale gap. Set freshness thresholds by data vendor and instrument before OOS inspection; a 1-second rule may be appropriate for some high-frequency signals but must not be reused blindly across every data source.

### 5.4 Feed feasibility decision

Before building, answer these with evidence from the exact vendor/API contract:

1. Is bid/ask-aggressor trade classification delivered or derived?
2. Does the feed contain actual exchange order-book updates or only top-of-book/snapshots?
3. Is historical intraday depth available at the resolution needed, or only real-time depth?
4. Can the book be reconstructed after dropped messages, including order adds/cancels/modifications?
5. Are order IDs available and stable enough for MBO features? Are they exchange native or vendor-created?
6. Does a replay reproduce the live book and feature values?
7. Are the data rights/costs compatible with systematic research and storage?

**Stop gate:** if only candles and total bar volume are available, label the project `VP_PRICE_VOLUME_ONLY`; do not claim to have tested true footprint, Delta or DOM absorption. Continue with that reduced study or acquire the proper feed.

### 5.5 What the lab actually holds (verified against the database, 2026-10-13)

| Need | What exists | Consequence |
|---|---|---|
| Trade prints with aggressor side | **None.** No time-and-sales table; the depth socket carries book levels only; the quote socket carries last price and best bid/ask. | Delta, CVD, diagonal imbalance and footprint **cannot be computed**. Any such study needs a new feed first (§5.4 questions 1-7). |
| Depth / order book | `depth_frames`: **BANKNIFTY futures only**: Aug contract 5 sessions, Sep 24, Oct 11 (about 40 sessions across contracts). **No NIFTY futures depth.** About 12% of September frames lack a usable sequence number (a capture bug fixed in mid-September). The capture regime changed on 2026-09-07, so level-indexed features must not be pooled across it. | A depth study is BANKNIFTY-only, regime-split, and about 40 sessions at most. NIFTY depth needs capture first; this is also the open exit criterion of the Phase 28 manifest. |
| Executed volume by price | **1-minute futures OHLCV only**, NIFTY and BANKNIFTY, Oct contract from 2026-09-01 (about 29 sessions). August and September contract history was not available from the provider. | Volume profile is possible only as a *bar-volume allocation* (§6.1), never trade-by-trade. Label every result `VP_PRICE_VOLUME_ONLY`. |
| Index volume | Aggregate of constituent volume, not traded futures volume. Measured against futures volume over 16 session-profiles: minute correlation **0.38**; the same profile shape in **7 of 16**. | Not a substitute. |
| Calendar and costs | Exchange calendar and instrument master exist; a sealed line-item cost model exists (§5.6). | Reusable where the instrument and fill path match. |

**Phase 0 preliminary disposition:** `OFVP_DATA_READINESS_V1 = REDUCED_SCOPE`. What can be studied now is price-and-volume profile hypotheses (`OFVP-H1`, `OFVP-H2`, in their price-only and profile-only forms, §9.3 baselines 1 and 2) on about 29 sessions. Flow, footprint and most depth hypotheses (`OFVP-H3` to `OFVP-H5`, `OFVP-H8`) are **blocked on data**, not merely deprioritised. This disposition must be confirmed by the full Phase 0 checks before it is relied on.

### 5.6 Cost-floor gate (applies to every hypothesis, before any backtest)

The lab's sealed cost record (`docs/2026-10-09-cost-stack-validation-record.md`) decomposes the average round trip over its 52 opportunities as: statutory, exchange and brokerage **6.23 bps**; quoted spread crossing **2.45 bps**; modelled slippage **1.00 bps**. That is about **9.7 bps** round trip, or roughly **53 points on BANKNIFTY** (near 55,000) and roughly **22 points on NIFTY** (near 22,600). These are indicative: they come from that study's trades and contracts and must be re-derived for any other instrument, product or order path.

**Rule (proposed in v1.1):** each preregistration must report, from the Phase 2 event-definition report and *before any trading rule is run*, the distribution of the favourable move its target is built around, in bps. If the median distance to the planned target is below the cost floor for that instrument, the hypothesis is rejected as uneconomic and no backtest is run. A failed-auction move back to the POC on BANKNIFTY is exactly the kind of move that can fall near this floor, so this is not a formality. The same record shows an edge that is real in gross terms (+8.42 bps) and still falsified net of costs.

---

## 6. Feature specification v0.1

The feature registry must contain formula, units, input data, lookback, session reset, `availableAt`, missing-data behavior, version, tests and owner. Never use an undefined word such as “strong,” “large,” “aggressive,” “absorption,” or “accepted” in a production feature contract.

### 6.1 Volume profile

- **Profile window:** define (a) prior complete exchange session, (b) current session developing profile as-of timestamp, and (c) optional composite profile. Composite lookback must be fixed (for example, evaluate a small pre-registered set such as 5/10/20 sessions during discovery, then freeze one choice). Do not choose the composite period based on the final OOS chart.
- **Price bins:** use integer ticks or a fixed tick-multiple rule; store bin boundaries in integer ticks to avoid floating-point drift.
- **Volume-at-price:** sum executed quantity at each price bin. If the source only supplies bars, document that this is a bar-volume allocation approximation and do not compare it as equivalent to trade-by-trade profile.
- **POC:** bin with largest accumulated profile volume; define tie-breakers deterministically.
- **VAH/VAL:** choose and version one value-area algorithm, such as the platform-style contiguous expansion around POC until the target percentage of profile volume is covered. Fix target percentage (e.g. 70%) and tie-breaker. Do **not** assume that a 70% volume value area equals ±1 standard deviation; it does not by definition.
- **HVN/LVN:** define with a deterministic local peak/valley algorithm and width/smoothing rules, not by manually drawing whichever shelf looks meaningful. Test area-based representations, not a single exact POC tick only.
- **Value migration:** compute changes in POC and VA boundaries from an as-of snapshot or a completed prior session; quantify distance in ticks/ATR units and direction.
- **Shape:** any P/B/D or double-distribution label needs a reproducible shape metric (cluster/peaks, valley ratio, or an explicitly defined algorithm). A human-drawn profile type is not a feature until operationalized.
  - The lab already has such an operationalization: Amendment 1 of `docs/2026-10-13-frvp-rows-observation-protocol.md` defines P, b, D and B (POC position in thirds; double distribution as two comparable humps a quarter of the range apart with a thin neck), records a row-count stability flag, and has been stamping it log-only onto bot entries since 2026-10-13. Reuse those definitions. A different definition here is an amendment to be reconciled, not a parallel feature with the same name.

### 6.2 Footprint and Delta

For trades with reliable aggressor side:

- `ask_volume(price, window)` = quantity classified as buyer-initiated at price.
- `bid_volume(price, window)` = quantity classified as seller-initiated at price.
- `delta = ask_volume - bid_volume`.
- `delta_pct = delta / total_classified_volume` where denominator is positive; otherwise missing, never zero by default.
- `CVD(window)` = cumulative Delta over a fixed session or rolling window. Create separate explicit variants; no indefinite cumulative history without justification.
- `delta_zscore` / `volume_zscore` = deviation from a past-only instrument × time-of-day baseline. Baseline excludes current event and later rows.
- **Diagonal imbalance:** ratio of ask volume at price `p` to bid volume at the adjacent lower price (and converse for sell imbalance) using tick-aware price adjacency. Define zero-denominator handling and a minimum absolute volume; ratios alone are unstable on tiny counts. A 2:1 or 4:1 ratio from a video is a candidate threshold, not a universal standard.
- **Bar/interval POC:** price bin with the most executed volume in the chosen event/time interval; POC migration is measured, not visually judged.
- **Unfinished auction:** only code if both the exchange price/tick definition and actual final trade pattern are deterministically available. Treat any tendency to revisit it as a separate hypothesis.

### 6.3 DOM / heatmap

Candidate feature family:

- `spread_ticks` and best-level sizes;
- `depth_sum_k` for the top K bid/ask levels (K depends on actual feed depth);
- `depth_imbalance = (bid_depth - ask_depth)/(bid_depth + ask_depth)` when denominator is valid;
- order/book event rate, add/cancel/modify rates, and displayed liquidity lifetime;
- trade-executed depletion versus cancelled/withdrawn depletion;
- replenishment ratio after executions, time to first refill, amount replenished in frozen windows;
- price progress per unit of aggressive volume (effort/result); normalize by instrument, session and current volatility;
- distance to displayed liquidity in ticks/ATR, including persistence as price approaches.

Do not use only a static snapshot of depth as a proxy for resilience. AI Quant Lab's earlier static standing-depth resiliency idea failed its cost-adjusted OOS gate; this new plan must not revive it under a different name. A time-evolving replenishment/response study must be a distinct, pre-registered hypothesis with its own evidence.

### 6.4 VWAP and market context

- `session_vwap`: cumulative traded price × volume divided by traded volume from an explicitly defined session start, using only data received by decision time.
- Bands: define either standard deviation of trade-price deviations or another documented platform method; do not call two different algorithms the same feature.
- Prior session OHLC/range, opening range, prior session VAH/VAL/POC, current distance to those levels, time-of-day bucket, realised volatility and event/news flag (if data licensed and point-in-time) are separate features.
- Session resets, special sessions, expiry and roll dates must be explicit. Keep an “unknown/unclassified” bucket rather than guessing session membership.

### 6.5 Normalization

To compare liquid futures contracts with changing volume, use causal normalizations such as percentile or robust z-score calculated only from earlier comparable sessions and time-of-day windows. Raw contracts/Delta from ES/US transcripts must not be copied to NSE. No fixed threshold like “300 contracts” applies universally to NIFTY/BANKNIFTY or to different session times.

---

## 7. Candidate strategy hypotheses (keep them separate)

These are **test cards**, not trading instructions. For each one, preregister instrument, session, profile, event trigger, stop/target logic, costs, holding horizon, baselines, trial count and rejection criteria before running its OOS test.

### OFVP-H1 — Failed auction / re-entry into prior value (priority 1)

**Question:** Does a failed probe beyond a previously known value boundary plus confirmed opposite initiative add predictive information beyond the profile level alone?

**Context:** prior completed session VAH/VAL or pre-identified composite profile edge; preferably a documented balanced regime. Do not use a boundary calculated with future trades.

**Event definition (candidate to freeze):** price trades beyond the boundary by a minimum tick/volatility-normalized buffer; then returns inside the prior value area within a fixed time or trade-volume budget. “Return” and timeout must be numerically fixed. If price remains outside and value migrates in that direction, this is not OFVP-H1; route it to OFVP-H2 or label no trade.

**Trigger candidates:** re-entry plus short-window opposite Delta/footprint initiative; aggressive flow into the extreme fails to make further price progress; optional persistent opposing displayed liquidity if valid depth exists. Test profile-only, price-only and flow-confirmed variants separately.

**Entry:** after the first fully observed confirmation interval closes, not retrospectively at the extreme. Marketable versus passive execution policies must be separately simulated.

**Invalidation:** beyond the event extreme plus a predeclared tick/slippage buffer, or a defined time stop. If the strategy only works with a stop that would be too wide for the expected move, reject it.

**Targets:** first prior POC/HVN; optional opposite value edge only as a distinct exit variant. Target must be feasible after fees/slippage and before time stop. A target at the POC is not guaranteed to be hit.

**Primary confounders:** trend days, news bursts, opening/expiry conditions, value area recalculation, book withdrawals, and entries that happen only after much of the reversal already occurred.

**Falsification:** if flow confirmation adds no net expectancy over profile/price-only baseline, or gains vanish under modest execution latency/cost sensitivity, do not keep adding Delta indicators. OFVP-H1 may still be a valid descriptive state but not a trade edge.

### OFVP-H2 — Accepted breakout / value migration continuation (priority 1)

**Question:** Does flow-confirmed acceptance outside prior value distinguish continuation from a false breakout?

**Context:** prior VAH/VAL, opening range or a previously defined balance range. Only one level-generation method per initial experiment.

**Acceptance definition:** specify in advance how much time, number of completed bars/event intervals, volume, and/or trade activity must occur outside the level and what qualifies as a reclaim. Example structure for a candidate definition: at least N closed intervals remain outside; sufficient classified traded volume accumulates beyond the boundary; there is no close/re-entry beyond a predeclared tolerance; then a retest occurs. N, volume percentile and tolerance must be frozen before testing. Do not draw acceptance by eye after seeing the outcome.

**Trigger:** retest of boundary; counter-directional flow weakens or is absorbed without the market reclaiming old value; renewed aggressive initiative in breakout direction. Compare this flow-confirmed trigger to a simple price acceptance/retest baseline.

**Invalidation:** sustained reclaim of previous value or failure of the retest. Stop anchored to a mechanically defined retest extreme plus buffer.

**Target:** next precomputed composite HVN or a fixed volatility/structure target. Compare one target design at a time; no hindsight mapping to an attractive LVN.

**Falsification:** if the acceptance-plus-flow features do not improve expected net R or drawdown relative to simple breakout-retest, the additional order-flow complexity is not justified.

### OFVP-H3 — Sweep-like event: continuation versus reversal (priority 2)

**Question:** Following a reference high/low breach with abnormal aggressive activity/depth consumption, can post-breach behavior distinguish accepted continuation from re-entry/failure?

**Event features:** reference level and age; breach distance; buy/sell aggressive volume and Delta; event speed; volume percentile for time-of-day; number of book levels depleted (if depth history exists); book cancellations vs executions; price progress per unit volume; post-breach acceptance/re-entry; value/POC movement after the event.

**State split:**
- `SWEEP_ACCEPTED`: price remains beyond the boundary and new trading activity/value forms outside; evaluate continuation separately.
- `SWEEP_REJECTED`: price re-enters prior range/value and opposite initiative appears; evaluate mean reversion separately.
- `AMBIGUOUS`: insufficient or conflicting evidence; no trade.

**Important language:** “sweep-like” describes observed behavior only. It does not prove stops were triggered, identify who held those stops, or prove anyone intentionally hunted them.

**Falsification:** no stable difference between the post-event states, insufficient trade count, or event label sensitive to tiny parameter changes means OFVP-H3 remains descriptive only.

### OFVP-H4 — Absorption / effort-versus-result (priority 2)

**Question:** Does a high level of aggressive volume with low price progress predict a reversal or later breakout after the absorbing side gives way?

Define an event at a price/zone: normalized aggressive volume exceeds a frozen percentile while price excursion/net progress remains below a threshold; optionally, visible same-side depth replenishes after executions. Include minimum absolute quantity and session normalizations.

**Two outcomes, tested separately:** (a) level holds and price moves away (potential fade); (b) level fails after repeated consumption and price accelerates through (potential breakout/continuation). The exact same “absorption” feature can precede either; outcome context determines the hypothesis.

Do not retrospectively label a level “absorption” only after reversal becomes obvious. Use only data available at the timestamp and record competing explanations such as low activity, cancellation, hidden liquidity, and balanced two-way trade.

### OFVP-H5 — CVD divergence (priority 3)

**Question:** Does short-window CVD divergence add information beyond price, volume and location?

Specify swing detection without future pivots, CVD reset/rolling window, signal latency, minimum volume, and divergence magnitude. Test in separate contexts: prior value edge; opening range; and trend pullback. Do not pool these at first.

The CVD transcript itself contains a case where divergence persisted while price continued. Therefore, CVD divergence alone is never a trigger. Measure incremental edge after adding price progress, value location and later initiative.

### OFVP-H6 — LVN transit / unfinished auction (priority 3)

**Question:** Do pre-existing low-volume corridors or specified unfinished-auction patterns predict faster movement, directional continuation or revisiting?

Use only levels derived before the event or from as-of developing profiles. Define low-volume thresholds from past-only profile distributions, and measure speed/duration through the zone versus matched control zones. Do not equate low volume with guaranteed rejection; the source transcripts use both “fast transit” and reversal narratives.

### OFVP-H7 — VWAP context filter (priority 3)

First test VWAP on its own with a simple mechanical baseline, then ask whether it improves OFVP-H1 or OFVP-H2. Compare session VWAP only; only add anchored VWAP if an anchor-selection rule is frozen and causal. Band touches are context, not entries. Strong trend may stay outside a band.

### OFVP-H8 — MBO/native/synthetic iceberg study (later; gated)

Only begin if data audit confirms historical order IDs/events and the exact feed semantics. Avoid calling a pattern “native iceberg” unless the venue actually exposes a stable order ID and the published protocol confirms what modifications mean. Otherwise use the less ambitious name `replenishment_proxy`.

Rare-event models need enough labelled events and a robust baseline; a handful of memorable examples or a proprietary indicator's output is not sufficient.

---

## 8. The integrated master decision flow (not a confluence score)

Use a finite state machine so every no-trade and trade decision is explainable.

1. **Data gate:** required feed, book reconstruction, aggressor classification, timestamps and freshness pass. Otherwise `NO_TRADE`.
2. **Market-state classifier:** estimate `BALANCED`, `PRICE_DISCOVERY_UP`, `PRICE_DISCOVERY_DOWN`, or `UNCERTAIN` from point-in-time features. Begin with transparent rules; only consider ML after the rule baseline and feature provenance are proven.
3. **Location:** select precomputed/point-in-time prior value boundary, opening range or composite profile region. No location, no setup.
4. **Hypothesis routing:**
   - balanced / probe outside value → OFVP-H1 candidate;
   - demonstrated acceptance and value migration → OFVP-H2 candidate;
   - reference high/low breach → OFVP-H3 event classification;
   - stalled progress with abnormal aggression → OFVP-H4 event classification;
   - CVD/VWAP/LVN are modifiers only until proven incremental.
5. **Trigger:** require fully observed, timestamped evidence and a defined execution opportunity. If contradictory or ambiguous, `NO_TRADE`.
6. **Risk engine veto:** independent stop distance, size, portfolio exposure, daily loss, max trades, contract eligibility, spread/depth and operational status checks. Strategy cannot override risk.
7. **Order/execution:** choose marketable or passive policy; record order request, acknowledgement, fill, partial fill, cancellation and slippage. A touched passive limit is not automatically filled.
8. **Management/exit:** predefined stop, target, time stop and emergency exits. Avoid post-hoc trailing rules until each has been specified and tested as a separate variant.
9. **Audit record:** store all input feature versions, level references, signal state, reason codes, risk decisions, orders/fills, costs, and realized outcome.

### Decision flow pseudocode (illustrative)

```text
if data_gate != PASS:
    NO_TRADE(DATA_UNAVAILABLE)
else:
    state = classify_market_state(features_available_at_t)
    location = select_prior_or_developing_profile_location(t)
    candidates = route_hypotheses(state, location, event_features)
    candidate = evaluate_only_registered_candidate(candidates)
    if candidate is absent or ambiguous:
        NO_TRADE(NO_REGISTERED_TRIGGER)
    else:
        proposal = candidate.propose_order_and_exits()
        risk = independent_risk_engine.evaluate(proposal, current_portfolio_state)
        if risk != APPROVED:
            NO_TRADE(RISK_VETO_REASON)
        else:
            execute_under_registered_policy(proposal)
            audit_every_transition_and_fill()
```

No weighted score is required at v1. A score combining POC, Delta, CVD, VWAP, a heatmap and a candle pattern would obscure whether any part adds value and make post-hoc tuning much easier.

---

## 9. Research protocol and anti-leakage controls

### 9.1 Freeze the question before the run

For every OFVP-H1 to OFVP-H8 study, create a registration file containing:

- Hypothesis and mechanism;
- exact instruments/contracts and session calendar;
- event definition, features, windows and normalization;
- sample inclusion/exclusion rules;
- entry timing, order type, stop, target, time stop, concurrent-position policy;
- full line-item cost and fill assumptions;
- main metric, baseline, primary test, subgroup diagnostics;
- allowed parameter variants and multiple-testing procedure;
- sample-size/data sufficiency requirements;
- rejection criteria and minimum forward-monitoring period.

Do not change the protocol after viewing OOS outcomes. Any revision becomes a new version and must use new untouched data for confirmatory testing.

### 9.2 Chronology and point-in-time features

- Split chronologically by date/session; never randomly split individual ticks from the same day across train/test.
- Respect the maximum prediction/holding horizon with purge/embargo gaps where overlapping outcome windows could leak.
- Any rolling median, percentile, normalization, regime label or volatility estimate at time `t` uses past-only inputs.
- Profile snapshots are timestamped. Prior completed profiles and current developing profiles are different feature versions.
- Do not use future swing highs/lows, retrospectively identified pivot points, a later candle's high/low, full-session volume, or a same-session final value area in an earlier signal.
- Store exchange timestamp and local availability timestamp; feature eligibility must satisfy `availableAt <= decisionAt`.
- Rebuild the feature stream from raw event data in replay and compare it with online/shadow feature values; mismatches are a release blocker.

### 9.3 Baselines and ablations

Run at least these comparisons on identical dates, signals and cost rules:

1. **Price/location-only baseline** (profile boundary or breakout/re-entry without order flow).
2. **Profile-only** with simple entry/exit.
3. **Flow-only** (Delta/footprint or book measure, no profile location).
4. **Profile + one registered flow family** (e.g. prior value + Delta confirmation).
5. **Profile + VWAP** as an independent context feature.
6. **Full candidate** only after parts pass individually.
7. **No-trade/randomized timing control**, matched by session/time and opportunity count where appropriate.
8. **Existing approved research baselines** without altering their sealed protocol or status.

The key question is incremental benefit, not whether the integrated chart looks cleaner. Remove each feature family in turn (ablation); if performance doesn't deteriorate, that feature may not be worth the complexity.

### 9.4 Execution realism

Model, at minimum, actual tick size/value and lot size, exchange fees/taxes/brokerage where applicable, spread crossing, latency, realistic slippage, partial fills, queue uncertainty for passive orders, stop gaps, rejected orders, and contract roll/expiry effects. Avoid fills at the mid-price or a touched limit without queue/fill evidence. A marketable order should consume the relevant book under the modeled depth/latency, not fill every unit at the best quote if insufficient displayed liquidity exists.

Reuse the sealed, line-item cost validation only where instrument, product, order path and assumptions match. Do not blindly apply an earlier single 2-bps round-trip assumption to a different contract, strategy, time of day or options execution path.

### 9.5 Metrics

Primary: **net expectancy in R** and net P&L after all costs. Complementary:

- trade count and distinct event/session count;
- profit factor, win rate, average winner/loser, median R;
- max drawdown and drawdown duration, worst day, longest loss streak;
- turnover, exposure time, trades per session and capital use;
- MAE/MFE, target/stop/time-stop attribution;
- average/percentile slippage and fill ratio;
- instrument, expiry/roll, session/time-of-day, volatility and market-state breakdowns;
- calibration/stability of any probability scores;
- sensitivity to small, predeclared changes in latency, costs, thresholds and parameters.

Estimate uncertainty by resampling **sessions/days or contiguous blocks**, not independent ticks, because intraday observations are dependent. Report confidence intervals and multiple-trial context. A PF just above 1 on a small sample is not enough.

### 9.6 Sample sufficiency

Set minimum sample rules before running. As a *starting research policy*, not a universal statistical law, consider requiring roughly **200 completed trade events across at least 60 distinct sessions** for ordinary-frequency setups before treating performance estimates as even provisionally stable. Rare OFVP-H8 iceberg events may need a longer collection period or remain exploratory; do not lower standards just to get a result. Sample-size adequacy should be checked against the event frequency, dependence, variance and confidence interval width—not by trade count alone.

**Against the lab's data (2026-10-13):** about 29 sessions of futures minute bars exist, so even the price-and-volume tests cannot reach 60 sessions before roughly **the end of November 2026**, and depth-based tests are limited to about 40 BANKNIFTY sessions in two capture regimes. A study that cannot reach its bar is `INCONCLUSIVE / INSUFFICIENT_SAMPLE`; it does not lower the bar. Other lab protocols use different bars for stated reasons (the live FRVP observation: 150 closed trades, at least 30 per group; the OFI replenishment protocol: 30 sessions and 100 opportunities). Each OFVP preregistration must state why its own bar fits its event frequency and dependence, rather than inheriting 200/60 by default.

### 9.7 Decision outcomes

- **FAIL / REJECT:** net edge absent, costs consume it, effect reverses across sensible splits, or feature/label is not reconstructible.
- **INCONCLUSIVE:** insufficient events, poor data coverage, wide uncertainty or a failed data-integrity check. No tuning on confirmatory OOS to make it pass.
- **RESEARCH PASS:** registered primary endpoint clears registered statistical/economic gates in untouched OOS and passes ablation/stability diagnostics.
- **SHADOW PASS:** online feature parity, decision audit, operational reliability and live-data freshness proven in shadow mode.
- **PRODUCTION CANDIDATE:** requires separate approval by existing strategy and risk governance; a research pass is not live permission.

---

## 10. Initial experiment order

### Phase 0 — Source/data feasibility (do first)

1. Lock the exact starting product/instrument (recommend one liquid NIFTY or BANKNIFTY futures contract family first; do not pool the two initially).
2. Verify historical trades and required depth/order-book events, aggressor labeling, event timestamps, sequence recovery, licensing and storage costs.
3. Create the instrument/session/contract calendar and data dictionary.
4. Reconstruct one session from raw data and compare trade volume/Delta/profile against a trusted vendor/platform display; discrepancies are investigated, not smoothed away.
5. Freeze missingness, stale-data and ambiguous-aggressor rules.

**Deliverable:** `OFVP_DATA_READINESS_V1` with PASS/FAIL/REDUCED_SCOPE, source/version and example replay. A preliminary `REDUCED_SCOPE` finding is in §5.5; Phase 0 confirms or revises it.

### Phase 1 — Deterministic features and invariants

1. Implement point-in-time volume profiles, Delta/footprint, simple CVD, VWAP and (if historical depth is valid) DOM events.
2. Add unit tests for known toy order books: bid/ask semantics, spread crossing, multi-level market order consumption, cancel-versus-execution depletion, profile sum-to-trade-volume, POC/VA boundary tie-breaks, session reset, CVD reset and stale feed.
3. Add temporal tests proving no final-session profile or future pivot leaks into intraday features.
4. Validate online/replay parity.

**Deliverable:** versioned feature registry and data quality report, no trading signal yet.

### Phase 2 — Baseline profile-state study

Describe, without trading first, how often the market is balanced versus discovering price; how often prior VAH/VAL are probed, accepted, rejected and retested; and how outcome distributions vary by session/time-of-day. Establish outcome labels and event rates without optimizing a trading rule.

**Deliverable:** event-definition report, base rates, label audit and frozen OFVP-H1/OFVP-H2 preregistrations.

### Phase 3 — Test OFVP-H1 and OFVP-H2 independently

Run one instrument, one session definition, and one primary exit policy at a time. Compare profile/price-only against the addition of only one flow family. Keep OFVP-H1 and OFVP-H2 separate: a regime classifier may route trades, but do not use a combined backtest to conceal one losing model behind another winning one.

**Deliverable:** individual backtest packs for OFVP-H1 and OFVP-H2, including raw event-level traces and costs.

### Phase 4 — Sweep and absorption studies

Only after OFVP-H1/OFVP-H2 feature parity and baselines work, test OFVP-H3 and OFVP-H4. Build event audits (positive and negative examples) using predeclared definitions, and score examples blind to subsequent returns where feasible. Use neutral labels like `sweep_like`, `replenishment_proxy`, and `effort_result_imbalance`; don't label “institutional stop hunt” or “bank iceberg.”

**Deliverable:** OFVP-H3/OFVP-H4 preregistered studies; if the data doesn't identify event type robustly, document that limitation and stop.

### Phase 5 — CVD/VWAP/LVN incremental-value tests

Add one feature family per experiment. Run ablation and matched opportunity comparisons. A feature that improves explanation but not net after-cost results remains a dashboard/diagnostics field, not a required trade filter.

**Deliverable:** feature-ablation matrix and a short list of retained/falsified features.

### Phase 6 — Optional MBO and options execution

MBO only after feed proof and a business case. If the signal comes from NIFTY/BANKNIFTY futures and execution is via options, test options separately using actual option quotes/trades, spread/liquidity, expiry, Greeks/delta, slippage and rejection logic. Do not assume underlying Delta/profile predicts option fills or option P&L one-to-one.

**Deliverable:** a separate signal-to-execution study with rejection-provenance reasons and no change to the base signal definition during testing.

### Phase 7 — Shadow, monitoring and release gate

- Emit signals and shadow orders without live execution; collect feature freshness, signal counts, order simulations and intended-versus-realized fill differences.
- Reconcile live feature values to deterministic replay after each session.
- Define alerting for sequence gaps, stale data, missing depth, symbol/expiry mismatch, latency spikes, order rejects and kill-switch state.
- Apply risk vetoes to every decision; define daily loss/circuit-breaker behavior, max positions and max trades before any capital is enabled.
- Require sign-off on data, strategy, execution, operational controls and risk independently.

**Deliverable:** complete shadow-period sign-off pack; no automatic promotion by model score or headline PF.

---

## 11. Risk and implementation rules

### 11.1 Boundary with the existing OFI research programme

This OFVP plan is a **new, isolated research stream**, not a rewrite of current OFI protocols or statuses:

- `H_OFI_REPLENISHMENT` is sealed as **EVIDENCE (Stat) / FAIL (Econ)**: a gross edge of +8.42 bps that the modelled cost stack turned into **-1.27 bps net**, recorded as "falsified as a retail market-taking strategy" (`docs/2026-10-09-phase28-manifest.md`, `docs/2026-10-09-cost-stack-validation-record.md`). It is a comparison point and a caution about costs, not a candidate. Its 30-session window is a future confirmatory test on new, synchronised dual-instrument L2 data, which cannot start until that capture is qualified.
- `H_OFI_CONDITIONAL` was **falsified** (see the 2026-10-07 resiliency preregistration, which opens from that result). The repository's own comments (`apps/ml/ai_quant_lab_ml/cks_ofi_touch.py`, `master_scanner.py`) state that no validated gate threshold exists on the raw OFI value and that `0.032` compares incompatible units. Do not use it as a gate or a starting point.
- The earlier static standing-depth/resiliency approach (`H_OFI_RESILIENCY`) was **falsified** (Phase 28 manifest). Do not reintroduce that hypothesis as “depth confirmation,” “liquidity strength,” or an equivalent renamed filter. A genuinely dynamic replenishment/reaction feature is a new hypothesis and must prove that it is distinct.
- Do not reopen or regenerate sealed individual trade logs/cost artifacts just to fit the new study. Reference the validated cost schedule only where the exact instrument, period, fill path and line items match; version any necessary new cost model separately.
- Any future combined OFI+VP+footprint model requires a fresh preregistration and incremental-value ablation, and cannot start before the Phase 28 exit criteria (a qualified, synchronised NIFTY and BANKNIFTY L2 capture) are met. No new feature can bypass the current registry status or OOS gate.

### 11.2 Relationship to the lab's other volume-profile and no-edge records

- **FRVP-MSP-P0-2026-10-12** is closed as INCONCLUSIVE (7 sessions; a one-day test; its 0.05-point-bin profile put the POC on single stray bars and found 0.29 low-volume nodes per session). It is not reopened here.
- **The live FRVP observation** (`docs/2026-10-13-frvp-rows-observation-protocol.md`) is the lab's operational volume-profile work: a 48-row profile with futures volume on index price, P/b/D/B shapes, a prior-session block and a developing-today block, stamped log-only on bot entries. Its hypotheses are named H1 and H2 *inside that protocol*; this plan's are `OFVP-H1`..`OFVP-H8` for that reason. `OFVP-H1`/`OFVP-H2` (failed auction, accepted breakout) test different things from those, and the two must not be pooled or presented as one result.
- **Prior probability.** The lab's research records repeatedly find no durable edge from candle-pattern, ICT, higher-timeframe-filter and scalp variants on these instruments, and the one sealed microstructure edge was consumed by costs. This plan should be read with that prior: the most likely outcome of any single hypothesis is "no net edge", which the plan already treats as a successful result.
- **Trial accounting.** Every `OFVP-H` study counts toward the lab's multiple-testing accounting alongside its model registry. Each preregistration states how many variants it will run and how the family is corrected; a plan that registers eight hypotheses and corrects for none inflates its own false-positive rate.

Adopt these as this plan's operating rules. They were **not found as named principles** in the repository's architecture documents (only "Default Deny" appears, in one ICT spec), so before implementation each must be mapped onto the existing component that actually enforces it, or marked as not yet enforced:

- **Default Deny:** `NO TRADE` unless each required gate explicitly passes.
- **Strategy Cannot Authorize:** a signal proposes; it does not enable execution.
- **Risk Veto:** the independent risk engine can reject any candidate.
- **Current State Wins:** current position, account and kill-switch state override stale recommendations.
- **Runtime Risk Independence:** risk checks continue to function if the strategy process fails.
- **Every Decision Auditable:** every branch records inputs, version, timestamp, reason and outcome.

Further requirements:

- Size by fixed risk budget and actual stop distance/contract multiplier; account for gap/slippage risk. Do not scale risk merely because the day is profitable or because a speaker uses an A/B/C setup grade.
- Hard per-trade and per-day loss limits, max concurrent exposure, order rate limits and max trades; no martingale or loss-recovery escalation.
- Strategy-specific stops, targets and time stops are frozen before OOS. Emergency risk flattening is separate from strategy exits.
- No trades during unsupported data states, abnormal spreads/depth, unhandled contract transitions or system connectivity degradation.
- High-impact scheduled events should be a registered exclusion/stratum—not ad hoc exclusion after observing losses.
- Start with futures for research signal fidelity. If converting the signal to an option trade, validate option-contract availability, spread/size, expiry and slippage as a separate execution layer.
- The strategy cannot bypass existing model registry status, cooldown/waiting windows, OOS acceptance or other active system gates.

---

## 12. Suggested implementation artifacts in the repository

Suggested names; align with existing repository conventions and avoid duplicate infrastructure:

```text
docs/research/orderflow-volume-profile/
  OFVP_MASTER_PLAN_v1.0.md
  OFVP_SOURCE_AUDIT_v1.0.csv
  OFVP_DATA_READINESS_V1.md
  OFVP_FEATURE_CONTRACT_V1.md
  OFVP_H1_FAILED_AUCTION_PREREG_V1.md
  OFVP_H2_ACCEPTED_BREAKOUT_PREREG_V1.md
  OFVP_H3_SWEEP_STATE_PREREG_V1.md
  OFVP_H4_ABSORPTION_PREREG_V1.md
  OFVP_RESULTS_TEMPLATE_V1.md

apps/ml/... (place under existing ML research convention)
  profile builder / point-in-time snapshot
  trades-to-footprint and Delta builder
  optional book event reconstruction / book feature builder
  session/regime labeller
  OFVP-H1/OFVP-H2/OFVP-H3/OFVP-H4 event detector + deterministic replay tests
  cost-aware backtest and block-bootstrap evaluation

apps/api/... (only after the existing domain boundaries are checked)
  audited feature/signal records and data-quality state
  reason-code provenance and shadow telemetry
```

Do not create a second strategy registry, duplicate risk engine or parallel data architecture if the codebase already has an appropriate owner. Keep research outputs immutable/versioned and link every result to the code commit, feature protocol, data snapshot, and cost schedule.

### Recommended event/decision record

At minimum every candidate decision should record:

```json
{
  "decisionAt": "exchange-synchronized timestamp",
  "availableAtMax": "latest input availability timestamp",
  "instrument": "exact futures contract",
  "featureVersion": "OFVP_FEATURES_V1",
  "profileWindow": "prior-session|developing-session|composite",
  "marketState": "BALANCED|PRICE_DISCOVERY_UP|PRICE_DISCOVERY_DOWN|UNCERTAIN",
  "hypothesis": "OFVP-H1|OFVP-H2|OFVP-H3|OFVP-H4|OFVP-H5|OFVP-H6|OFVP-H7|OFVP-H8|null",
  "eventState": "accepted|rejected|ambiguous|not_applicable",
  "evidence": {},
  "dataQuality": "PASS|FEATURE_UNAVAILABLE|FAIL",
  "riskDecision": "APPROVED|VETOED|NOT_EVALUATED",
  "reasonCodes": [],
  "proposedOrder": {},
  "executionOutcome": {},
  "costBreakdown": {},
  "modelStatus": "RESEARCH_ONLY"
}
```

The exact schema should follow established application types. Store numeric fields in canonical units (integer ticks, contracts, rupees/points as appropriate), and never overwrite a previous version's result.

---

## 13. Final prioritized roadmap

| Priority | Work item | Why | Promotion condition |
|---|---|---|---|
| P0 | Verify feed + data rights + historic depth | All downstream orderflow claims depend on it | Replay and data-quality checks pass |
| P1 | Point-in-time profile, Delta/footprint and VWAP features | Establish reproducible definitions | Unit tests + online/replay parity pass |
| P1 | OFVP-H1 failed auction and OFVP-H2 accepted breakout as independent studies | Clearest testable ideas repeated across the sources | Frozen protocol, net-cost OOS pass, robust ablations |
| P2 | OFVP-H3 sweep-state classifier and OFVP-H4 effort/result absorption | Needs better event labelling and deeper book/trade data | Labels reproducible and incremental edge demonstrated |
| P3 | CVD divergence, LVN transit, unfinished auction, VWAP filters | May be useful, may be redundant | Incremental net value vs simpler baseline |
| P4 | MBO iceberg and option execution layer | More complex and feed-/product-specific | Data entitlement, sample sufficiency and independent validation |
| Final | Shadow mode and governance sign-off | Backtest success does not guarantee production quality | Explicit strategy, execution, ops and risk approvals |

### My recommendation as the research lead

Build the **measurement pipeline first**, then test OFVP-H1/OFVP-H2 separately. The first practical “master strategy” should be a **state-routed family of two simple setups**, not a confluence indicator: a rejection path for failed auctions and a continuation path for accepted breakouts. All other concepts should earn admission by demonstrating incremental net value over those simple baselines.

A result that says “no edge after costs,” “insufficient data,” or “this feed cannot identify icebergs” is a successful research outcome if it prevents an unsupported live trade. The objective is not to make the transcripts look profitable in code; it is to discover what survives explicit definitions, realistic execution, chronological OOS tests and the system's independent risk gates.

---

## 14. External data reference checked for this plan

These are official NSE pages for confirming available product categories and specifications. Product availability for the user's account, vendor, instrument and historic period must still be checked directly:

- NSE, [Paid Real Time Data](https://www.nseindia.com/static/market-data/real-time-data-subscription): describes Level 1/2/3 and tick-by-tick feed categories, including five-/twenty-level market depth and full-book tick-by-tick data.
- NSE, [Paid End-of-Day / Historical Data](https://betanseapi.nseindia.com/static/market-data/eod-historical-data-subscription): lists historical order and trade products for supported segments.
- NSE, [Data and Information Vending](https://www.nseindia.com/static/nse-data-and-analytics/data-information-vending): provides the official data-services catalogue and current tariff access.

**Verification note (v1.1):** the three NSE pages timed out when fetched on 2026-10-13. The Level 1 / Level 2 (5) / Level 3 (20) / tick-by-tick wording was confirmed from search-result quotations of NSE's own pages and a second NSE page; pricing, feed format (multicast versus TCP-IP) and redistribution terms differ between sources and must be confirmed with NSE Data & Analytics or an authorised vendor.

**Source limit:** the transcript bundle teaches concepts and shows examples; it does not supply the raw market/event datasets or reproducible study outputs needed to conclude that any candidate is profitable.
