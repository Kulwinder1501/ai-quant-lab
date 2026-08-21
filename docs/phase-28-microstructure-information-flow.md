# Phase 28 — Microstructure & Information Flow

**STATUS: PHASE 0 COMPLETE (PASS). PHASE 2 BUILT. PHASE 1 NOT STARTED.**

This is a **research programme, not a production strategy**. Its goal is to discover whether
short-horizon order-flow information exists on the instruments this system trades, is *incremental*
to what we already compute, and survives execution costs. A terminal negative outcome is a
legitimate result and the most likely one, on this codebase's own track record.

Supersedes nothing. Runs alongside the volatility track, which remains the only signal here with
replicated skill.

---

## 0. Why this phase exists

The directional scalp track is finished, and Phase 28 exists because the cheaper levers are gone —
not because microstructure is fashionable.

`momentum-scalp-index` was measured at every bar size it could be fed, on both indices. Nothing
survives break-even, its own baseline, **and** cross-instrument replication together:

| timeframe | source | NIFTY50 | BANKNIFTY |
|---|---|---|---|
| **1m** | live closed paper trades | −Rs 2,531 / 29 trades / 41.4% win | −Rs 11,327 / 60 trades / 30.0% win |
| **3m** | derived from audited 1m, session-anchored | LONG 36.2% dead; SHORT 42.1% clears both | LONG 38.0% dead; SHORT 40.4% **below baseline** |
| **5m** | A→B gate, cost-aware, 12,134 trades | net@2bp −0.3887 CI [−0.4731, −0.3044] | net@2bp −0.3092 CI [−0.3790, −0.2393] |
| **15m** | tier measurement, frictionless | LONG 19.2% dead; SHORT 38.0% dead | LONG 41.9% clears by 0.9pp; SHORT 39.0% dead |

Two readings matter:

- **The one apparent winner does not replicate.** NIFTY50-3m-SHORT clears break-even *and* beats its
  unconditional baseline. BANKNIFTY-3m-SHORT sits *below* its baseline on the same rule — the
  geometry carrying it, not the selection. A signal that works on one index and not the other is
  drift. This is the same shape as the HTF-confluence failure.
- **The apparent winners are what you would expect from the search itself.** Eight side/timeframe
  cells were compared with no multiplicity correction. One thin pass is the null hypothesis
  behaving normally, not a discovery. Applying the source plan's own R6 discipline to *our own*
  sweep disqualifies it.

The A→B gate already established the mechanism: gross expectancy on the indices is *positive*
(+0.0301 R/day) but round-trip cost is 0.3764 R/trade. The signal is real and roughly 13× too small
to pay friction. The stop-multiple and horizon sweeps then exhausted both levers that move cost
without touching the signal (`NO_VIABLE_STOP_MULTIPLE`, `NO_VIABLE_HORIZON`).

**Therefore: more timeframe hunting on this architecture is not a strategy. A different information
source is.** 1m was dropped from `momentum-scalp-index` on 2026-08-20 for this reason; 5m remains
enabled and is a known-dead configuration surviving on a small live sample.

---

## 1. Phase 0 — Data feasibility spike (COMPLETE: **PASS**)

The programme's centrepiece signals (OFI, microprice) need per-level order-book **sizes**. Everything
this system ingests today is last-traded-price plus best bid/ask *price only* — no sizes, no depth.
So the first question was not "how do we build OFI" but "does the vendor even expose the data".

An initial reading of our own code said no, and **that was wrong** — it described what our code
*asks for*, not what Fyers *offers*. Verified directly against the live feed on 2026-08-21 during
market hours.

### What was verified

`fyers-api-v3@2.1.0` (already installed) exports a fourth socket we do not use: `fyersTbtSocket` —
the tick-by-tick depth feed, separate from the `fyersDataSocket` (HSM) that
`FyersLiveStreamer` wraps. A throwaway spike subscribed to one live BANKNIFTY option in `depth`
mode and captured six consecutive frames.

**Symbol: `NSE:BANKNIFTY26AUG57700CE`** (near-ATM, monthly expiry 2026-08-25):

| requirement (from the source plan) | result |
|---|---|
| per-level **bid size** | ✅ present |
| per-level **ask size** | ✅ present |
| per-level **order counts** | ✅ present |
| depth levels populated | ✅ **50 bid / 50 ask**, arrays sized 50 |
| **sequence number** | ✅ 32648 → 32653, strictly increasing |
| snapshot vs incremental | ✅ frame 1 `snapshot=true`, frames 2-6 `false` |
| exchange feed timestamp | ✅ present (`feedTime`) |
| vendor send timestamp | ✅ present (`sendTime`) |
| total buy / sell quantity | ✅ `tbq` / `tsq` present |

