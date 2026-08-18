# Strategist Decision Plan (confluence term removed)

Supersedes the frozen "Hierarchical Confluence" plan. The confluence term is removed on measured
evidence. What remains is two smaller, independent changes that the measurement never touched
because neither affects which signals fire.

## Why the confluence term is gone

It was the plan's only tradable term: a signed adjustment to the executor's score for
higher-timeframe alignment, `requiredScoreAdjustment = +2` for counter-trend setups. It was
measurable without any of the surrounding machinery, because `momentum-scalp-pattern` already calls
`calculateHtfTrendAlignment` and `calculateHtfSrConfluence` into its 0-9 score — the term was
written and inert only because nothing populated `context.higherTimeframes`.

Measured 2026-08-17 (`higher-timeframe-resolver.ts`, `backtest:run --higher-timeframes`,
`--strategy-config`), frictionless:

**Two index ETFs, 5m, 2019-01-01 → 2026-08-14.** Every arm improved monotonically over the base —
`base < signed < penalty < veto` with the ordering identical on both instruments:

| instrument | arm | trades | PF | mean P&L |
|---|---|---|---|---|
| NIFTYBEES | base | 13,790 | 1.0046 | +0.001139 |
| NIFTYBEES | veto | 11,200 | 1.0813 | +0.019074 |
| BANKBEES | base | 18,578 | 0.9376 | −0.027280 |
| BANKBEES | penalty 2 | 15,054 | 0.9701 | −0.012951 |

Then the dispersion: per-trade SD ≈ 1.37 against effects of 0.004–0.019, so the best contrast is
**t = 1.027**. Every arm sits under the 2×SE floor.

**Twenty equities, 30m, 2022-01-03 → 2026-08-06.** The direction reverses:

| statistic | value |
|---|---|
| instruments improved | **6 / 20** |
| sign test (exact, two-sided) | p = 0.115 (normal approx z = −1.79) |
| paired across instruments | **−0.0031 %/trade**, t = **−1.077** |

The veto flipped four instruments from positive expectancy to negative and cut trades 19%.

This is a failed generalisation rather than proof the ETF numbers were noise — three things changed
at once because no equity has any 5m or 1m bars: timeframe (off-design for a strategy registered
1m/3m/5m), instrument class, and bucket ratios. But the term has now been read three ways in one
day — bonus-driven, penalty-driven, then negative — and that instability *is* the finding. An effect
inside the noise reorders itself on every new slice. **There is no evidence for the term, so it is
not worth the machinery it required.**

Do not re-add it without a panel that clears a sign test, on-design timeframes, and a
cost-aware pass. At SD 1.37 the noise floor on expectancy is ±0.024, which is wider than any effect
observed.

## What this removes

- The entire Confluence Policy Engine: `StrategistAdjustment`, `ALIGNED` / `COUNTER_TREND` /
  `NEUTRAL`, `requiredScoreAdjustment`, `alignmentMultiplier`.
- `reasons.higherTimeframeTrend`.
- The executors' read path. They no longer consult a decision to gate or scale a setup, so
  `momentum-scalp-index` having no integer score to adjust is moot.
- Verification tests 2, 3, 4, 5, 7 and the alignment halves of 11 and 12.

## What survives, and it is two separate changes

### A. Daily trade cap, keyed on account and trading day

**Decided: capacity is keyed on `(account_id, trading day)`, not on a strategist decision.** A
decision-scoped window made TTL the de facto rate limiter, because every refresh silently restored
capacity. A calendar day cannot expire mid-session.

This settles what the control *is*. Counting trades ever opened in the day makes it a **throughput
cap**, and that is now unambiguous rather than conflated, because concurrent exposure is already
capped elsewhere: `defaultRiskPolicy.maxConcurrentPositions = 3`, applied by `evaluateRisk`, which
the bots already call. The two controls live in different layers and neither duplicates the other.
Nothing about exposure needs to be built here.

