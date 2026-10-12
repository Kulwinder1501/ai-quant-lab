# FRVP-MSP Phase 0 — closed research record

**Experiment ID:** `FRVP-MSP-P0-2026-10-12`  
**Closed:** 2026-10-12  
**Hypothesis A (signal-only):** **INCONCLUSIVE**  
**Next research stage (options replay):** **not authorized**  
**Production / Pillar 6 / score / live Sniper:** **untouched**

## Mentor-aligned disposition

The FRVP **calculation is not shown to be broken**. The registered policy  
`PROFILE_POLICY_LVN_AHEAD_v1` is **too selective to evaluate** on this sample.

| Claim | Status |
|---|---|
| Allocator defect | Not demonstrated (conservation fixtures + live session sums PASS) |
| Profile fidelity vs trade VAP | Still an **approximation** (estimated OHLCV FRVP) |
| LVN detector vs frozen spec | Behaves as specified; selectivity needs independent validation of *usefulness*, not more LVN count |
| `LVN_AHEAD` policy | **Untestable** here (0 selected trades) |
| Hypothesis A | **INCONCLUSIVE** (not FAIL, not PASS) |

Empty policy ≠ evidence that FRVP is ineffective.  
Empty policy ≠ licence to loosen rules against this locked OOS.

## Why the policy did not run (isolated)

1. **Node rarity under frozen prominence:** mean qualifying LVNs/session ≈ 0.29 vs mean shallow local minima ≈ 24.7 (5%-of-POC custom rule ≠ universal LVN definition).  
2. **Residual candidates fail directional / distance / intervening-HVN predicates** (funnel ends at 0).

Detail: `docs/2026-10-12-frvp-phase0-implementation-audit.md`  
Machine log: `logs/frvp-msp-phase0-implementation-audit.json`

## Preserved artifact set (do not overwrite for outcome shopping)

| Artifact | Path |
|---|---|
| Preregistration (normative) | `docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md` |
| Status | `docs/2026-10-12-frvp-momentum-scalp-phase0-status.md` |
| Data gate | `logs/frvp-msp-phase0-data-gate.json` |
| Baseline manifest + candidates | `logs/frvp-msp-phase0-baseline-manifest.json`, `…-candidates.jsonl` |
| Attached features | `logs/frvp-msp-phase0-candidates-attached.jsonl` |
| Frozen splits | `logs/frvp-msp-phase0-chronological-splits.json` |
| Signal-only decision | `logs/frvp-msp-phase0-replay-result.json` |
| Implementation audit | `logs/frvp-msp-phase0-implementation-audit.json` |
| Audit fixtures | `apps/ml/tests/test_estimated_frvp.py`, `…_audit.py` |

## Allowed follow-ups (only)

**A. Finish / extend implementation audit** (spec conformance): synthetic profiles, per-session histograms/node counts, directional and intervening-HVN predicates — *without* changing frozen thresholds to chase activations on this holdout.

**B. Optionally register a new hypothesis** later: broader / differently defined LVN corridor must be justified and **frozen on development data**, then tested on a **new untouched evaluation window**, under a **separately dated protocol**. Success metric remains incremental net signal value — not “more LVNs.”

## Explicitly forbidden on this record

- Retuning prominence, bin size, `ahead_max`, or event codes using current OOS outcomes  
- Options-level Sniper replay authorization from this experiment  
- Production wiring, Pillar 6, score changes, live strategy edits  
