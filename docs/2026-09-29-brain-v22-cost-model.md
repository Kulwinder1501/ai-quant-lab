# Brain V2.2 cost model — 2026-09-29

## What was asked

Brain V2.2's native decision pipeline (`autonomous-v2/domain/`, P5-P10, shadow-only) carries a
hardcoded `placeholderCostBps = 2` in `decision-pipeline-input.ts`, explicitly labelled as a
placeholder borrowed from `canonical-friction.ts`'s underlying-notional research ladder, not a real
options cost model. `brain_v22_approval_grading.py` was re-run today against 110 accumulated
approved decisions (118 side-approvals) and found -2.57 points/approval, 37.5% target-hit rate — in
raw underlying index/futures points, with no cost model applied anywhere. The ask: understand
exactly where cost enters this picture, build a real cost model reusing V1's established options
fee/fill logic, re-grade the 110 decisions with it, and — if defensible — replace the placeholder
with a real derived number.

**No live/paper-trading authority changed.** This is measurement infrastructure only; Brain V2.2
stays shadow-only.

## Step 1: is -2.57 really cost-free, and where would cost enter?

Read end to end rather than assumed:

- `brain_v22_approval_grading.py` parses `differential_observations.v2_outcome` strings
  (`APPROVED LONG entry=... stop=... target=...`), walks real 5m candles forward same-day, and
  resolves STOP/TARGET/TIMEOUT (stop-first on an ambiguous bar). **It touches nothing about cost or
  premium** — confirmed by reading the query and the grading function directly, not inferred from
  its docstring. The -2.57 figure is exactly what it looks like: raw underlying index/futures points.
- `costBps` is threaded into `DecisionPipelineInput` (`decision-pipeline-input.ts`) and consumed in
  exactly one place: `decision-pipeline.ts`'s P7 call, `assessEdge({ thesis, context, costBps })`
  (`edge-assessor.ts`). It is **not** passed to P8 (`approveRisk` in `risk-approver.ts` takes
  `edge, thesis, context, accountSnapshot, lotSize` — no `costBps`), correcting the old comment on
  `placeholderCostBps` which claimed it fed "P7/P8".
- P7 computes `costAdjustedBreakEvenHitRate = (1 + roundTripCostR) / (1 + rewardRiskMultiple)` and
  stores it on every side's `BaselineEdge`. P7 is **uninhabited-refusal by design (I5)** — the
  Edge Engine measures, it never gates. Grepped the whole domain: nothing anywhere reads
  `costAdjustedBreakEvenHitRate` or `baselineEdge` outside test fixtures. **No gate exists yet.**

So: the -2.57 is genuinely zero-cost, and today, `costBps`'s value has **zero effect on any
approval/rejection** — changing it changes a stored, unconsumed number. That matters for how to
read the rest of this document: this is a measurement contribution, not a behavior change.

## Step 2: the real cost model

Reused rather than reinvented, matching what V1's live paper-trading system actually trusts for
options (also reused earlier the same day for the ATM-vs-ITM backtest):

- **Contract selection**: `nearestStrike(entry, strikeStep)` for ATM, CE for a LONG idea / PE for a
  SHORT idea — `option-buyer-fill.ts`'s own convention.
- **Fill + premium-space repricing**: `mapIdeaToOptionBuyerFill` — the same function
  `prepare-option-entry.ts` and `run-atm-vs-itm-strike-backtest.ts` use. Solves IV from the real
  observed mid, reprices stop/target into premium space, and enforces the risk-reward-distortion
  guard.
- **Real fees**: `calculateEntryFees` / `calculateExitFees` (`brokerage-calculator.ts`) — the actual
  Zerodha/NSE brokerage, STT, exchange, GST, SEBI, stamp-duty schedule.
- **Real fills**: `option_premium_ticks` (15-30s dense ATM polling) — entry at the observed ask,
  exit at the observed bid, same convention V1 uses live.
- **Barrier resolution**: `decideOptionBuyerObservedExit` — the oldest-first observed-tick scan
  that is also what `evaluate-open-paper-trades.ts` uses live. Same-day only, matching the raw
  grading's own horizon; unresolved by end of day exits at the last observed bid (TIMEOUT), the
  same convention `brain_v22_approval_grading.py` uses for the underlying case.

New script: `apps/api/src/interfaces/cli/run-brain-v22-cost-adjusted-grading.ts`.

### Why this is a second, independent barrier scan, not a reuse of the raw grading's resolution time

The raw grading resolves the bracket against the *underlying's* candles. Converting that resolution
instant into a premium P&L would silently assume the option moved in lockstep with the underlying —
exactly the assumption P10's own docstring says does not hold ("no premium-space repricing...
deferred"), and which this project's memory (`premium-target-unreachable-at-index-target`) already
found false at the ATM strike specifically. So stop/target are independently repriced into premium
space and the real ticks are walked against *those* barriers. The two resolutions can and do differ
— e.g. NIFTY50 2026-09-21 05:45Z SHORT: raw grading says the underlying hit TARGET, but the premium
walk hit the repriced STOP_LOSS first. That divergence is the whole point of doing this exercise
rather than skipping it.

### A real bug found and fixed along the way: expiry selection