A control run on `NSE:BANKNIFTY26AUGFUT` also streamed cleanly (top-of-book bid 57725×30 in 1 order,
ask 57749.6×30 in 1 order, `tbq` 37,350, `tsq` 84,330).

### What this changes

Every "does not exist" in the earlier feasibility audit that concerned **data availability** is
withdrawn. OFI, microprice, and the plan's raw-event provenance requirements (sequence number,
exchange *and* vendor timestamps, derivable gap/duplicate flags) are all **buildable on the free
API tier we already pay nothing extra for**. The snapshot-then-delta model is exactly the shape OFI
reconstruction wants.

The gap is now *our ingestion path*, which is ordinary engineering — not a vendor capability we
cannot obtain.

### Caveats found in the same spike — read these before building

1. **Timestamps are second-granularity, not milliseconds.** `feedTime` and `sendTime` both returned
   `1787300311` with a zero difference. This is fatal to any latency or lead/lag estimate finer than
   1s built on vendor fields alone. Sub-second work must stamp our own monotonic receive time at the
   socket boundary and treat vendor timestamps as coarse. The plan's `1s`-to-`60s` IC ladder is
   reachable; anything tighter is not, from these fields.
2. **Auth differs from the socket we already use.** `fyersTbtSocket` takes the **raw access token**.
   `fyersDataSocket` takes `appId:accessToken`. Passing the HSM form to TBT connects and then
   silently delivers nothing — no error, no `servererror`. This cost most of the spike's debugging
   time and will do the same to the next person.
3. **Channel ids are strings, and a channel must be resumed.** `subscribe(symbols, '1', 'depth')`
   registers but does not activate; `switchChannel([], ['1'])` is required, with **arrays**, not
   Sets. Wrong types here also fail silently.
4. **Vendor SDK bug, benign.** `tbtSocket.js` `getUrl()` references an unimported `https` and throws
   `ReferenceError` on every construction. It is caught, logged, and falls back to the hardcoded
   `wss://rtsocket-api.fyers.in/versova`, which works. Expect the stderr line; it is not our bug.
5. **Unverified: simultaneous quote + depth on one connection.** A community report says combining
   `SymbolUpdate` and `DepthUpdate` yields silence. We did not test it, and we do not need to —
   TBT is a physically separate socket from the HSM one the scheduler already holds. Two connections
   is the assumed design. **Not yet verified: whether Fyers caps concurrent connections per app**,
   which matters because the scheduler and both live collectors already hold sockets open.
6. **TBT coverage is NFO-only.** Futures and options are in scope; cash equities are documented as
   "on their way". This is fine — the system trades index options — but it forecloses ever extending
   these signals to the 20-equity pool used elsewhere.

---

## 2. What exists, what must be built

Audited against `apps/api/src` on 2026-08-21.

| plan component | status | reality |
|---|---|---|
| L2 depth / OFI / microprice **data** | ✅ **available** | `fyersTbtSocket`, 50 levels with sizes + order counts. Verified live. |
| Depth **ingestion path** | ❌ build | Nothing subscribes to TBT. `FyersLiveStreamer` wraps the HSM socket and parses LTP/best-bid/ask only (`parseTick`). |
| Raw event **storage** | ❌ build | No table has sequence numbers, dual timestamps, dedup flags, or payload hashes. `candles` and `option_premium_ticks` carry a single `received_at`/`observed_at` each. Finest stored granularity is 1m bars. |
| `LOOKAHEAD_VIOLATION` runtime guard | ❌ build | Zero matches for `LOOKAHEAD`/`FEATURE_LAG`/`featuresAsOf` in the tree. Only migration `048` (a one-off retroactive purge of look-ahead SMC snapshots) plus unit-test invariants. |
| Negative-lag diagnostic, placebos | ❌ build | Not present in any form. |
| Half-life / IC ladder, Hayashi–Yoshida | ❌ build | Not present. |
| DSR, PBO/CSCV, hypothesis ledger | ❌ build | Not present. **Adjacent rigor does exist** and should be reused first: `expectancy-statistics.ts` does day-level paired deltas with a real Holm–Bonferroni correction. That answers "is A better than B" for a small family; PBO/DSR answer "is this the best of N searched", which is a different question we do not have yet. |
| Era-based statutory costs | ⚠️ partial | `brokerage-calculator.ts` is a genuine itemized options model (brokerage, STT, exchange 0.03503%, SEBI, GST 18%, stamp duty) — but every rate is a module-level `const` with **no effective-date concept**. Re-costing history under the rate then in force is impossible today. |
| Execution realism (queue, partial fills) | ❌ build | Paper fills price against LTP/premium marks. No queue model. Now *possible* given order counts per level, which was not true before Phase 0. |

