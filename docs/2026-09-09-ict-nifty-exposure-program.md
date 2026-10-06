# ICT on NIFTY exposure — sequential confirmation program

**Registered 2026-09-09, before any run on 2023–2024 or on any collected era.** Nothing below may be
revised after a result is seen; a design error gets a dated amendment and the affected run is
discarded, not re-scored.

## The question, and where it came from

`ict-structure-v1` measured **+97.61 per trade on NIFTY50 15m** in 2025 (91 trades, 29 clustered
sessions, SE ±80.2, **t = 1.22**) while BANKNIFTY measured −30.11 (t = −0.20). The hypothesis under
test is the obvious one: *the edge is real on NIFTY exposure and the negative instruments are
irrelevant to it.*

This is a **discovery-driven** hypothesis. 2025 is the era that generated it and is therefore spent;
it cannot also confirm it. Two facts already argue against, and the program exists to settle the
disagreement rather than to relitigate it:

- **The tracker disagrees with the index.** NIFTYBEES, an ETF on NIFTY50, measured **−1.92 per
  trade at t = −6.62** over the same era. Price-normalised the two read **+0.395%** (NIFTY50) against
  **−0.705%** (NIFTYBEES) per trade. ICT reads pure price structure and never touches volume, so the
  two series should not disagree in sign on the same exposure.
- **It does not survive its own instrument.** NIFTY50 5m was −2,951 against 15m's +18,342, and
  NIFTY50 5m Feb–Sep was +1,793 against its own Jun–Sep subset at −2,951.

## Feasibility, verified before registering

Probed Fyers directly on 2026-09-09, read-only, no writes. Earliest era returning 15m data:

| earliest available | instruments |
|---|---|
| **2017-08** | NIFTY50, BANKNIFTY, FINNIFTY, NIFTYNXT50, BANKBEES, AXISBANK, ASIANPAINT, BAJFINANCE |
| 2019-01 | NIFTYBEES |
| 2023-01 | MIDCPNIFTY (nothing earlier) |

Sessions come back complete — 25 bars each — and holidays are correctly absent (the 2017-10-02 probe
starts on 10-03, Gandhi Jayanti). Prices are era-appropriate: 10,101 in Aug 2017, 18,102 in Jan 2023,
~23,500 now, so the API is serving real history rather than echoing a recent window.

**Correction to the v2 program's feasibility note.** That document says the nine instruments carry
15m "back to 2025-01-01" and reasoned as though that were the limit. It was an artefact of the query
that produced it (`WHERE open_time >= '2025-01-01'`). Actual stored coverage:

| instrument | sessions stored | stored from |
|---|---|---|
| NIFTY50, BANKNIFTY | **915** | 2023-01-02 |
| FINNIFTY, MIDCPNIFTY, NIFTYNXT50 | 542 | 2024-06-03 |
| NIFTYBEES, AXISBANK, ASIANPAINT, BAJFINANCE | 394 | 2025-01-01 |
| BANKBEES | 48 | 2026-06-08 |

So **2023–2024 for NIFTY50 and BANKNIFTY needs no collection at all.** v2's use of a 2025 common
window was still the right call for a balanced nine-instrument panel; the error is only in the claim
that longer history did not exist.

### Two properties of this data that constrain what may be asked of it

- **Index volume is zero in every era probed** (0 for all five indices; present for the ETFs and
  single names). ICT is unaffected. **`momentum-scalp` cannot be tested on index history** because it
  needs VWAP — though it *could* be tested on NIFTYBEES, BANKBEES or the single names, which do carry
  volume. That is a separate program.
- **Some index history predates the index.** FINNIFTY returns 2017 data despite launching in 2021, so
  those values are back-computed by the exchange, not traded. Any instrument-era where the index did
  not yet exist as a tradeable product is reported separately and never pooled into a headline.

## Design: sequential, and each set looked at once

**Set A — no collection required. NIFTY50 and BANKNIFTY, 2023-01-02 .. 2024-12-31.**
Already stored, and genuinely out-of-sample relative to the 2025 discovery. Run once.

**Set B — requires collection. NIFTY50 and BANKNIFTY, 2017-08 .. 2022-12-31.**
Run **only if Set A passes.** Earning it is the point: a failed Set A ends the program without
spending a collection job or a second era.

**Set C — the tracker resolution. NIFTYBEES 2019-01 .. 2024-12-31, requires collection.**
Run **only if Set A passes**, on the window overlapping Set A and B. This is what actually settles
the user's question, because it is the only independent read on NIFTY exposure.

Execution settings are fixed now and match the measurement that produced the hypothesis: 15m,
`--max-concurrent-positions=5`, `--initial-capital=5000000`, `--slippage-bps=2`, engine defaults
(`invertedBlocksRemainPoi=false`, `requireKillzone=false`, `requireOte=false`,
`poiPreference=SWEEP_FIRST`).

**One hypothesis, three sequential sets, each looked at once.** No multiplicity correction beyond
that, because the sequence is fixed here and no set may be re-scored or re-run.

## Estimator

Unit of analysis is the trade; SE clustered on IST session date. Reported per set: trades, clustered
sessions, mean P&L per trade, clustered SE, t — **and the same per calendar year**, never only
pooled. Nine years spans COVID and several volatility regimes, and a pooled number would hide a
result that lives in one of them.

## Decision rule

Set A passes only by clearing **all three**:

