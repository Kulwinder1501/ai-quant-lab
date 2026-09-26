# Phase 28 — Microstructure & Information Flow

**STATUS (2026-09-15): FIRST CLEAN PHASE 4 PASS, ON TWO DAYS, ONE INSTRUMENT. §7's 2026-09-11
single-day blind read reported NO_SIGNAL at 30s/60s, but that verdict rested on a broken placebo —
`wrongDayMatchedTime` is a documented no-op when only one calendar day is present, and it happened to
be the largest-magnitude placebo at both horizons, so it alone set a band that was never really
active. Re-running the *same* capture session (which spans 2026-09-10 and 2026-09-11, both already
post the 2026-09-09 pre-registration and never previously combined) gives the placebo two real days
to swap between. Result: **PASS at 30s (IC −0.081, band 0.0044) and 60s (IC −0.078, band 0.0140)**,
consistent in sign and magnitude with the earlier 6-session diagnostic. See §7's closing update for
full detail and the caveats that still apply — this is one 2-day window on one instrument
(BANKNIFTY futures; no NIFTY50 depth exists), not yet a replicated result, and Phase 5 (cost-aware
gate) has not started.

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

**Phase 1 — raw event capture.** ✅ **BUILT AND RUNNING LIVE.** Components:

- `migrations/070-depth-frames.ts` — append-only event log. **No unique constraint on
  `(provider_symbol, sequence_no)`**, which looks like an omission and is the design: a replayed
  sequence number is the finding, and a unique index would turn it into an insert error the
  collector has to swallow or die on. Duplicates are flagged and kept. A CHECK enforces that all six
  level arrays share a length and that `levels_stored <= levels_available`.
- `domain/depth-frame.ts` — vendor payload → storable event. Copies every array, because the SDK
  keeps **one mutable `Depth` object per symbol** and hands the same instance to every callback; a
  buffer of references would end a session holding N pointers to the final book. Also exports
  `microprice`, as the cheapest possible proof the captured data supports what Phase 3 needs.
- `domain/depth-frame-sequencing.ts` — gap/duplicate/regression classification and the gate metric.
  **A snapshot is not a gap:** the feed re-bases on snapshot, so the sequence number can jump
  arbitrarily and legitimately, and calling that loss would report a healthy reconnect as a broken
  feed. This is the module's most likely false alarm and is tested directly.
- `application/capture-depth-frames.ts` — buffering and continuity stamping.
- `infrastructure/market-data/fyers-tbt-depth-streamer.ts` — the socket, with all four
  silent-failure conventions encoded and tested.
- `repositories/postgres-depth-frame-repository.ts` — batched append. At feed peak a
  row-per-INSERT repository would let the buffer grow faster than it drains, which surfaces as
  dropped frames and therefore as *false gaps in the gate metric itself*. The batch is a correctness
  requirement, not an optimisation.
- `cli/collect-depth-frames.ts` — the daemon, plus both `package.json` proxies (root included,
  remembering `139a1db`, where a missing root proxy made a scheduled job unrunnable for a full day).

**`gap_before` counts against the last *stored* frame, not the last *received* one.** If continuity
were tracked against everything received, the row after a frame we dropped ourselves would record
`gapBefore: 0` and the table would claim contiguity across a hole of our own making — and any book
reconstructed across it would be silently wrong. Tracking against what was persisted means
`gap_before` honestly reads "sequence numbers absent from this table before this row", whatever the
cause; `selfDropped` in the run report separates our losses from the vendor's.

**One bug this found in itself, live.** The first capture logged "Connected" twice. `connect()`
guarded on `socket` being null, but `getAccessToken()` suspends, so `subscribe()`'s implicit connect
and the caller's explicit `connect()` both passed the guard and built a socket — two sockets on one
token, both bound to the same emitter, which would have counted and persisted every frame twice. Now
guarded by a `connecting` flag set synchronously before the first await, and covered by a test that
races the two entry points.

