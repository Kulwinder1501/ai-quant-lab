# ICT/SMC Semantic Contract & Operational Specification

**Version**: `1.0.1-frozen`  
**Status**: `FROZEN v1.0.1`  
**System Target**: `AI Quant Lab - Technical Analysis Domain Engine`

---

## 1. Purpose & Scope

This document serves as the single source of truth for all Inner Circle Trader (ICT) and Smart Money Concepts (SMC) technical primitives implemented within the `AI Quant Lab` codebase (`apps/api/src/modules/technical-analysis/domain/ict/`).

The primary mandate of this specification is to:
1. **Normalize Vocabulary, Preserve Evidence**: Ensure one detector per underlying market event while preserving raw primitive state vectors (`ob_present`, `sweep_distance_atr`, `mss_present`, `bpr_present`) for Machine Learning feature extraction.
2. **Distinguish ICT Semantics from Operationalization**: Separate *what* ICT defines conceptually (`CANONICAL`) from *how* AI Quant Lab quantifies it deterministically (`AIQL_OPERATIONAL`).
3. **Enforce Causal Zero-Lookahead**: Establish strict lifecycle timestamp tracking (`candidateAt?`, `formedAt?`, `confirmedAt`, `availableAt`, `testedAt?`, `mitigatedAt?`, `invalidatedAt?`) where `availableAt` is the **only** timestamp accessible to downstream strategy and feature pipelines.
4. **Formalize Replay Invariants**: Specify exact mathematical constraints for Prefix Invariance and Future Perturbation Invariance testing.
5. **Prevent Ambiguous Implementations**: Quarantine non-frozen concept variants (`Reclaimed OB`, `Propulsion Block`, `Vacuum Block`) into an explicit `NOT_REGISTERED` tier.

---

## 2. Ontology & Dual-Status Hierarchy

All concepts within the ICT/SMC domain are categorized into a **Structural Ontology** and tracked via a **Dual-Status System** (Semantic Status and Empirical Status).

```
                    ICT/SMC DOMAIN
                          │
              ┌───────────┴───────────┐
              │                       │
        SEMANTIC ONTOLOGY        DUAL STATUS SYSTEM
              │                       │
       CORE / DERIVED /          SEMANTIC STATUS:
       CONTEXT / MODEL /         REGISTERED | EXPERIMENTAL |
       NOT_REGISTERED            DEPRECATED | NOT_REGISTERED
              │
              │                  EMPIRICAL STATUS:
              │                  UNTESTED | ACTIVE_HYPOTHESIS |
              │                  SUPPORTED | NULL | FALSIFIED
              │
              ▼
       CAUSAL DETECTORS
              │
              ▼
       EVENT LIFECYCLES (availableAt cutoff)
              │
              ▼
       DERIVED CONTEXT
              │
              ▼
     CAUSAL SNAPSHOT @ T
              │
              ▼
   RAW SCALE-NORMALIZED FEATURES
              │
              ▼
      RESEARCH / ML LAYER
```

### 2.1 Structural Ontology Tiers
- **`CORE`**: Swings, BSL, SSL, FVG, Bullish/Bearish OB, ICT Supply/Demand Zones (distinct from OBs), BOS, CHoCH, MSS, Displacement, Premium/Discount.
- **`DERIVED`**: Balanced Price Range (BPR), Inverted FVG (IFVG), Breaker Block.
- **`CONTEXT`**: Sessions, Killzones, Dealing Range, `DrawOnLiquidityState`.
- **`MODEL`**: PO3/AMD, Silver Bullet, Turtle Soup, CRT, MMXM.
- **`NOT_REGISTERED`**: Reclaimed OB, Propulsion Block, Vacuum Block (quarantined).

*Note: Order Blocks (last opposite-color candle) and ICT Supply/Demand Zones (same-direction origin candle) are structurally distinct concepts and are not collapsed into a single detector.*

### 2.2 Dual-Status Tracking Schema
Every concept entry tracks:
- **`operationalization_status`**: `CANONICAL` | `AIQL_OPERATIONAL`
- **`semantic_status`**: `REGISTERED` | `EXPERIMENTAL` | `DEPRECATED` | `NOT_REGISTERED`
- **`empirical_status`**: `UNTESTED` | `ACTIVE_HYPOTHESIS` | `SUPPORTED` | `NULL` | `FALSIFIED`