**Consequence worth stating: this is a per-account cap, not a shared one.** Classic and Sniper are
separate accounts with separate balances, so each gets its own capacity — and that is correct. A cap
shared across both arms would have let whichever bot fired first starve the other, making the
pattern comparison a race rather than an experiment. The frozen plan's "maximum new portfolio trades
across all executors" would have confounded the A/B it was meant to protect. The gate's remaining
job is serialising concurrent writes *within* one account: overlapping timeframe scans in a cycle,
or a bot cycle racing the exit sweep.

`maxTrades` therefore leaves `StrategistDecision` entirely and becomes account policy. And
`strategist_decision_id` on `paper_trades` is now audit-only — the review asked for it to be indexed
because the gate would count by it, and that rationale is void. Index it only if an audit query
needs it.

Enforce in `PostgresPaperTradeRepository.openFromTradeIdeaWithinTransaction`. That is the real
chokepoint — one file writes `INSERT INTO paper_trades`, and its three public entry points
(`openFromTradeIdea`, `openPairFromTradeIdeas`, `openManualOption`) all funnel through that private
method, which is already the transaction boundary. An application-layer gate would have left the
straddle's atomic two-leg path and manual option entries outside the cap.

**Mechanics:**

- **Trading day is the IST session date**, matching the scheduler's `Asia/Kolkata` timezone. An NSE
  session (09:15–15:30 IST) never crosses midnight IST, so the date is unambiguous.
- **Filter on a half-open `opened_at` range** computed from that date, not on
  `(opened_at AT TIME ZONE 'Asia/Kolkata')::date`. An expression on the column cannot use a plain
  btree index; a range can.
- **A new index is required.** Neither existing index serves this count:
  `paper_trades_open_idx` is `(account_id, opened_at DESC) WHERE status = 'OPEN'`, and a daily cap
  counts closed trades too; `paper_trades_history_idx` is on `closed_at`. Add
  `(account_id, opened_at)` with no partial predicate.
- **Serialisation needed nothing new.** This called for `pg_advisory_xact_lock`; the implementation
  uses neither that nor a capacity table, because `openFromTradeIdeaWithinTransaction` already takes
  the account row `FOR UPDATE`. That holds the account for the rest of the transaction, so two
  concurrent bot cycles cannot both read the same count and both insert — the lock that makes this
  safe was already in the right place. It releases on commit *or* rollback, so a failed insert
  leaves capacity available without anything being arranged. The count stays derived from
  `paper_trades` rather than a capacity row that could drift from the trades it describes.

**The cap's value is not yet measurable.** Live history is a single session — Classic 21 trades,
Sniper 2, Alpha Simulation Fund 1 — and the Sniper's 2 predates pattern detection existing on
1m/5m/15m, so it reflects an empty `pattern_detections` table rather than the strategy. Backtests
put the scalp strategies at 7–10 trades per session per instrument. Set the cap as a runaway guard
placed above observed behaviour, not as a throttle shaping it, and revisit once ~20 sessions of
post-fix history exist. A cap tight enough to bind is a strategy change wearing a safety label.

### B. Append-only regime record

Keep `StrategistDecision` as a point-in-time observation with **no read path into execution**. Its
value is research: it lets a later question — did trades opened in BEARISH regimes fare worse? — be
answered without re-deriving regime, which is the kind of re-derivation that produces a different
answer each time.

Keep exactly as specified, because this part was right:

- `evaluationAsOf` as the time source rather than wall-clock, so backtest, replay, and live agree.
- The boundary rule: at `evaluationAsOf === validUntil` the decision is already expired.
- A future decision (`createdAt` or `asOf` after `evaluationAsOf`) is **absent**, not expired.
- Scope precedence instrument+timeframe → instrument → market.

One fix to the repository: `findLatestActive` needs a total order. Append-only means several rows
can be active at one precedence level, and the codebase convention is a full tiebreak chain
(`ORDER BY … DESC, created_at DESC, id DESC`). Without the `id` tiebreak two decisions sharing an
`as_of` resolve arbitrarily — the scope-precedence test passes while live behaviour flaps.

