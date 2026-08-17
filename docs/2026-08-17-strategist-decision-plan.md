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

### A. Shared portfolio trade limit

The only remaining control with a direct safety argument: one cap across both executors, enforced
transactionally so Classic and Sniper cannot each spend the last slot.

Enforce it in `PostgresPaperTradeRepository.openFromTradeIdeaWithinTransaction`. That is the real
chokepoint — one file writes `INSERT INTO paper_trades`, and its three public entry points
(`openFromTradeIdea`, `openPairFromTradeIdeas`, `openManualOption`) all funnel through that private
method, which is already the transaction boundary. The frozen plan put the gate in an application
service "or equivalent", which would have left the straddle's atomic two-leg path and manual option
entries outside the limit.

**Unresolved, and it should be resolved before implementation:** counting trades *ever opened* under
a capacity key makes this a throughput cap, not an exposure cap. Those are different controls.
Portfolio risk is about concurrent exposure; churn is about rate. Both are legitimate, neither is
the other, and the frozen plan named one and described the other. This matters concretely here:
measured over 1,885 sessions the scalp strategies take 7–10 trades per session per instrument, so
whether a cap is generous or exhausted in ten minutes depends entirely on the window it is counted
over — and no default was given for the cap or the window.

Recommendation: key capacity on something that does not expire mid-session (account + trading day),
so a new decision cannot silently restore capacity and make TTL the de facto rate limiter.

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

## Verification plan

Surviving tests, renumbered:

1. Hard halts remain owned by the Global Risk Governor, evaluated independently.
2. A decision generated at T+5 cannot be consumed by an `asOf` T request.
3. Future-information decision: `createdAt` 10:05, `asOf` 10:15, executor `asOf` 10:10 → unavailable,
   reason `NO_DECISION`, not `EXPIRED`.
4. Expiry boundary: `evaluationAsOf === validUntil` is expired.
5. Scope precedence: instrument+timeframe beats instrument beats market, with a deterministic
   tiebreak when two rows tie on `as_of`.
6. Capacity exhausted: enforced at the write boundary; the second executor is rejected.
7. Concurrent executors at the final slot: exactly one succeeds.
8. Rollback on insert failure leaves capacity available.
9. Closed trades and the capacity window: whichever semantics section A settles on, asserted
   explicitly rather than left to the counting query.

Dropped along with the confluence term: every alignment-behaviour test, and the
`positionSizeMultiplier` assertions unless a sizing path is built.