*Gate — met in miniature, not yet at session scale.* Live capture 2026-08-21 on
`NSE:BANKNIFTY26AUGFUT` and `NSE:BANKNIFTY26AUG57700CE`:

| | result |
|---|---|
| frames written | 957 across two contracts |
| sequence continuity | **0 missed, 0 regressions**, 1 duplicate (a genuine feed replay, correctly flagged) |
| self-inflicted drops | 0 |
| flush failures | 0 |
| `levels_available` | 50 on every frame; stored 10 |
| verdict | `RECONSTRUCTIBLE` on the run that cleared the minimum-pairs bar |

Microprice computes from stored rows and moves correctly with size imbalance (bid 270 against ask 90
pulled it to 57755.75, above the mid) — the quantity that was uncomputable from anything this system
stored before Phase 1.

**The gate is not fully met and should not be reported as such.** These were 2-3 minute captures.
The pre-registered gate is *a full session*, and a three-minute window at midday says nothing about
the open, the close, or a high-volume expiry-day book — which is exactly when a feed sheds frames.
`INSUFFICIENT_SAMPLE` fired correctly on the first run (358 comparable pairs against a 500 minimum),
and that guard is the reason the miniature result cannot be mistaken for the real one. Phase 3 must
not begin until a full session has been captured and its rate published.

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

**Phase 3 — signal construction.** ⚠️ **COMPUTATION BUILT, NOT EVALUATED.** The distinction is the
point: writing the estimator is not the gated step, *drawing a conclusion from it* is.
`research/domain/order-flow-imbalance.ts` implements the canonical Cont-Kukanov-Stoikov OFI —
per-level signed queue change, extended across levels — plus `microprice` in `depth-frame.ts`.
21 tests, all on synthetic books with hand-checked expected values.

**It refuses to accumulate across a discontinuity, and this is where Phase 1 pays off.** OFI is a
cumulative sum, so it is only defined along an unbroken chain. Three things break it, and all three
are refusals rather than approximations: a **snapshot** (the feed restates the book, so differencing
across it invents an enormous imbalance from nothing), a **sequence gap** (real queue changes
happened unseen; differencing across the hole attributes all of them to one update and every later
value inherits the error), and a **duplicate** (a replayed frame contributes its flow twice, and is
not a valid baseline for the next frame either). `accumulateOrderFlowImbalance` therefore emits
**segments** with the breaks and their causes, never one continuous series that quietly spans holes.

Without `gap_before`, `is_snapshot` and `is_duplicate` on every stored row, none of those breaks
would be detectable after the fact, and an OFI series computed over the table would look perfectly
well-formed while being wrong wherever the feed hiccuped.

Verified against real captured rows: 1,193 frames → 1,187 observations across 5 segments, longest
371, breaking on 1 duplicate and 4 snapshots — the 4 being the opening snapshot of each separate
capture run, which is exactly right, since OFI must not accumulate across two different sessions.

*One bug its own tests caught:* the first version recorded the **opening** snapshot as a chain break,
which would have reported every clean capture as damaged and made zero breaks unreachable. A break is
now only recorded where a chain existed to lose.

**No IC, no evaluation, no verdict on whether OFI predicts anything.** That is Phase 4, and it stays
shut until Phase 1's full-session gate is met.

**Phase 4 — incremental value.** ⚠️ **RUNNER WIRED, GATE ENFORCED IN CODE, NO RESULT PRODUCED.**
`research:evaluate-ofi` reads stored frames, builds observations, and runs the IC ladder through the
R0 harness — and **refuses to compute an IC at all** unless the capture passes: sequence health
`RECONSTRUCTIBLE`, window at least `--min-session-minutes` (default 300), and zero foreign rows.

The gate is enforced here rather than only written down because *a gate that lives in a document gets
skipped by whoever is in a hurry* — most likely the author, on the day the first interesting number
appears. The most plausible way this programme produces a false positive is not a subtle statistical
error; it is looking at a three-minute midday capture, seeing an IC of 0.08, and deciding the gate
was pedantic. Now that is a refusal with an exit code rather than a judgement call.