Executors stamp `strategist_decision_id` on the trade for (A)'s counting and (B)'s audit trail;
that is their entire involvement. The column is nullable UUID, indexed, added in a numbered
TypeScript migration under `apps/api/src/infrastructure/database/migrations/` (next is `066-`) and
registered in that directory's `index.ts` — not a SQL file under `apps/api/migrations/`, which does
not exist.

## What is dropped unless a sizing path is built first

`riskMultiplier`. With alignment gone the policy collapses to "if active, multiplier =
riskMultiplier, else 1.0" — a field read, not an engine. And nothing consumes a multiplier: there
are zero occurrences of `positionSizeMultiplier` in the api workspace, and `evaluateRisk(proposal,
state, policy)` derives `approvedQuantity` with no multiplier input.

So `riskMultiplier` is either dropped, or the plan must include the `evaluateRisk` change as a
first-class item with **one test asserting a differing `approvedQuantity`** — not a differing
multiplier. A multiplier threaded into evidence and read by nothing is the failure mode this
codebase has now hit three times: `higherTimeframes` declared and never populated, the Sniper
reporting `RULES_NOT_MET` against an empty `pattern_detections` table, and equity 30m scoring
against 0% indicator coverage. Each looked like a working feature returning a neutral answer.

## Status, 2026-08-18

**Section A is built and deployed.** `d1868f6` domain, `06f368a` migration sequence closed and 066
registered, `95becf9` enforcement, `8144d30` the two guard tests. Applied to the live database and
verified in the running scheduler. It is **inert**: every account's `daily_trade_cap` is null, so
enabling it is a per-account `UPDATE` — and the calibration caveat below still holds, since two
sessions is not a distribution.

Session counts so far: Classic 21 then 12, Sniper 2 then 11. The Sniper's jump is the
`pattern_detections` fix landing, not a strategy change — yesterday's 2 measured an empty table.

**Section B has not been started.** No `StrategistDecision` artefact exists in the codebase, and it
changes no trading behaviour by design, so it stays optional. After the confluence result, it is
worth building only when there is a question you actually want it to answer.

Verification: items 6, 8, 10, 11 done; 1-5 belong to Section B; **7 and 9 remain open and cannot be
closed with the current harness** — a real race and a mid-transaction insert failure both need two
live connections rather than a fake client. Do not mark them done on the strength of the ordering
assertion that stands in for 7; it proves the count follows the lock, not that a race resolves to
one winner.

## Verification plan

Surviving tests, renumbered:

1. Hard halts remain owned by the Global Risk Governor, evaluated independently.
2. A decision generated at T+5 cannot be consumed by an `asOf` T request.
3. Future-information decision: `createdAt` 10:05, `asOf` 10:15, executor `asOf` 10:10 → unavailable,
   reason `NO_DECISION`, not `EXPIRED`.
4. Expiry boundary: `evaluationAsOf === validUntil` is expired.
5. Scope precedence: instrument+timeframe beats instrument beats market, with a deterministic
   tiebreak when two rows tie on `as_of`.
6. Capacity exhausted for an account on a day: enforced at the write boundary, the next open rejected.
7. Two concurrent opens on one account at its final slot: exactly one succeeds.
8. **Accounts are independent**: Classic exhausting its cap leaves Sniper's untouched. This replaces
   the frozen plan's "Sniper cannot exceed the shared limit after Classic consumes slots", which
   would now be asserting a bug.
9. Rollback on insert failure leaves capacity available (the account row lock releases either way).
10. Closed trades consume capacity: a scalp opened and closed in two minutes still counts.
11. Day boundary: a trade opened at 15:29 IST and one at 09:16 IST the next morning fall in
    different windows, and a trade near midnight UTC is attributed to its IST session date.

Dropped along with the confluence term: every alignment-behaviour test, and the
`positionSizeMultiplier` assertions unless a sizing path is built.