**Naming trap:** `sequence-readiness.ts` is **not** exchange sequencing. It is an ML training-data
sufficiency gate (bar counts, session counts, zero-volume fraction). Do not conflate them.

---

## 3. Corrections to the source plan

The plan as written contains four factual errors. Recorded here so they are fixed once rather than
propagated into implementation.

1. **"Options STT 0.15%" is wrong.** The code uses `OPTION_SALE_STT_RATE = 0.001` (0.1%) on premium
   turnover, which matches the real post-October-2024 rate. There has never been a 0.15% options STT.
   A separate `EXERCISED_OPTION_STT_RATE = 0.00125` (0.125%) correctly models ITM-expiry on intrinsic
   value as a distinct taxable event. **Do not "fix" the code to match the plan.**
2. **"Futures STT 0.05%" has nothing to attach to.** There is no futures trading and no futures cost
   path anywhere in this codebase. If futures enter scope (the TBT spike's control run was a futures
   contract), the cost model must be built, not amended.
3. **The CAS rule is probably inapplicable.** Closing-auction sessions govern eligible **cash-market
   stocks**. This system trades index options, where derivatives continue past the cash close. The
   `15:10` entry cutoff may still be worth having for liquidity reasons, but it should be justified
   on its own terms, not as CAS compliance. **Confirm before implementing.**
4. **"2026 is contaminated" is right, and stronger than the plan states.** The index 2026 block was
   consumed by the A→B gate *and* both cost sweeps. Three passes, not one. Any Phase 28 result
   claimed on 2026 index data is in-sample by construction. This is precisely why Phase 28 must
   forward-accumulate.

---

## 4. Staged plan, with gates

Each stage has a stop condition. No stage begins until the previous one passes. The point of the
staging is that the cheap, reusable work (R0) lands before the expensive, speculative work (signals).

**Phase 0 — data feasibility.** ✅ **PASS** (§1). Depth with sizes, order counts, and sequencing is
available on the instruments we trade.

**Phase 1 — raw event capture.** A `TbtDepthStreamer` alongside the existing streamer (separate
socket, raw-token auth, string channels). A new append-only table storing, per frame: ticker,
sequence number, `feedTime`, `sendTime`, our own millisecond receive time, snapshot flag, and the
level arrays. Derive gap/duplicate flags from sequence discontinuity rather than trusting the feed.
*Gate:* a full session captured with a quantified sequence-gap rate. Publish the gap rate; a feed we
cannot characterise is not a feed we can research on.

**Phase 2 — R0 falsification harness.** ✅ **BUILT**, ahead of Phase 1 and deliberately so: it is
the only component whose value survives the programme failing, and it can be built and tested
without a single byte of depth data. Landed as `apps/api/src/modules/research/domain/`:

- `lookahead-guard.ts` — reusable runtime `LOOKAHEAD_VIOLATION`, comparing feature-as-of against
  decision time. Refuses an *unverifiable* timestamp as its own violation class rather than passing
  it, because an invalid `Date` compares false against every bound and a naive check therefore
  reports compliance exactly where it knows least.
- `information-coefficient.ts` — Spearman IC (Pearson alongside, since the gap between them
  reveals outlier dominance), averaged ranks so a quiet constant book contributes nothing rather
  than a spurious ordering, seeded percentile bootstrap. Returns `null`, never `0`, when a series is
  constant: `0` asserts a measured absence, `null` says nothing was measurable, and conflating them
  lets a broken pipeline read as an honest negative.
- `placebos.ts` — sign-flip, block permutation, circular shift, wrong-day-matched-time. All seeded;
  an unreproducible band invites re-rolling until the real signal clears.
- `falsification-harness.ts` — orchestrates the above into one verdict, with the failure ordering
  described below.

**The band is self-calibrating.** There is no hard-coded "significant IC" threshold, because such a
number is a free parameter inviting exactly the tuning the harness exists to prevent. `placeboBand`
is the largest absolute IC any label-destroying transform achieves, and the real IC must beat it.
This automatically widens the bar on data that is easy to spuriously correlate — which order-flow
data is, since both book imbalance and short-horizon returns are strongly autocorrelated.

**One calibration trap, found by its own tests and worth not reintroducing.** The first version
judged negative lags against `placeboBand` too. That is wrong: the band is a *maximum over several*
placebo draws, so on a clean informative feature the placebos collapse toward zero and the band goes
tiny — while a single lag probe still carries `~1/sqrt(n)` sampling noise. It failed legitimate
signals for "predicting the past" roughly half the time, including deliberately injected perfect
foresight. The lag threshold is now `max(placeboBand, sigma / sqrt(n - 1))`: the first term catches
autocorrelation-driven spurious correlation that an analytic floor is blind to, the second stops a
tiny band from manufacturing failures. Neither alone suffices.