---

## 3. Global Causal Invariants & Evaluation Clock

### 3.1 Evaluation Clock & Availability
Let $T$ represent the **evaluation instant** (current clock time or backtest step timestamp).

- **Bar Timestamps**: A candle $C$ has `barOpenTimestamp` and `barCloseTimestamp = barOpenTimestamp + timeframe`.
- **Causal Availability Theorem**: An event $E$ is completely invisible to downstream feature extraction and trading strategy logic unless:
  $$E.\text{availableAt} \le T$$

### 3.2 Non-Anticipative Feature Extraction
$$X_T = f(D_{\le T})$$
No feature value $X_T$ computed for evaluation instant $T$ may consume market data $D_{T + \Delta}$ for any $\Delta > 0$.

### 3.3 Scale-Free Volatility Normalization
Spatial distance metrics use ATR normalization to reduce instrument and volatility-scale dependence:
$$d_{\text{ATR}}(P_T, Z) = \begin{cases} 0 & \text{if } P_T \in [Z_{\text{low}}, Z_{\text{high}}] \\ \frac{\min(|P_T - Z_{\text{low}}|, |P_T - Z_{\text{high}}|)}{\text{ATR}_{14}(T)} & \text{otherwise} \end{cases}$$
*Note: ATR normalization reduces instrument and volatility-scale dependence; it does not by itself guarantee statistical stationarity.*

---

## 4. Timestamp Lifecycle Model

Domain events implement the extended `IctEventLifecycle` interface:

```typescript
export interface IctEventLifecycle {
  candidateAt?: number;    // Visual candidate appearance timestamp
  formedAt?: number;       // Structural formation completion timestamp
  confirmedAt: number;     // Rule requirements confirmation timestamp
  availableAt: number;     // MANDATORY cutoff timestamp for downstream strategy/ML usage
  testedAt?: number;       // First zone re-entry/test timestamp
  mitigatedAt?: number;    // 50% CE penetration / mitigation timestamp
  invalidatedAt?: number;  // Zone structural breach timestamp
}
```

### 4.1 Invariant Timestamp Rules
- `availableAt` is the **only** timestamp downstream feature extraction and execution logic may query.
- For a 5-minute bar opening at 10:00 (close at 10:05), an FVG confirmed on bar close has `confirmedAt = 10:05` and `availableAt = 10:05`. It cannot be accessed at evaluation instant $T = 10:00$.

---

## 5. Market Data & Session Calendar Architecture

### 5.1 Timezone & Template Separation
To prevent foreign FX session timings from corrupting domestic markets (e.g. Indian NSE equities/indices), session timing is decoupled into **Templates** and **Instrument Session Calendars**:

```typescript
export interface SessionWindowTemplate {
  templateId: string;       // e.g. "ICT_NY_AM" or "NSE_OPEN_MACRO"
  timezone: string;         // e.g. "America/New_York" or "Asia/Kolkata"
  localStart: string;       // e.g. "08:30" or "09:15"
  localEnd: string;         // e.g. "11:00" or "11:30"
}

export interface InstrumentSessionCalendar {
  symbol: string;           // e.g. "NIFTY50" or "EURUSD"
  exchange: string;         // e.g. "NSE" or "FOREX"
  timezone: string;         // e.g. "Asia/Kolkata"
  sessionTemplates: SessionWindowTemplate[];
}
```

---

## 6. Market Structure Definitions

### 6.1 Swing High & Swing Low (`ICT-STR-01`)
- **Canonical Definition**: Local extremum flanked by $L$ lower highs to the left and $R$ lower highs to the right.
- **Operationalization**:
  - `candidateAt` = timestamp of swing peak candle $i$.
  - `confirmedAt` = timestamp of bar $i + R$.
  - `availableAt` = `barCloseTimestamp(i + R)`.

### 6.2 Market Structure Shift (`ICT-STR-02`)
- **Canonical Definition**: Structural reversal breaking an opposite swing, driven by impulsive displacement delivery.
- **AIQL Operationalization** (`AIQL_OPERATIONAL`):
  - `swing_break`: Candle close beyond swing level.
  - `displacement_required`: `body_expansion_atr >= 1.0`.
  - `availableAt` = `barCloseTimestamp(breakBar)`.

