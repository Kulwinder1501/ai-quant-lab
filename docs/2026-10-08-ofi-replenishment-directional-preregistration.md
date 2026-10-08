# Pre-Registration: Order Flow Imbalance (OFI) Replenishment Directional (H_OFI_REPLENISHMENT_DIRECTIONAL)

**Status:** PRE-REGISTERED — CONFIRMATORY  
**Date**: 2026-10-08  
**Parent discovery study:** `H_OFI_REPLENISHMENT`  
**Discovery result:** Dynamic opposing-liquidity recovery state significantly stratified OFI returns in the prior OOS experiment.  
**Purpose:** Test, on a new independent OOS population, whether the pre-specified FAST-replenishment state improves the unchanged OFI policy.

## 1. Hypothesis

**H_OFI_REPLENISHMENT_DIRECTIONAL**

Within a new independent OOS population, the unchanged `OFI_BASELINE_V1` signal produces positive incremental net economic value when restricted to the pre-specified **FAST replenishment state (Q1 PIT_AUC)**, relative to the frozen unconditional OFI baseline.

The FAST state is defined before the new OOS window and cannot be changed based on new OOS results.

## 2. Discovery-to-Confirmation Separation

The preceding `H_OFI_REPLENISHMENT` experiment is treated as **discovery evidence**.

The observed Q1 result was used to select the directional hypothesis. Therefore:

- The 7-session discovery sample is **not** part of the confirmatory acceptance population.
- Q1 is frozen before the confirmatory OOS begins.
- Q2/Q3/Q4 cannot replace Q1 if Q1 fails.
- No new AUC quartile boundaries may be estimated from confirmatory OOS data.
- No new lookback, episode count, recovery horizon, or state definition may be tuned.

## 3. Frozen FAST-State Definition

The FAST state is:

`Q1 = lowest pre-OOS PIT_AUC`

For each instrument and opposing side:

- NIFTY buy-side AUC
- NIFTY sell-side AUC
- BANKNIFTY buy-side AUC
- BANKNIFTY sell-side AUC

the Q25 boundary is taken from the already frozen pre-OOS calibration distribution.

The confirmatory evaluator must not recompute these thresholds from the new OOS population.

### PIT state construction

At `decisionAt`:

`PIT_AUC(t) = median(AUC of the 5 most recent completed eligible shock episodes)`

with:
- maximum episode age = 30 minutes
- minimum completed episodes = 5

If the requirements are not met:
`state_status = STATE_UNAVAILABLE`

No imputation or carry-forward is permitted.

## 4. Executable Policies

### Baseline
`B_i = 1` iff `OFI_BASELINE_V1` signal is true

### FAST Conditional Policy
`C_i = 1` iff:
- `OFI_BASELINE_V1` signal is true
- AND `state_status == VALID`
- AND `PIT_AUC(t)` is in Q1 FAST state

Therefore: `C_i => B_i` must hold for every observation.

## 5. Canonical Paired Estimand

The same eligible decision opportunities are used for both policies.

For opportunity `i`:
- `G_i` = frozen gross forward return
- `BaselinePolicy_i` = `B_i × (G_i - 2.0)`
- `ConditionalPolicy_i` = `C_i × (G_i - 2.0)`
- `Δ_i` = `ConditionalPolicy_i - BaselinePolicy_i`

Primary estimand: `E[Δ_i] > 0`

The 2.0 bps value remains the frozen research friction assumption.
Incremental friction is derived naturally from the different policy trade decisions; it is never hard-coded as a second 2.0 bps deduction.

## 6. Independent OOS Population

The confirmatory evaluation begins **after the completion of the discovery experiment**.

Evaluation window:
**The next 30 completed NSE trading sessions after 2026-10-07.**

No discovery-session observations may enter the confirmatory acceptance statistics.
There are no interim looks.
The evaluator runs once on the completed confirmatory window.

## 7. Minimum Evidence Requirement

The confirmatory experiment must contain at least:
- 30 completed trading sessions
- AND 100 FAST-state baseline opportunities

If 30 sessions complete but fewer than 100 FAST opportunities exist:
`FINAL STATUS = INCONCLUSIVE / INSUFFICIENT_SAMPLE`

The hypothesis is not rescued by extending the window after seeing the result unless that extension was separately pre-registered.

## 8. Primary Statistical Gate

