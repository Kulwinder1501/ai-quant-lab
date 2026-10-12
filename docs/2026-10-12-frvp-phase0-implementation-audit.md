# FRVP-MSP Phase 0 — implementation audit (not a performance re-run)

**Experiment:** `FRVP-MSP-P0-2026-10-12`  
**Disposition:** Hypothesis A remains **INCONCLUSIVE** (closed record)  
**Mentor alignment:** Allocator not shown broken; policy too selective to evaluate; next stage not authorized  
**Scope:** Code-level diagnostic of allocator, LVN detector, and `LVN_AHEAD` predicate  
**Artifacts:** `logs/frvp-msp-phase0-implementation-audit.json`, `apps/ml/tests/test_estimated_frvp_audit.py`  
**Closed record:** `docs/2026-10-12-frvp-msp-phase0-closed-record.md`  
**Boundaries:** No threshold retune, no options replay, no production / Pillar 6 / score / live Sniper changes

## Mentor question

Is the FRVP implementation wrong, or is zero `LVN_AHEAD` a genuine empty-policy result on this window?

## Short answer

**Allocator and value-area construction look correct** (volume is conserved; not duplicated into every bin).  
**The LVN detector and `LVN_AHEAD` predicate behave as coded on synthetic fixtures.**  
On the real OCT attach set, **zero activation is explained by the frozen rules + estimated candle profile shape**, not by a broken volume sum:

| Funnel step (1 334 candidates) | Count |
|---|---|
| Profile built | 1334 |
| Prior-session profile has **0** qualifying LVNs | **1037** |
| Has LVN(s), none in trade direction | 273 |
| LVN in direction but outside `ahead_max` | 21 |
| Inside distance window, blocked by intervening HVN | 3 |
| Would fire `LVN_AHEAD` | **0** |

So: **not a strategy failure, not yet a certified “profile math is wrong” finding.** It is an **empty registered-policy set** under the frozen detector/predicate on this estimated profile.

---

## Step 1 — Volume allocator audit

Implementation (`allocate_bar_volume_uniform`):

- Inclusive tick bins from rounded `low`→`high`
- Each overlapping bin receives `volume / n_bins` (not full volume per bin)
- Session `total_volume` and `sum(bin_volumes)` both equal sum of positive input bar volumes

**Fixture + live checks:** PASS conservation; no duplication bug.

70% value area: expands from POC by adjacent relative volume; tie breaks to lower-price bin first (matches prereg).

---

## Step 2 — LVN detector (independent)

Frozen rule: local min vs both immediate neighbours with prominence ≥ **5% of POC volume** (HVN symmetric local max; POC excluded from HVN list).

Synthetic fixtures (now in `test_estimated_frvp_audit.py`):

- Two-peak + trough → LVN found  
- Unimodal / monotonic → no LVN  
- Shallow trough below prominence → rejected  
- Corridor HVN blocks `LVN_AHEAD`

**Live OCT sessions (56 session profiles):**

| Metric | Value |
|---|---|
| Sessions with any qualifying LVN | 11 / 56 |
| Mean qualifying LVN count | **0.29** |
| Mean **shallow** 3-point local minima (no prominence) | **24.7** |

This matches mentor **Risk A/B**: 1m candle uniform allocation smooths the histogram; many tiny troughs exist, but almost none clear 5%-of-POC prominence on a tick grid.

---

## Step 3 — `LVN_AHEAD` predicate

Frozen window: `ahead_max = max(8 × tick, 0.25 × ATR(14,1m))`.  
On this book, median `ahead_max` is only a few index points (~1.6–5), while directional LVNs that do exist are often **tens to hundreds of points** away (examples logged in the JSON audit).

Of the 297 candidates on profiles that had ≥1 LVN:

- 273 had no LVN on the trade-direction side  
- 21 failed the distance window  
- 3 failed the intervening-HVN corridor  
- **0** passed

Classifier agrees with the stepwise funnel (no hidden attach bug that drops events after a true pass).

**Basis mapping:** `L_index = L_fut − (F_t − I_t)` with ≤60s sync — left unchanged; tick size read from instrument rows (0.05 on these contracts).

---

## Step 4 — Holdout / protocol

- Locked chronological splits and acceptance thresholds **not** retuned  
- No amendment that would re-open outcome shopping on this holdout  
- Hypothesis A stays **INCONCLUSIVE**: the policy could not be comparatively evaluated because it selected no trades

## What this is *not*

- Not proof that momentum-scalp-pattern lacks edge  
- Not authorization for options-level replay  
- Not a licence to loosen prominence / `ahead_max` against locked OOS outcomes  

If a revised node or event definition is proposed later, it requires a **dated protocol amendment** and an **untouched evaluation window**.

## How to re-run the audit

```bash
# unit fixtures
cd apps/ml && python -m pytest tests/test_estimated_frvp.py tests/test_estimated_frvp_audit.py -q

# live diagnostic (needs DATABASE_URL + prior attach JSONL)
python run_frvp_phase0_implementation_audit.py
```
