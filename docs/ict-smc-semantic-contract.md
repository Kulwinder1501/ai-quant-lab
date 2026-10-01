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
3. **Enforce Causal Zero-Lookahead**: Establish causal lifecycle models separating single structural events (`IctCausalEvent`: `candidateAt?`, `formedAt?`, `confirmedAt?`, `availableAt`) from persistent POI zones (`IctZoneLifecycle`: `testedAt?`, `mitigatedAt?`, `invalidatedAt?`), where `availableAt` is the **only** timestamp accessible to downstream strategy and feature pipelines.
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
       LEVEL / EVENT / ZONE /    SEMANTIC STATUS:
       STATE / CONTEXT / MODEL / REGISTERED | EXPERIMENTAL |
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
       DERIVED CONTEXT & STATES
              │
              ▼
      CAUSAL SNAPSHOT @ T
              │
              ▼
    RAW ATR-NORMALIZED FEATURES
              │
              ▼
       RESEARCH / ML LAYER
```

### 2.1 Structural Ontology Tiers & Concept Families

Domain objects are classified along two orthogonal axes: **Structural Ontology Tier** (object semantics) and **Concept Family** (functional domain).

#### Structural Ontology Tiers:
- **`LEVEL`**: Buy-Side Liquidity (BSL), Sell-Side Liquidity (SSL), Equal Highs/Lows (EQH/EQL), Previous Day/Week/Month High/Low (PDH/PDL/PWH/PWL/PMH/PML).
- **`EVENT`**: Market Structure Shift (MSS), Break of Structure (BOS), Change of Character (CHoCH), Liquidity Sweep, Change in State of Delivery (CISD).
- **`ZONE`**: Fair Value Gap (FVG), Bullish/Bearish Order Block (OB), Breaker Block, Rejection Block, Balanced Price Range (BPR), ICT Supply/Demand Zones (distinct from OBs).
- **`STATE`**: Candidate Target Liquidity State (`DrawOnLiquidityState`).
- **`CONTEXT`**: Premium/Discount State, Dealing Range, Sessions, Killzones.
- **`MODEL`**: Power of 3 (PO3/AMD), Silver Bullet, Turtle Soup, Classic Reversal Template (CRT), Market Maker Execution Model (MMXM).
- **`NOT_REGISTERED`**: Reclaimed OB, Propulsion Block, Vacuum Block (quarantined).

#### Concept Families:
- **`Structure`** (`family = STRUCTURE`): Swings (`ontology = LEVEL`), MSS (`ontology = EVENT`), BOS (`ontology = EVENT`), CHoCH (`ontology = EVENT`).
- **`Liquidity`** (`family = LIQUIDITY`): BSL/SSL pools (`ontology = LEVEL`), Sweeps/Breakouts (`ontology = EVENT`), Equal Highs/Lows (`ontology = LEVEL`).
- **`Imbalance`** (`family = IMBALANCE`): Fair Value Gap (`ontology = ZONE`), Balanced Price Range (`ontology = ZONE`), Inverted FVG (`ontology = ZONE`).
- **`PD Arrays`** (`family = PD_ARRAYS`): Order Block (`ontology = ZONE`), Breaker Block (`ontology = ZONE`), Rejection Block (`ontology = ZONE`), ICT Supply/Demand (`ontology = ZONE`).
- **`Valuation`** (`family = VALUATION`): Dealing Range (`ontology = CONTEXT`), Premium/Discount (`ontology = CONTEXT`), OTE Retracement (`ontology = CONTEXT`).
- **`Time`** (`family = TIME`): Sessions (`ontology = CONTEXT`), Killzones (`ontology = CONTEXT`), Macro windows (`ontology = CONTEXT`).

*Note: Order Blocks (last opposite-color candle) and ICT Supply/Demand Zones (same-direction origin candle) are structurally distinct concepts and are not collapsed into a single detector.*

### 2.2 Dual-Status Tracking Schema
Every concept entry tracks:
- **`operationalization_status`**: `CANONICAL` | `AIQL_OPERATIONAL`
- **`semantic_status`**: `REGISTERED` | `EXPERIMENTAL` | `DEPRECATED` | `NOT_REGISTERED`
- **`empirical_status`**: `UNTESTED` | `ACTIVE_HYPOTHESIS` | `SUPPORTED` | `NULL` | `FALSIFIED`

---

## 3. Global Causal Invariants & Evaluation Clock

### 3.1 Evaluation Clock & Availability
Let $T$ represent the **evaluation timestamp** (current clock instant or backtest evaluation time), which is strictly distinguished from candle timestamps:
- **Bar Timestamps**: A candle $i$ has `barOpenTimestamp(i)` and `barCloseTimestamp(i) = barOpenTimestamp(i) + timeframe`.
- **Closed-Bar Evaluation Rule**: For the OHLCV domain engine, evaluation timestamps $T$ are strictly restricted to completed bar close timestamps:
  $$T \in \{ \text{barCloseTimestamp}(i) \}$$
  *All ICT/SMC feature snapshots are evaluated at completed-bar close unless a detector explicitly declares support for partial-bar intrabar observations.*
- **Causal Availability Theorem**: An event $E$ is completely invisible to downstream feature extraction and trading strategy logic unless:
  $$E.\text{availableAt} \le T$$

### 3.2 Non-Anticipative Feature Extraction
$$X_T = f(D_{\le T})$$
No feature value $X_T$ computed for evaluation instant $T$ may consume market data $D_{T + \Delta}$ for any $\Delta > 0$.

### 3.3 ATR-Normalized Volatility Scaling
Spatial distance metrics use ATR normalization to reduce instrument and volatility-scale dependence:
$$d_{\text{ATR}}(P_T, Z) = \begin{cases} 0 & \text{if } P_T \in [Z_{\text{low}}, Z_{\text{high}}] \\ \frac{\min(|P_T - Z_{\text{low}}|, |P_T - Z_{\text{high}}|)}{\text{ATR}_{14}(T)} & \text{otherwise} \end{cases}$$
*Note: ATR normalization reduces instrument and volatility-scale dependence; it does not by itself guarantee statistical stationarity.*

---

## 4. Timestamp Lifecycle Model

Domain objects separate event causality from zone lifecycles via `IctCausalEvent` and `IctZoneLifecycle`:

```typescript
// Applicable to all single point-in-time structural events (MSS, BOS, CHoCH, Sweep, CISD, Session)
export interface IctCausalEvent {
  candidateAt?: number;    // Visual candidate appearance timestamp
  formedAt?: number;       // Structural formation completion timestamp
  confirmedAt?: number;    // Rule requirements confirmation timestamp
  availableAt: number;     // MANDATORY downstream cutoff timestamp
}

