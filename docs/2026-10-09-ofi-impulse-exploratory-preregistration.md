# Pre-Registration: Order Flow Imbalance (OFI) Impulse Response (H_OFI_IMPULSE)

**Status:** PRE-REGISTERED — EXPLORATORY  
**Date**: 2026-10-09  
**Parent research program:** Phase 28 Microstructure Information Flow  
**Purpose:** Characterize the empirical high-frequency impulse-response function (IRF) of price following extreme OFI shocks, establishing whether the impact is persistent through 15 minutes, transitory, or indistinguishable from noise.

## 1. Frozen OFI Definition & Event Identification

- **Signal Construction**: Unchanged `OFI_BASELINE_V1` series.
- **Thresholds**: 
  Calculated separately per instrument using ONLY pre-OOS observations.
  - Positive impulse threshold: `Q99`
  - Negative impulse threshold: `Q01`
- **Impulse Definition**: Entry into the extreme tail.
  - Positive impulse: `previous_OFI <= Q99 AND current_OFI > Q99`
  - Negative impulse: `previous_OFI >= Q01 AND current_OFI < Q01`
- **Refractory Rule**: A strict 15-minute refractory period per instrument across BOTH impulse directions. After an impulse at $t_j$, any subsequent crossing of either threshold before $t_j + 15\text{m}$ is ignored.

## 2. Frozen Price and Timestamp Alignment

At impulse time $t_j$, the starting mid-price $M_{t_j}$ is defined as the latest valid, non-crossed bid/ask midpoint satisfying:
- `quote_event_time <= decisionAt`
- `quote_received_at <= decisionAt`

For each future horizon $h$, the outcome mid-price $M_{t_j+h}$ is the latest valid quote satisfying:
- `quote_event_time <= decisionAt + h`
- `quote_age_at_target <= 1 second` (no forward-filling beyond 1s)

Events and outcomes must remain within the same futures contract (no bridging across a roll).

## 3. Frozen Response Horizons & Estimand

Horizons evaluated concurrently from the same $t_j$:
- `1s`, `5s`, `10s`, `30s`, `60s`, `300s`, `900s`

Signed response (bps):
$$IRF_j(h) = s_j \times 10^4 \times \frac{M_{t_j+h} - M_{t_j}}{M_{t_j}}$$
where $s_j = +1$ for positive impulses and $-1$ for negative impulses.

## 4. Simultaneous Confidence Intervals & Inference

- **Procedure**: Session-aware block bootstrap (10,000 replicates, fixed seed). Resample entire sessions as blocks.
- **Method**: Construct simultaneous 95% confidence intervals across the 7 horizons using a maximum-statistic procedure to control Family-Wise Error Rate (FWER) across horizons.
- **Minimum Sample**: At least 50 independent events per instrument and direction. If fewer, mark that category `INCONCLUSIVE`.

## 5. Exhaustive Classification Rules

Categories evaluated per instrument (NIFTY/BANKNIFTY) and impulse direction (Positive/Negative):
- **Persistent through 15 minutes**: Simultaneous CI lower bound is above zero at 900s.
- **Transitory / decaying**: Positive significant response at an early horizon, while the 900s CI includes zero.
- **Reversal**: Positive significant early response, followed by a 900s CI entirely below zero.
- **Opposite-direction impact**: A significant negative response appears without an earlier significant positive response.
- **No reliable impact**: All simultaneous confidence intervals include zero.
- **Mixed / inconclusive**: Results do not meet another classification consistently.

## 6. Economic Interpretation & Caveats

- This study characterizes price dynamics, not trading profitability. Net trading execution friction is not applied.
- Based on 7 OOS sessions, bootstrap inference remains exploratory. Ten thousand resamples improve computational stability, but do not create additional independent market sessions.
- No trading-policy or live-API changes will be enacted from this result. It exclusively informs the sequence of future research (`CROSS_ASSET_OFI`).