`ofi-signal-observations.ts` owns the join where look-ahead bugs actually live, with two asymmetric
rules that are wrong if made symmetric:

- **The feature may not cross an OFI break.** It is a sum of deltas, so a trailing window that would
  reach back past a snapshot, gap or duplicate is truncated at the segment boundary. A short window
  is honest; a window spanning a hole is not.
- **The forward return may cross one.** A price is a price. Refusing returns across gaps would
  silently drop exactly the volatile moments the feed is likeliest to hiccup through — a selection
  bias on the *label*, which is worse than a shorter feature window.

Two further choices, both to avoid manufacturing an IC: the horizon is in **milliseconds, not
frames** (a frame-count horizon means different clock time depending on how busy the book was, which
correlates the label with activity, which correlates with the feature), and the forward endpoint must
be **strictly later** than the decision instant, never equal, because a same-millisecond frame could
have been processed either side of it.

*Verified refusing, on real data:* pointed at the 2026-08-21 captures it reported sequence health
`RECONSTRUCTIBLE` (1,915 comparable pairs, 0 missed), built **1,901 observations with 0 look-ahead
violations** across 6 segments — and refused, because the window spans 44.8 minutes against the
required 300. The plumbing is demonstrably sound and the number is still withheld.

*Gate:* significant IC surviving every placebo, at a horizon longer than our observed
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

---

## 7. First real Phase 4 results (2026-09-09), and a bug they exposed

The collector has been running continuously since 2026-08-21 (via `NSE:BANKNIFTY26SEPFUT`, rolling
from `NSE:BANKNIFTY26AUGFUT`). By 2026-09-09 several full sessions clear `RECONSTRUCTIBLE` at session
scale, so Phase 1's gate is finally met for real and Phase 4 was run for the first time.

**Coverage is narrower than the plan envisioned:** depth is captured on `NSE:BANKNIFTY26SEPFUT` only
(and its predecessor contract before the roll) — **no NIFTY50 depth exists at all**, and the one
option strike captured (2026-08-21) is a one-day smoke test. Every result below is BANKNIFTY futures
only. §5's "a result that holds on one index and not the other is drift" rule cannot even be checked
yet — there is no second index to check it against.

### A bug: every prior run was failing closed for the wrong reason

The first real run (2026-09-08 session, all four horizons 1s/5s/30s/60s) returned
`FAIL_NEGATIVE_LAG` on every horizon. `FalsificationObservation.labelEndAt` exists specifically so
`alignAtLag` can reject a lag probe whose "past" label had not actually resolved yet by the current
decision (documented in `falsification-harness.ts` as exactly this scenario) — but
`buildOfiObservations` never set it. At this feed's measured **~500ms median frame cadence**, a lag
of 10 observations covers only ~5000ms of real time — about one `ofiWindowMs` — so the probe was
comparing the feature against a label that had barely finished resolving, or hadn't, and reading the
resulting correlation as "predicts the past."

**Fixed** in `ofi-signal-observations.ts`: `labelEndAt` is now stamped from the forward frame's own
`receivedAt`, not a synthetic `at + horizonMs`. One new test (`ofi-signal-observations.test.ts`)
asserts it is populated and later than the decision instant. No change to `falsification-harness.ts`
itself — the guard already existed and was correctly designed; it just never received the field it
needed.

### Result after the fix: partial, not clean

Re-running the same session, and five more (2026-09-01 through 2026-09-07), at the two horizons long
enough relative to `ofiWindowMs` (5000ms) for the fix to fully apply:

| session | 30s horizon | 60s horizon |
|---|---|---|
| 2026-09-01 | NO_SIGNAL (IC -0.088) | NO_SIGNAL (IC -0.068) |
| 2026-09-02 | FAIL_NEGATIVE_LAG | NO_SIGNAL (IC -0.074) |
| 2026-09-03 | FAIL_NEGATIVE_LAG | FAIL_NEGATIVE_LAG |
| 2026-09-04 | NO_SIGNAL (IC -0.097) | NO_SIGNAL (IC -0.100) |
| 2026-09-07 | FAIL_NEGATIVE_LAG | NO_SIGNAL (IC -0.073) |
| 2026-09-08 | NO_SIGNAL (IC -0.113) | NO_SIGNAL (IC -0.116) |