// Applicable only to persistent structural POI zones (OB, FVG, Breaker, BPR, Rejection Block)
export interface IctZoneLifecycle extends IctCausalEvent {
  testedAt?: number;       // First zone re-entry/test timestamp
  mitigatedAt?: number;    // 50% CE penetration / mitigation timestamp
  invalidatedAt?: number;  // Zone structural breach timestamp
}
```

### 4.1 Categorized Domain Interface Mapping
- **`IctCausalEvent`**: `MSS`, `BOS`, `CHoCH`, `Liquidity Sweep`, `CISD`, `Session`.
- **`IctZoneLifecycle`**: `Order Block (OB)`, `Fair Value Gap (FVG)`, `Breaker Block`, `Rejection Block`, `Balanced Price Range (BPR)`.

### 4.2 Invariant Timestamp Rules
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
- **Canonical Definition**:
  - **Swing High at bar $i$**: A local maximum high flanked by $L$ bars to the left and $R$ bars to the right satisfying:
    $$H_i > H_j \quad \forall j \in [i-L, i+R], \; j \neq i$$
    Equivalently: $H_i = \max(H_{i-L}, \ldots, H_{i+R})$ with strict inequality flanking.
  - **Swing Low at bar $i$**: A local minimum low flanked by $L$ bars to the left and $R$ bars to the right satisfying:
    $$L_i < L_j \quad \forall j \in [i-L, i+R], \; j \neq i$$
    Equivalently: $L_i = \min(L_{i-L}, \ldots, L_{i+R})$ with strict inequality flanking.
- **Equal Highs / Equal Lows Handling**:
  If two adjacent highs $H_i$ and $H_k$ ($|i-k| \le 2$) satisfy $|H_i - H_k| / H_i \le 0.0005$ and both clear flanking bounds, they are classified as **Equal Highs (EQH)** liquidity levels rather than a single distinct swing high.
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

### 7.3 Candidate Target Liquidity State (`DrawOnLiquidityState`)
- **Definition**: Contextual state representing candidate target liquidity pools toward which price is expected to move based on distance and HTF bias.
- **Deterministic Selection Schema**:

```typescript
export interface DrawOnLiquidityState {
  candidatePools: LiquidityPool[];
  selectedPool?: LiquidityPool;
  direction?: -1 | 0 | 1;
  selectionRuleVersion: string; // e.g. "LIQUIDITY_TARGET_SELECTION_V1"
}
```

*Operationalization Note: `DrawOnLiquidityState` is an `AIQL_OPERATIONAL` state representation of candidate target liquidity pools for feature tracking, not an empirical assertion that market price is guaranteed to move toward the selected pool.*

### 7.4 Formal 8-Step Deterministic Selection Algorithm

Given evaluation instant $T$, price $P_T$, ATR $\text{ATR}_{14}(T)$, pool history $\mathcal{H}_{\text{pools}}$, and HTF directional bias $\text{direction}_{\text{HTF}} \in \{-1, 0, 1\}$:

1. **Step 1: Pool Identification**: Gather all structural liquidity pools from $\mathcal{H}_{\text{pools}}$.
2. **Step 2: Causal Availability Gate**: Keep strictly pools satisfying $\text{pool}.\text{availableAt} \le T$.
3. **Step 3: Exclude Invalid/Expired Pools**: Filter out pools with `state === 'INVALIDATED'` or `state === 'BREACHED'`.
4. **Step 4: Pool Eligibility Rules**: Filter by recognized level types (`PWH`, `PWL`, `PDH`, `PDL`, `ITH`, `ITL`, `SWING_HIGH`, `SWING_LOW`, `SESSION_HIGH`, `SESSION_LOW`, `EQH`, `EQL`).
5. **Step 5: Directional & HTF-Bias Policy**:
   - If $\text{direction}_{\text{HTF}} = 1$ (Bullish): Keep only Buy-Side Liquidity (BSL) target pools ($\text{level} > P_T$).
   - If $\text{direction}_{\text{HTF}} = -1$ (Bearish): Keep only Sell-Side Liquidity (SSL) target pools ($\text{level} < P_T$).
   - If $\text{direction}_{\text{HTF}} = 0$ (Neutral): Keep both BSL and SSL pools.
6. **Step 6: ATR-Normalized Distance Calculation**:
   For each candidate pool, compute:
   $$d_{\text{ATR}}(P_T, \text{pool}) = \frac{|\text{pool}.\text{price} - P_T|}{\text{ATR}_{14}(T)}$$
7. **Step 7: Candidate Ranking & Deterministic Tie-Break**:
   Sort qualified candidate pools ascending by $d_{\text{ATR}}(P_T, \text{pool})$. If two candidate pools $\text{pool}_A$ and $\text{pool}_B$ satisfy $|d_{\text{ATR}}(\text{pool}_A) - d_{\text{ATR}}(\text{pool}_B)| < 0.01$:
   - **Tie-Break 7a (Priority Tier)**: Select pool with higher structural priority tier:
     - Tier 1: `PWH`, `PWL`, `PDH`, `PDL`, `PMH`, `PML`
     - Tier 2: `ITH`, `ITL`, `SWING_HIGH`, `SWING_LOW`
     - Tier 3: `SESSION_HIGH`, `SESSION_LOW`, `EQH`, `EQL`
   - **Tie-Break 7b (Recency)**: If priority tiers are equal, select pool with larger `availableAt` timestamp descending.
   - **Tie-Break 7c (Lexicographical ID)**: If still tied, sort by pool string `id` ascending.
8. **Step 8: No-Candidate Behavior & Opposing Equidistance Resolution**:
   - If no pool qualifies, return `selectedPool = undefined`, `direction = 0`, `candidatePools = []`.
   - When $\text{direction}_{\text{HTF}} = 0$, if top BSL and top SSL pools are tied in $d_{\text{ATR}}$ ($< 0.01$), select the pool matching current bar directional expansion ($P_{\text{close}} > P_{\text{open}} \rightarrow \text{BSL}$; $P_{\text{close}} < P_{\text{open}} \rightarrow \text{SSL}$).

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
  [FRESH] ──(test)──> [TESTED] ──(mitigation rule)──> [MITIGATED] ──(close through)──> [INVALIDATED]
```

Each state transition emits a lifecycle record with its own `availableAt` timestamp.

*Operationalization Rule (`AIQL_OPERATIONAL`)*:  
Zone mitigation is quantified using operational rule `ZONE_MITIGATION_RULE = CE_50_V1`, defining mitigation as price penetration reaching $\ge 50\%$ Consequent Encroachment (CE) / Mean Threshold. Canonical ICT semantics define mitigation conceptually as price returning into a zone's rebalancing area, while 50% CE is AI Quant Lab's explicit operationalization threshold.

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