### 6.3 Change in State of Delivery (`ICT-STR-03`)
- **Canonical Definition**: Algorithmic order flow shift marked by price closing back through the origin of a prior consecutive candle delivery leg.
- **AIQL Operationalization** (`AIQL_OPERATIONAL`, `EXPERIMENTAL`):
  - Requires $\ge 2$ consecutive opposite-colored candles.
  - Trigger candle body close beyond origin candle open price.
  - `availableAt` = `barCloseTimestamp(triggerBar)`.

---

## 7. Liquidity Definitions (`ICT-LIQ-01`, `ICT-LIQ-02`)

### 7.1 Observable Liquidity Pools (BSL / SSL)
- **Construct Definition**: Observable price levels/zones conventionally interpreted as expected Buy-Side Liquidity (BSL) or Sell-Side Liquidity (SSL) pools.
- **Observables**: Confirmed Swing Highs/Lows, Equal Highs/Lows (EQH/EQL), Previous Day/Week/Month High/Low (PDH/PDL/PWH/PWL/PMH/PML).
- *Note: OHLCV data cannot observe unexecuted resting order depth. BSL/SSL represents expected liquidity pool zones based on structural price action.*

### 7.2 Liquidity Sweep vs. Breakout
- **Sweep**: Wick penetrates liquidity level ($P_{\text{high}} > \text{Level}$) while candle close remains inside ($P_{\text{close}} \le \text{Level}$).
- **Breakout**: Candle close beyond level ($P_{\text{close}} > \text{Level}$).
- **Availability**: `availableAt = barCloseTimestamp(sweepBar)`.

### 7.3 Draw on Liquidity State (`DrawOnLiquidityState`)
- **Definition**: Contextual state representing candidate target liquidity pools toward which price is expected to gravitate based on distance and HTF bias.
- **Deterministic Selection Rule**:

```typescript
export interface DrawOnLiquidityState {
  candidatePools: LiquidityPool[];
  selectedPool?: LiquidityPool;
  direction?: -1 | 0 | 1;
  selectionRuleVersion: string; // e.g. "MIN_ATR_DISTANCE_WITH_HTF_BIAS_v1"
}
```

---

## 8. Imbalance Definitions (`ICT-IMB-01`, `ICT-IMB-02`)

### 8.1 Fair Value Gap (FVG) Boundary Configurations

- **`FVG_BOUNDARY = WICK`**:
  - Bullish: $\text{Low}_{\text{bar } 3} > \text{High}_{\text{bar } 1}$. Boundary = $[\text{High}_{\text{bar } 1}, \text{Low}_{\text{bar } 3}]$.
  - Bearish: $\text{High}_{\text{bar } 3} < \text{Low}_{\text{bar } 1}$. Boundary = $[\text{High}_{\text{bar } 3}, \text{Low}_{\text{bar } 1}]$.
- **`FVG_BOUNDARY = BODY`**:
  - Bullish: $\min(\text{Open}_3, \text{Close}_3) > \max(\text{Open}_1, \text{Close}_1)$. Boundary = $[\max(\text{Open}_1, \text{Close}_1), \min(\text{Open}_3, \text{Close}_3)]$.
  - Bearish: $\max(\text{Open}_3, \text{Close}_3) < \min(\text{Open}_1, \text{Close}_1)$. Boundary = $[\max(\text{Open}_3, \text{Close}_3), \min(\text{Open}_1, \text{Close}_1)]$.

*Bug Fix Note: In Bearish BODY mode, $\max(\text{Open}_3, \text{Close}_3) < \min(\text{Open}_1, \text{Close}_1)$, so the lower boundary is $\max(\text{Open}_3, \text{Close}_3)$ and the upper boundary is $\min(\text{Open}_1, \text{Close}_1)$.*

---

## 9. Displacement Metrics (`ICT-DSP-01`)

To prevent circular dependencies and arbitrary composite weightings, displacement evidence is exported as unweighted raw primitives:

- **Body Expansion Metric**:
  $$\text{body\_expansion\_atr} = \frac{|\text{Close} - \text{Open}|}{\text{ATR}_{14}}$$