Before the fix, every horizon on every session failed closed. After it, 4/6 sessions clear at 60s and
3/6 at 30s — a real improvement, but **not a clean pass rate**, and the residual failures are not
explained yet. Every session that DOES clear reports a small negative IC (-0.07 to -0.12), which is
suggestive but drawn from a diagnostic that is still failing on half the sessions tested — **not
strong enough to call NO_INFORMATION_FLOW_SIGNAL** (§5's kill condition) and certainly not strong
enough to move to Phase 5.

**The two shortest horizons (1s, 5s) remain unmeasurable, for a different and better-understood
reason.** With `ofiWindowMs=5000`, a horizon at or below that window means the feature and a
lag-shifted "past" return describe overlapping ticks by construction — no `labelEndAt` guard fixes
that, because the labels genuinely are resolved; the windows themselves overlap. Testing 1s/5s
horizons validly needs a smaller `ofiWindowMs`, decided before looking at any result from it, not
after.

**Open, and the reason no verdict is claimed yet:** why do 2 of 6 sessions still fail at 30s (1 of 6
at 60s) after a fix that clearly works elsewhere? Candidates, not yet distinguished: genuinely
borderline sessions where a self-calibrated placebo band happens to sit close to a real small
autocorrelation; a session-specific data quality issue the `RECONSTRUCTIBLE` gate doesn't catch;
or a second, smaller instance of the same class of bug the `labelEndAt` fix addressed. Whichever it
is, it should be diagnosed before any of this is read as a signal result — the pre-registered
programme is explicit that a placebo/integrity failure outranks any IC claim.

**Diagnosed, 2026-09-09.** In every one of the 3 residual failures, the failing lag was `-30` and
nothing else, and its surviving sample was 0.4-1.2% of the full session (120-487 observations out of
10,600-42,300) -- a tiny, non-random sliver left over after the overlap filters, producing a noisy
rank-IC that occasionally cleared the harness's fixed `minimumSample=100` floor by chance. `-10`, by
contrast, sat at 60-100% of the full session in every one of the 6 sessions and never failed after
the `labelEndAt` fix. A fixed sample count cannot distinguish "a handful of edge-case pairs" (what
100 was built for) from "a small but real fraction of a much larger session" -- exactly the gap
between what the floor was designed to catch and what it was actually being asked to judge here.

**Pre-registered 2026-09-09** (recorded in code at
`NEGATIVE_LAG_MINIMUM_SAMPLE_FRACTION` in `evaluate-ofi-signal.ts`, not only here): a negative-lag
probe must now clear both the harness's absolute floor of 100 **and** 5% of the full observation
count. 5% sits with a wide margin above every failing sample seen so far (max 1.2%) and a wide margin
below every passing one (60-100%) -- chosen for that margin, not fitted to land precisely between the
two closest observed values. No change to `falsification-harness.ts`; `minimumSample` was already a
caller-supplied option, so this is a call-site change only.

**Disclosed rather than hidden: this fraction was chosen after inspecting the six sessions it now
has to work on.** That is a real deviation from "never re-derive a threshold from the data being
tested," and papering over it would be worse than naming it. The 2026-09-01 through 09-08 sessions
already used to diagnose this are **not** to be re-evaluated under the new floor and reported as a
confirming result -- that would just be re-fitting with extra steps. The next genuine read is
whichever session is captured after 2026-09-09, on data no one had seen when 5% was chosen. Until
that lands, this section's status is unchanged: no Phase 4/5 conclusion, diagnostic only.

## 8. First clean pass (2026-09-15): the 2026-09-11 NO_SIGNAL verdict was a broken placebo, not a real one

The genuinely blind 2026-09-11 read (above) reported `NO_SIGNAL` at 30s/60s, but with a flagged
caveat: the real IC exactly equalled the `wrong-day-matched-time` placebo IC at both horizons,
because that evaluation queried a single calendar day and the placebo is a documented no-op with
nothing to swap with. Since it happened to be the largest placebo at both horizons, a no-op placebo
was setting the pass/fail threshold.

**Fix: no code change, only how the existing tool was invoked.** The capture session covering
2026-09-11 (`5d2abf31-f85e-4b78-968d-10572840a676`) actually spans two full trading days —
2026-09-10 (44,561 frames) and 2026-09-11 (45,523 frames) — because the collector's socket stayed
open overnight. Both days are post-2026-09-09 and neither has been reported as a standalone result
before, so evaluating the whole session (rather than isolating 2026-09-11 alone) is not re-deriving
anything from inspected data — it is fixing a real methodological gap (one day is not enough for a
day-swap placebo) using data that was already blind.

```
research:evaluate-ofi --symbol=NSE:BANKNIFTY26SEPFUT \
  --session=5d2abf31-f85e-4b78-968d-10572840a676 --horizons=30000,60000
```

Sequence health: `RECONSTRUCTIBLE`, 90,084 frames, 0 missed sequences, 1 duplicate (flagged
correctly), span 1,813.5 minutes.

| horizon | verdict | IC | 95% CI | placebo band | negative-lag |
|---|---|---|---|---|---|
| 30s | **PASS** | −0.0807 | [−0.0894, −0.0722] | 0.0044 (wrong-day-matched-time, now real) | clears |
| 60s | **PASS** | −0.0783 | [−0.0880, −0.0687] | 0.0140 (block-permutation) | clears |

Both placebo bands are now genuine (four distinct, non-degenerate placebo ICs each, none dominated by
a no-op), both confidence intervals exclude zero, and both negative-lag probes clear their
(correctly floored) sample thresholds with zero `failures`. This is the programme's first clean
Phase 4 `PASS` — not a diagnostic, not a placebo-compromised NO_SIGNAL.

**What this is not, yet:**

- **Not replicated across instruments.** BANKNIFTY futures only — no NIFTY50 depth exists (§0's
  cross-instrument drift check, applied to every other signal in this codebase, cannot even be
  attempted here).
- **Not replicated across independent windows.** This is one 2-day joint evaluation. The direction
  and rough magnitude (−0.07 to −0.12) match the earlier 6-session diagnostic, which is reassuring,
  but that diagnostic ran under the broken-`labelEndAt` and pre-floor-fix code and is not a clean
  confirmation either. A second, independent multi-day blind window (accumulating forward from here)
  is the next honest check before treating the sign as established.
- **futures, not options.** The system trades index options; this signal has not been translated
  into an options-premium or execution-cost frame at all. Phase 5 (cost-aware gate) has not started,
  and per §5's pre-registered kill conditions, a negative net expectancy on either index there is
  still the single most probable terminal outcome for any microstructure signal in this codebase.
- **1s/5s remain unmeasured.** Structurally invalid at `ofiWindowMs=5000` regardless of day count —
  a separate, understood limitation (needs a smaller window, decided before looking at any result).

**Sign note, tentative:** a negative IC means higher net order-flow imbalance predicts a *lower*
price move over the next 30-60s at this feed's cadence — the opposite of naive flow-following
intuition. Plausible readings (not yet distinguished): retail/algo flow chasing that liquidity
providers absorb and fade, or an artifact of futures-specific microstructure at this contract's
current liquidity. Not investigated further here — first priority is replication, not explanation.

## 9. Second forward-blind window (2026-09-18): DOES NOT REPLICATE

The second independent window §8 called for is now available: 2026-09-17 (38,583 frames) and
2026-09-18 (39,602 frames), both genuinely clean under the Long-unwrap decode fix
([[depth-collector-long-unwrap-bug]]) — confirmed via `count(distinct sequence_no)` ≈ frame count on
both days, not just a frame-count floor (the 2026-09-15/09-16 gap in between was corrupted by that
same bug and correctly excluded, never evaluated as if it were clean).

```
npx tsx src/interfaces/cli/evaluate-ofi-signal.ts --symbol=NSE:BANKNIFTY26SEPFUT \
  --from=2026-09-17T03:38:11.848Z --to=2026-09-18T11:50:17.558Z --horizons=30000,60000 --seed=1
```

Sequence health: `RECONSTRUCTIBLE`, 78,185 frames, 0 duplicates, 0 missed sequences, span 1,932
minutes (real trading ends at market close 10:00 UTC on 09-18; a single post-close straggler frame
at 11:50 UTC does not affect the read).

| horizon | verdict | IC | 95% CI | placebo band |
|---|---|---|---|---|
| 30s | PASS (on its own terms) | **+0.0764** | [0.0669, 0.0844] | 0.0242 (wrong-day-matched-time) |
| 60s | PASS (on its own terms) | **+0.0724** | [0.0635, 0.0835] | 0.0271 (wrong-day-matched-time) |

Compare to §8's first window: 30s −0.0807 [−0.0894, −0.0722], 60s −0.0783 [−0.0880, −0.0687].

**Same rough magnitude (0.07-0.08 at both horizons), opposite sign, both individually statistically
clean.** Per §5's own pre-registered kill condition and the explicit instruction that governed this
check ("either horizon flips to NO_SIGNAL, FAIL_NEGATIVE_LAG, or reverses sign → the first window
does NOT replicate. Say that plainly too — do not soften this or explain it away"): **this is a sign
reversal on both horizons. Verdict: DOES NOT REPLICATE.**

Each window individually clears its own internal placebo band, so within a single 2-day window this
signal is not noise -- but *which* direction it points in is not stable across windows, which is a
stronger disqualifier than a clean null would have been. A signal whose sign flips between two
otherwise-clean measurements is not measuring a persistent property of this market; at best it is
measuring something conditional on a variable this programme has not identified (a regime, a specific
liquidity state, a rollover effect) and has not controlled for. Promoting the §8 result to
"established" on the strength of one window, before this check ran, would have been exactly the
mistake the programme's own kill-condition discipline exists to prevent.

**Status: closed, not advanced.** Order-flow imbalance on `NSE:BANKNIFTY26SEPFUT` depth, at this
harness's current 5s window and 1-level touch-only construction, is not an established signal.
Re-opening this would need a *new* hypothesis about what the sign depends on (time of day, days to
expiry, absolute volatility, direction of the underlying move) — pre-registered before looking at any
further data — not a third window run the same way as the first two, which would just be sampling
the same unresolved coin-flip a third time.

**Checked, not assumed: the sign flip is not a pooling artifact.** The combined window contains
several tiny broken capture fragments (`ad6ded29...`: 2 frames over 46 minutes, `e0604e6a...`: 1
frame, `20d62a8b...`: 19 frames before the real 09-18 session took over) mixed in with the two
dominant sessions -- these were checked directly against `depth_frames.capture_session_id`, not
assumed absent from the earlier day-level `distinct_seq` ratio, which was too coarse to surface them
(3+19 stray frames out of 78,185 don't move a day-level ratio). Each starts its own tiny OFI segment
and contributes negligible observations regardless. More importantly, **09-17 and 09-18 were each
re-evaluated standalone** (single-day, so the placebo band is degenerate there and the verdict is not
trusted -- only the *real* IC's sign and magnitude are, which the degenerate placebo does not affect):
09-17 alone gives +0.0850 (30s) / +0.0648 (60s); 09-18 alone gives +0.0653 (30s) / +0.0828 (60s). All
four numbers agree in sign and sit in the same 0.065-0.085 range -- the positive window-2 result is
not one unusual day dominating a pooled average, it is the same effect present on both days
independently. That rules out the stray fragments and day-pooling as the explanation for the flip.