Primary test:
- H0: E[Δ_i] <= 0
- H1: E[Δ_i] > 0

The primary test uses an opportunity-level paired `Δ_i` series with dependence-robust inference appropriate for overlapping forward returns.

Required:
- HAC / Newey-West dependence-robust t-statistic;
- lag length determined mechanically from the frozen sampling cadence and 15-minute outcome horizon;
- session-boundary resets;
- no IID standard-error calculation used as the acceptance statistic.

**Statistical gate**: `HAC t-statistic > 3.0`
A session-aware block/bootstrap confidence interval is retained as supporting evidence.

## 9. Directional Sign Gate

The confirmatory result must be positive in **every frozen confirmatory evaluation window**.
No new windows may be created after examining the data.

For every window, persist:
- mean_incremental_net_bps
- n_fast_opportunities
- n_baseline_opportunities
- sign

All windows must have: `mean_incremental_net_bps > 0`

## 10. Economic Gate

The FAST conditional policy must achieve:
`conditional_mean_net_return_bps > 1.5`

under the frozen 2.0 bps research-friction assumption.
Report separately: gross_return_bps, friction_bps, net_return_bps.
The economic gate is independent of the statistical gate.

## 11. Supporting Diagnostics

The evaluator must report:
- FAST/Q1 mean net return
- baseline mean net return
- mean incremental net return per opportunity
- mean incremental net return per executed trade
- FAST coverage %
- n FAST trades
- n baseline trades
- avoided baseline trades

Instrument diagnostics: pooled, NIFTY-only, BANKNIFTY-only, 50/50 equal-instrument weighting.
State diagnostics: Q1, Q2, Q3, Q4 (Q2–Q4 are diagnostic only and cannot change the primary FAST rule).
Also report: AUC distribution, PIT state coverage, STATE_UNAVAILABLE count, state age, episode count used.

## 12. Falsification Rule

If the pre-specified FAST policy fails any primary acceptance gate:
`H_OFI_REPLENISHMENT_DIRECTIONAL = FALSIFIED`

No switching from Q1 to Q2/Q3/Q4 is permitted.
No AUC threshold change is permitted.
No new lookback or recovery definition is permitted.
A materially different rule requires a new hypothesis and new pre-registration.

## 13. No Multiple-Rule Search

The confirmatory experiment evaluates exactly one directional candidate:
`OFI_BASELINE_V1 + FAST/Q1 PIT_AUC state`

The experiment does not compare multiple candidate thresholds, multiple FAST definitions, multiple episode counts, or multiple recovery horizons.
Because the directional rule is selected before the independent confirmatory sample, no post-selection optimization is performed on that sample.

## 14. Promotion Boundary

Even a triple-pass does not authorize production trading.
A confirmatory PASS authorizes only: `INDEPENDENTLY_SUPPORTED_RESEARCH_RESULT`

The next stage requires:
1. Longer prospective replication.
2. Realistic Indian futures transaction-cost validation.
3. Paper-trading evaluation under the frozen policy.
4. Independent risk/execution authorization.

## 15. Required Artifact

`ofi_replenishment_directional_verdict.json` must contain at minimum:

```json
{
  "hypothesis": "H_OFI_REPLENISHMENT_DIRECTIONAL",
  "discovery_sample_end": "2026-10-07",
  "confirmatory_sessions": 30,
  "n_fast_opportunities": 0,
  "n_baseline_opportunities": 0,
  "fast_coverage_pct": 0,
  "baseline_mean_net_bps": 0,
  "fast_mean_net_bps": 0,
  "incremental_mean_net_bps_per_opportunity": 0,
  "incremental_mean_net_bps_per_trade": 0,
  "hac_t_stat": 0,
  "sign_gate": false,
  "economic_gate": false,
  "statistical_gate": false,
  "minimum_sample_satisfied": false,
  "final_verdict": "INCONCLUSIVE"
}
```

The artifact must also persist the exact Q1 calibration boundaries and the version identifiers of:
- OFI_BASELINE_V1
- H_RESILIENCY_MEASUREMENT_V1
- H_OFI_REPLENISHMENT
- PIT_AUC definition
- shock definition
- AUC calibration

## 16. Research Interpretation

A confirmatory PASS means:
> The pre-specified FAST replenishment state replicated its incremental relationship with the frozen OFI policy on an independent future sample.

It does not establish causality and does not establish production profitability under actual brokerage/tax/execution costs.