First pass used `prepare-option-entry.ts`'s real live floor (`MINIMUM_DAYS_TO_EXPIRY = 2`, the
"tradable" expiry) and got **0 of 118 fillable** — not a data gap, a wrong assumption. Read
`collect-option-premium-ticks.ts` and `atm-premium-contracts.ts`: the dense ATM poller
(`selectAtmPremiumContracts`) only ever asks the chain snapshot for its **first listed (front)
expiry**; the "tradable" (≥2-day) expiry is only additionally collected when a real V1 paper trade
already has one open — which V2.2's shadow decisions never do. Switched to the **front** expiry
(`atm-premium-contracts.ts`'s own `premiumCoverageExpiries`, first entry) and coverage went to
100%. This means some approvals are repriced against a same-day or next-day-expiring (0-1 DTE)
contract — nearly all gamma/theta — because that is genuinely what was collected. Reported as a
real weakness of using real data, not smoothed over (see the NIFTY50 2026-09-21 09:00-09:30Z rows
below, where the ATM 23450 strike swings ~120% intraday on both CE and PE sides — a 0-1 DTE
gamma effect, not a data error).

A second bug, also real: node-postgres's default type parser converts a Postgres `DATE` column into
a JS `Date` at **local midnight**, not UTC midnight. On this machine (`Asia/Calcutta`, UTC+5:30),
that shifted every expiry date back by one calendar day before it reached the SQL parameter,
producing the same 0/118 symptom independently of the expiry-selection bug above. Fixed by running
the script with `TZ=UTC` (matches how the real Docker containers already run, which default to UTC)
rather than by adding a type-parser workaround to application code.

## Step 3: real coverage

**118 of 118 side-approvals (100%) were genuinely repriced with real premium ticks and real fees —
none were fudged with a modelled fallback.** `option_premium_ticks` has dense same-day coverage for
both instruments across all 5 trading days in the approval window (2026-09-15 through 2026-09-21;
28k-69k ticks per instrument per day).

## Step 4: cost-adjusted results

| | raw index points (sanity check, matches `brain_v22_approval_grading.py`) | real premium P&L (Rs, one lot, real fees) |
|---|---:|---:|
| **All (n=118)** | mean **-2.57** | mean **-129.63**, sum -15,296.04 |
| BANKNIFTY (n=56) | mean -7.22, sum -404.30 | mean **-281.03**, sum -15,737.75 |
| NIFTY50 (n=62) | mean +1.62, sum +100.65 | mean **+7.12**, sum +441.71 |

**This is not a "cost fixed it" or "cost made it worse" story that spins cleanly either way — report
it exactly as it comes out:**

- BANKNIFTY was already the worse instrument in raw points (-7.22) and gets **dramatically worse**
  once repriced into real premium terms (-281.03/approval) — the option-space repricing amplifies
  the underlying loss rather than merely adding a cost drag on top of it, because BANKNIFTY's option
  geometry (a nonlinear function of a 100-point strike step, lower delta, wider observed spreads)
  distorts the raw index-point outcome, not just its size.
- NIFTY50 was marginally *positive* in raw points (+1.62) and **stays marginally positive** in real
  premium terms (+7.12/approval) — costs did not flip its sign, but +7.12 Rs on a one-lot ATM option
  position (turnover in the hundreds of rupees) is not a result to build confidence on; it is
  indistinguishable from noise at this sample size (n=62).
- **Combined, the real, cost-adjusted result is decisively negative** (-129.63/approval,
  -15,296.04 total across 118 one-lot positions) — worse than the already-negative raw figure, driven
  entirely by BANKNIFTY.

One-way cost breakdown (fees + real bid/ask spread, averaged over the 118 FILLED rows):

| basis | mean one-way cost | what it excludes |
|---|---:|---|
| bps of **premium** turnover (fees only) | 29.99 bps | the bid/ask spread |
| bps of **underlying** notional (fees only) | 0.2061 bps | the bid/ask spread |
| bps of **underlying** notional (fees + spread) | **0.3187 bps** | nothing measured here |

## Step 5: `placeholderCostBps` replacement

`decision-pipeline-input.ts`'s `placeholderCostBps` is now `0.32` (was `2`), with an extensive
code comment carrying this derivation. Two things worth stating plainly, because the number invites
a wrong reading:

**This does not mean options got cheaper.** The same repricing found real cost is ~30 bps of
*premium* turnover in fees alone (spread adds more) — a meaningful drag. But `costBps` is consumed
by `edge-assessor.ts`'s `roundTripCostR`, which charges it against **`geometry.entryReference`, the
underlying price** — the same basis `canonical-friction.ts`'s Track A ladder (1/2/5 bps) uses for an
equity/index-proxy *underlying* bracket, where cost naturally scales with the underlying's own
notional. An option's premium is a small, convex fraction of that notional (leverage), so any real
options cost, forced into this unit, reads as a tiny number by construction — 0.32 looks like "cheap"
only because the unit is wrong for what it's being asked to represent, not because the trade is
cheap. **A future cost-aware gate for options needs to be built in premium space (Track B,
`d2-premium-cost-gate`'s territory), not by trusting this slot.** This is stated directly in the code
comment so a future implementer does not read `0.32` as "options got safer."

**Whether this changes any pass/fail behavior on the 110 decisions: no.** Confirmed by reading the
whole consumption path (Step 1): P7 never refuses, and nothing downstream reads
`costAdjustedBreakEvenHitRate`. The replacement changes a recorded-but-unconsumed number, nothing
else, on the current 110/118.

## Files touched

- `apps/api/src/interfaces/cli/run-brain-v22-cost-adjusted-grading.ts` (new) — the cost-adjusted
  re-grading script.
- `apps/api/src/modules/autonomous-v2/application/decision-pipeline-input.ts` — `placeholderCostBps`
  replaced with the derived `0.32`, comment rewritten with the full derivation and caveats.
- This document.

## What this does not do

Does not wire anything into the live/paper-trading path. Does not add a cost gate to P7/P8 — that
remains a decision for whoever eventually builds one, and per the caveat above, it should not be
built by trusting `costBps` alone. Does not widen `option_premium_ticks` collection or backfill
history beyond the 2026-09-15 to 2026-09-21 approval window that already existed.
