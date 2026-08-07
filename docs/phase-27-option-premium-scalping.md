# Phase 27 — Scalping NIFTY option premiums

**Written 2026-08-07. Not started.** Every figure below was measured against the live book or
the stored series on that date, and the measurement command is given so it can be re-run
rather than trusted.

The goal: let the paper-trading bot scalp NIFTY option premiums on a 1-minute signal.

---

## 0. Read this first

Two proposals were on the table. Both are rejected here, and the reasons are the whole point
of the document — they are the constraints any plan has to satisfy.

- **Approach 1 — trade the futures chart.** Leave `momentum-scalp` alone, feed it NIFTY
  futures bars (which carry real volume, so VWAP works), map the futures symbol back to the
  spot chain for option execution.
- **Approach 2 — swap VWAP for a 50 EMA.** Keep scanning spot, remove the volume dependency
  by replacing VWAP with a third EMA, bump the strategy to v3, re-enable 1m scanning.

### Why neither works as written

**1. The option chain is observed 17 times a day.** Every 15 minutes, 09:15–15:30 IST.

```bash
docker exec ai-quant-lab-db-v2 psql -U ai_quant_lab -d ai_quant_lab -c "SELECT underlying_symbol, count(DISTINCT observed_at), min(observed_at)::time, max(observed_at)::time FROM option_chain_snapshots WHERE observed_at > CURRENT_DATE GROUP BY 1"
```

Both approaches change which **index** series feeds the signal. Neither creates option data. A
one-minute scalp entered, marked and exited against a fifteen-minute-old book has an invented
exit price — the same class of defect as the model mark that reported +Rs 2,032 on a position
down Rs 651 (see `pending-work.md` §4.1).

This is the binding constraint. It is not a strategy problem and no strategy change touches it.

**2. There are no futures instruments.** Approach 1 has no starting point:

```bash
docker exec ai-quant-lab-db-v2 psql -U ai_quant_lab -d ai_quant_lab -c "SELECT symbol FROM instruments WHERE instrument_type LIKE '%FUT%'"
-- (0 rows)
```

It is not "leave the strategy as-is and change the data". It is: build a futures instrument
universe, a monthly rollover, a futures feed, and a futures→spot mapping — before the first
bar exists. The monthly rollover is permanent maintenance, and this project has already booked
two trades against a contract that did not exist.

**3. Approach 2 is not re-enabling `momentum-scalp`.** It already carries `EMA_FAST` and
`EMA_SLOW`; adding a third EMA in VWAP's place produces a different strategy wearing the same
name. `v3` makes an unvalidated strategy look versioned. And the original is a **settled
negative result** — it loses on 1d even frictionless, and the low-volatility edge that looks
real decays out of sample. Both approaches spend their effort enabling a strategy already
measured to lose.

### What both missed

**Options have real traded volume.**

```
NIFTY50 24550 CE   volume 80,680,470   OI 7,336,745      (live, 2026-08-07)
```

The VWAP problem exists only because the bot signals on the *index*, which reports
`volume: 0`. Scalp the option contract itself and VWAP is mathematically valid, with no
futures rollover and no EMA substitute. The problem dissolves instead of being worked around
— and it is what the original request actually asked for.

---

## 1. The bar to clear

Round-trip cost on the live ATM NIFTY 24550 CE (ask 132.35, bid 132.00, lot 75), entering at
the ask and exiting at the mid, through `calculateEntryFees` / `calculateExitFees`:

| position | round-trip cost | % of premium | breakeven | fees as share of cost |
|---|---|---|---|---|
| 1 lot (75) | Rs 78.76 | 0.79% | **2.1 index pts** | 83% |
| 2 lots | Rs 110.32 | 0.56% | 1.47 pts | 76% |
| 5 lots | Rs 205.00 | 0.41% | 1.09 pts | 68% |
| 10 lots | Rs 362.81 | 0.37% | 0.97 pts | 64% |

Breakeven in index points assumes ATM delta ≈ 0.5.

Against NIFTY 1m bars, 750 bars over 05–06 Aug:

| metric | value |
|---|---|
| average range | 7.53 pts |
| median range | 6.65 pts |
| p90 range | 11.71 pts |
| **average body** | **3.90 pts** |

**At one lot the breakeven is 54% of an average 1m bar's body.** Two things follow, and both
matter more than the strategy choice:

- **Position size dominates.** Going from 1 lot to 5 halves the breakeven, because 83% of the
  cost at one lot is fixed brokerage rather than proportional charges. Any viability test run
  at one lot will reject a strategy that is fine at five.