- **A1 — sign and significance on NIFTY50.** Mean per trade > 0 with clustered **t > 2.0**.
- **A2 — year consistency.** Positive in **both** 2023 and 2024 independently. A result carried by
  one year is a regime observation, not an edge.
- **A3 — the control behaves.** BANKNIFTY reported alongside. BANKNIFTY *positive and significant*
  too would falsify the framing of this program (the hypothesis is NIFTY-specific) and is recorded as
  REFRAME rather than as a pass.

Set B passes only by clearing A1 and A2 on 2017–2022, plus:

- **B1 — year sign test.** Positive in at least **5 of the 6** years. Under the null,
  P(>=5 of 6) = 7/64 = 0.109, so 5 of 6 is *suggestive only*; **6 of 6** (p = 0.016) passes.

Set C is the decider:

- **C1 — the tracker must agree in sign** with NIFTY50 over the overlapping window, price-normalised.
  If NIFTYBEES stays negative while NIFTY50 is positive, the verdict is
  **INDEX_ARTEFACT_NOT_TRADEABLE_EDGE** regardless of how well Sets A and B did.

## Pre-committed threats to validity

- **The index is not tradeable.** Every figure here is index points at quantity 1 with 2bps slippage.
  A real position is options, which adds spread and theta the backtest never pays — and on the live
  book friction is already 54.5% of a -76.5R result. **A pass licenses an options-space costing
  study, never a live deployment.**
- **Back-computed index history**, as above.
- **Regime span.** 2017–2024 includes COVID. Per-year reporting exists for this; a single dominant
  year is reported as such.
- **Discovery era excluded.** 2025 must not appear in any set, and no set may be re-run after being
  scored. If a set is run in error, it is burned and the program ends.
- **The strategy remains TERMINAL_UNOWNED throughout**, and `operationalDisposition` keeps it out of
  live proposals. Nothing in this program changes that; a pass would require its own promotion
  decision.

## Stopping condition

If Set A fails, the verdict is **NO_NIFTY_SPECIFIC_EDGE** and the question is closed with the 2023–2024
evidence attached — no collection is performed. If Set A passes and Set C contradicts it, the verdict
is INDEX_ARTEFACT_NOT_TRADEABLE_EDGE. Only A, B and C all passing licenses further work, and the next
step then is costing in options space, not trading.

## Results — Set A, 2023-01-02 .. 2024-12-31 (looked at once)

Stored data, no collection. 495 sessions per instrument, 24.8 bars each, 246 in 2023 and 249 in 2024
— verified complete before the run. Both runs completed; no OOM, no re-scoping.

**A1 — NIFTY50 whole window**

| instrument | trades | sessions | net | mean/trade | SE | t |
|---|---|---|---|---|---|---|
| **NIFTY50** | 345 | 85 | **-14,061** | **-40.76** | 29.8 | **-1.37** |
| BANKNIFTY | 234 | 72 | -11,960 | -51.11 | 95.0 | -0.54 |

Required mean > 0 with t > 2.0. **FAILED** — the sign is negative before significance is even reached.

**A2 — per calendar year**

| instrument | year | trades | sessions | net | mean/trade | t |
|---|---|---|---|---|---|---|
| NIFTY50 | 2023 | 172 | 39 | -2,112 | -12.28 | -0.54 |
| NIFTY50 | 2024 | 173 | 46 | -11,949 | -69.07 | -1.35 |
| BANKNIFTY | 2023 | 131 | 42 | -17,825 | -136.07 | -1.89 |
| BANKNIFTY | 2024 | 103 | 30 | +5,865 | +56.94 | +0.28 |

Required positive in both years. **FAILED** — NIFTY50 is negative in both.

**A3 — control.** BANKNIFTY is also negative over the window, so the framing is not falsified by a
control that unexpectedly wins. No REFRAME. (Note BANKNIFTY's own years disagree, -136.07 then
+56.94, which is the instability this strategy has shown at every scale.)

### What this settles

The 2025 discovery was noise, and the confirmation set says so with more evidence than the discovery
had:

| era | trades | clustered sessions | mean/trade | SE | t |
|---|---|---|---|---|---|
| 2025 (discovery) | 91 | 29 | **+97.61** | 80.2 | 1.22 |
| 2023-2024 (Set A) | 345 | 85 | **-40.76** | **29.8** | -1.37 |

Nearly four times the trades, nearly three times the clustered sessions, and the standard error falls
from +-80 to +-30 exactly as the power argument predicted. The estimate does not merely fail to
confirm — it lands on the other side of zero. Same instrument, same timeframe, same settings,
opposite sign.

Stated precisely: **there is no evidence of a NIFTY-specific edge, and the point estimate is
negative** (t = -1.37 is not significantly negative either — it is indistinguishable from zero, which
is itself the answer for a strategy that has to clear option spread and theta to be traded).

### Verdict

**NO_NIFTY_SPECIFIC_EDGE.**

Set A failed A1 and A2, so per the stopping condition the question closes here. **Sets B and C are
not earned and no collection is performed** — the 2017–2022 era and the NIFTYBEES resolution stay
unspent, which is the whole point of sequencing them behind A. The Fyers history remains available
(2017-08 for eight instruments) if a future, differently-motivated program wants it.

`ict-structure-v1` stays `TERMINAL_UNOWNED`, and this is now the third independent line saying so:
the four-pillar gate, the entry-model replication across nine instruments, and now a NIFTY-specific
confirmation set on 3.8x the discovery sample.