**Verdict ordering is load-bearing**, not stylistic: a look-ahead violation short-circuits before any
IC is reported (a leak corrupts every lag equally, so reporting lags would dress a bug up as a weak
result); a placebo breach outranks any signal claim, because a result from a broken instrument is not
a result.

*Gate — met:* 52 tests, 4 files. The two integrity tests the source plan specifies both hold. Test A:
evidence dated 1ms after the decision fails closed with `FAIL_LOOKAHEAD`. Test B: a feature that *is*
the forward return reports |IC| ≈ 1 with a bootstrap interval above 0.9 while every placebo stays
below 0.5 — proving the instrument is sensitive enough that its PASS verdicts mean something. Pure
noise returns `NO_SIGNAL`; a feature that is a stale copy of a return three observations old is
caught by the negative-lag probe rather than by anything else.

**Phase 3 — signal construction.** OFI from level-size deltas between sequenced frames; microprice
from top-of-book sizes; quote-imbalance and spread dynamics as cheaper companions. Every signal
point-in-time by construction and run through Phase 2's harness.

**Phase 4 — incremental value.** IC across the 1s–60s ladder with bootstrap uncertainty, and
half-life. The question is not "does OFI predict" but "does it predict *beyond* what the existing
indicator set already captures". A signal that merely rediscovers Supertrend is not incremental.
*Gate:* significant IC that survives every placebo, at a horizon longer than our observed
decision-to-order latency. A signal with a half-life shorter than our reaction time is unmonetizable
regardless of significance.

**Phase 5 — cost-aware gate.** Reuse `expectancy-statistics.ts` (day-level paired deltas + Holm) and
cost through `brokerage-calculator.ts` in premium space — not the flat-bps ETF model. The A→B gate's
lesson applies unchanged: a positive gross edge means nothing against 0.3764 R/trade of friction.
*Gate:* non-negative net expectancy at the declared endpoint on **both** indices independently.
Cross-instrument replication is mandatory, per §0.

**Phase 6 — execution realism, and only here.** Queue position and passive-fill probability, now
tractable given per-level order counts. Deliberately last: it is the most expensive component and is
wasted effort on a signal that has not cleared Phase 5.

**Deferred indefinitely:** DSR/PBO/CSCV and the hypothesis ledger. These control for selection
across many searched variants. Build them when there are many variants to control for — building
them now is solving a problem we do not yet have. Until then, Holm over a small pre-declared family
is the honest tool, and §0 shows we already need it.

---

## 5. Pre-registered kill conditions

Written before the data arrives, so they cannot be renegotiated afterwards.

- **Phase 1:** sequence-gap rate too high to reconstruct a book → `FEED_NOT_RECONSTRUCTIBLE`, stop.
- **Phase 2:** any placebo returns non-zero IC, or the injection test fails to fire →
  `HARNESS_NOT_TRUSTWORTHY`. Fix the harness; do not proceed on an unverified one.
- **Phase 4:** IC indistinguishable from placebo → `NO_INFORMATION_FLOW_SIGNAL`, stop.
- **Phase 4:** half-life shorter than measured decision-to-order latency → `SIGNAL_FASTER_THAN_US`,
  stop. This is a real and likely outcome for OFI at retail latency and must not be argued away.
- **Phase 5:** negative net expectancy on either index → `MICROSTRUCTURE_DOES_NOT_CLEAR_COSTS`, stop.
  Do not retune to force it. This is the condition that killed the scalp track, and it is the single
  most probable terminal outcome here.
- **Any stage:** a result that holds on one index and not the other is drift, not edge. Record and
  stop rather than pooling it away.
- **Never:** do not re-derive a threshold, window, or horizon from the data being tested.

---

## 6. Open questions

- ~~**Concurrent connection limits.**~~ **Substantially answered.** The Phase 0 spike ran while
  `scheduler-v2`, `live-collector-v2` and `live-collector-scalp-v2` were all up and holding sockets,
  and the TBT connection opened and streamed normally as a fourth. That is evidence a fourth
  concurrent connection is fine on this app tier; it does not locate the actual cap, so a Phase 1
  ingester that subscribes many symbols should still watch for connection-level errors rather than
  assume headroom.
- **TBT retention and volume.** At 1000+ updates/second per active symbol, storing raw frames for a
  full option chain is a materially different storage problem from 1m bars. Scope the subscription
  narrowly (a handful of ATM contracts) and measure the write rate before widening.
- **Is TBT gated?** Public docs do not state whether TBT carries eligibility or cost beyond the free
  API. It worked on this account today; that is evidence, not a guarantee of terms.
- **Does the volatility track want this data?** The one signal here with replicated skill is
  volatility expansion. Depth data may serve it better than it serves a new directional hunt. Worth
  asking before committing to Phases 3-6.