- **Cost scales with trade count, and an edge does not.** At one lot: 5 trades/day = Rs 394
  (4.0% of a lot's premium), 10 = Rs 788 (7.9%), 20 = Rs 1,575 (**15.9% per day**). This is
  what makes scalping different from a strategy that holds for days — the same 0.79% is paid
  again on every entry.

Consistent with the straddle-economics measurement (0.82–1.05% of premium, fees 3.3x the
spread) and with the trap-tolerance work: **fees dominate, not the spread.** Spreads on these
contracts are 0.26–0.28%.

---

## 2. The plan

Ordered so the expensive step is last and conditional.

### Step 1 — Collect option premiums at scalping cadence

Nothing else is possible without this, and it is a prerequisite for **both** rejected
approaches too, so it is not wasted work under any outcome.

Poll the Fyers quotes endpoint for specific ATM contracts every 15–30 seconds and aggregate
into a 1m premium series.

What already exists and should be reused rather than reimplemented:

- `FyersLiveMarketDataProvider` — symbol-based quote polling, chunked at 50 symbols, tested.
  Returns `cumulativeVolume`; for an option this is a real number, unlike an index.
- `CollectLiveMarketData` — aggregates quotes into bars of any timeframe, and since
  2026-08-07 refuses to seal a window it did not watch from the start.
- `resolveFyersSymbol` — passes a fully-qualified `EXCHANGE:SYMBOL` through untouched, which
  is the escape hatch for contract names it deliberately does not model.
- `option_expiry_calendar` + `resolveListedExpiry` — contract selection must come from here.
  Deriving an expiry from a weekday rule is how the phantom BANKNIFTY contract got booked.

What is new:

- **Contract selection.** Which strikes to poll, refreshed as spot moves. ATM plus a small
  band; the strike must come from `nearestStrike(spot, strike_step)`, never a price-level
  guess — BANKNIFTY once got 50-point strikes that do not exist.
- **An instrument row per contract, or a separate premium table.** Open question, see §4.
- **Provenance.** `candle_series_provenance` requires one declared source per
  (instrument, timeframe). Option premium bars are live-aggregated and there is no historical
  backfill for them, which makes them a different kind of series from an index — decide
  before writing, not after.

Cadence note: 15–30s polling of a handful of symbols is well inside the rate limit that
answers 429 after roughly a dozen rapid calls, but the ATM band should be bounded, not the
whole chain.

### Step 2 — Measure, before any strategy work

With a real premium series, "does a 1m signal beat 2.1 index points of cost" stops being an
argument and becomes a query. Two weeks of collection is enough to reject it cheaply.

The test must be run **at a realistic lot count**, for the reason in §1 — a one-lot test
rejects strategies that work at five.

Use the discipline that is already established here: CPCV, compare **both** accuracy and
macro-F1 against trivial (`beatsTrivial`), and treat a macro-F1 win alone as class-spreading
rather than signal. That combination has already killed one directional target in a single
run.

This project has three settled negative results — direction, RAG retrieval, momentum-scalp —
and every one of them was cheaper to measure than to build.

### Step 3 — Implement, only if step 2 clears

Signal on the premium series directly, not on the index. VWAP included, because the volume is
real. Route entries through `PrepareOptionEntry`, which already carries the expiry-calendar
gate, the observed-ask fill and the pre-trade checklist — do not build a second path; that is
what §4.16 of `pending-work.md` is about.

A scalp additionally needs something the current design does not have: **the exit must be
enforceable at scalping speed.** `EvaluateOpenPaperTrades` runs on the bot's 5-minute cron
and marks against a chain snapshot only if it is under 40 minutes old. A 1-minute scalp needs
its stop checked against the same 15–30s premium series it entered on. That work belongs in
step 3 and should be scoped with it.

---

## 3. What is already in place

From the 2026-08-07 session, so none of it needs redoing:

- The bot opens paper option positions through `PrepareOptionEntry` — one gated path, shared
  with the HTTP route. 15 tests, mostly refusals.
- It scans a timeframe a strategy actually supports, and `assertScannableTimeframes` refuses
  to start otherwise. It previously scanned 5m, which no strategy has ever supported.
- The volume guard reads a zero as an absent feed when no bar within a week carried volume,
  which is what unblocked entries after Yahoo stopped supplying index 1d volume on 01 Aug.
- `live-collector-v2` runs the 15m collector as a compose daemon and refuses to seal a
  partially-observed window.
- Position limits: 4 concurrent, one per contract.

---

## 4. Open questions

Decide these before writing code, not during.

1. **Where do option premium bars live?** An `instruments` row per contract makes them
   first-class and reuses every existing series mechanism, but creates a row per strike per
   expiry and interacts with `candle_series_provenance`. A dedicated table avoids the churn
   but duplicates the candle machinery. Leaning toward instrument rows for contracts actually
   traded, created on demand.
2. **How wide is the polled ATM band, and how does it follow spot?** Too narrow and the
   signal's own contract is missing when spot moves; too wide and it is a rate-limit problem.
3. **What lot size is the strategy tested at?** This changes the answer, per §1. It should be
   stated in the study, not discovered afterwards.
4. **Does the 15-minute chain remain the mark for held positions**, with the premium series
   used only for entry and exit? Two marking sources for one position is exactly the
   inconsistency that put the entry on one volatility surface and the exit on another.

---

## 5. Honest assessment

The cost structure makes 1-minute option scalping hard at one lot and marginal at five. This
system's one measured edge is volatility expansion, not direction, and `momentum-scalp` is a
measured negative.

That is an argument for measuring it properly, not for refusing. And **step 1 is worth doing
regardless of the outcome**: a 15-minute chain also limits stop and target enforcement on
positions the bot already holds, so a faster premium series improves the existing path even
if the scalp never ships.