- **FVG Creation Flag**: `fvg_created: boolean`
- **Displacement Confirmation Flag**: `displacement_confirmed: boolean` (`body_expansion_atr >= 1.0`)
- **Operational Metric** (`AIQL_OPERATIONAL_METRIC`):
  If exported for research scoring, `displacement_score` is explicitly marked as an operational metric rather than a canonical ICT definition.

---

## 10. PD Array Definitions (`ICT-PDA-01`, `ICT-PDA-02`)

### 10.1 Order Block (OB) Decoupled Qualification
To eliminate circularity, OB definition is decoupled into three stages:
1. **Formation**: Last opposing candle(s) prior to directional move.
2. **Confirmation**: Followed by qualifying body expansion ($\text{body\_expansion\_atr} \ge 1.0$).
3. **Optional Strategy Context**: Subsequent association with an MSS or FVG.

---

## 11. Valuation Definitions (`ICT-VAL-01`, `ICT-VAL-02`)

- **Dealing Range**: Anchored strictly to causally confirmed major swing high/low pivots.
- **Equilibrium (50%)**: $P_{\text{EQ}} = \frac{\text{SwingHigh} + \text{SwingLow}}{2}$.
- **OTE Retracement**: Calculated strictly on a causally confirmed source displacement leg ($61.8\%$, $70.5\%$, $78.6\%$).

---

## 12. Lifecycle State Machine & Transitions

Order Blocks and FVGs transition across 4 formal states:

```
  [FRESH] ──(test)──> [TESTED] ──(50% CE)──> [MITIGATED] ──(close through)──> [INVALIDATED]
```

Each state transition emits a lifecycle record with its own `availableAt` timestamp.

---

## 13. Raw Feature Schema (Scale-Free ATR)

Features extracted at evaluation instant $T$:

```typescript
export interface IctRawPrimitiveFeatureVector {
  evaluationInstant: number;
  
  // Market Structure
  mss_present: boolean;
  mss_direction: -1 | 0 | 1;
  mss_age_bars: number;
  cisd_present: boolean;
  cisd_age_bars: number;

  // Liquidity
  liquidity_sweep_present: boolean;
  liquidity_sweep_direction: -1 | 0 | 1;
  liquidity_sweep_age_bars: number;
  liquidity_sweep_distance_atr: number;

  // Imbalance
  fvg_present: boolean;
  fvg_direction: -1 | 0 | 1;
  fvg_distance_atr: number;
  fvg_age_bars: number;
  bpr_present: boolean;
  bpr_distance_atr: number;

  // PD Arrays
  ob_present: boolean;
  ob_direction: -1 | 0 | 1;
  ob_distance_atr: number;
  ob_age_bars: number;
  ob_mitigation_count_at_T: number;

  // Valuation & Context
  premium_discount_state: -1 | 0 | 1;
  ote_zone_active: boolean;
  session_killzone_active: boolean;
  body_expansion_atr: number;
  fvg_created: boolean;
  displacement_confirmed: boolean;
}
```

---

## 14. Dual Replay Invariance Specifications

### 14.1 Prefix Invariance Specification
Canonical serialized snapshot output at evaluation instant $T$ must be identical whether computed on truncated history or full history:
$$\text{CausalSnapshot}(D_{[0 \dots T]}, T) \equiv \text{CausalSnapshot}(D_{[0 \dots N]}, T) \quad \forall T \le N$$

### 14.2 Future Perturbation Invariance Specification
Adversarial test appending synthetic divergent futures $F_1, F_2$ past $T$:
$$\text{CausalSnapshot}(D_{[0 \dots T]} \cup F_1, T) \equiv \text{CausalSnapshot}(D_{[0 \dots T]} \cup F_2, T)$$

*Note: Canonical snapshots exclude memory addresses, nondeterministic IDs, cache metadata, and runtime timestamps.*

---

## 15. NOT_REGISTERED Registry

The following concept variants are flagged as `NOT_REGISTERED`:
1. **Reclaimed Order Block**: Competing definitions (re-tested active OB vs recovered broken OB).
2. **Propulsion Order Block**: Conflicting definitions (OB inside OB retest vs LTF substructure zone).
3. **Vacuum Block**: Inconsistent usage (rejection block synonym vs volatility gap).
