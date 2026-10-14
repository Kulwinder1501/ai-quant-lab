# OFVP probe-time selector v1 (preregistration)

**Document ID:** `OFVP-PROBE-SELECTOR-V1`  
**Frozen:** `2026-10-14`  
**Status:** Research only — `tradingExecutionAuthorized: false`  
**Depends on:** [OFVP_PHASE2_COST_FLOOR_V1.1.md](OFVP_PHASE2_COST_FLOOR_V1.1.md), [2026-10-13-frvp-rows-observation-protocol.md](../../2026-10-13-frvp-rows-observation-protocol.md)  
**Code stamp:** `FRVP_OBS` / `frvp-rows48-v2` (`volume-profile-observation.ts`)

## 1. Why this study exists

Phase-2 showed that **among probes that later returned into value**, the median |boundary−POC| prize can clear the sealed **~9.7 bps** round-trip cost floor (`TARGET_EXCEEDS_COST` on H1 RETURNED). That population is only **~9%** of probes and is **not known at probe time**. Structural HVN targets (H2) sit **below** the cost floor.

Without a **probe-time** (decision-time) selector that concentrates into that economic class at roughly **64–76%** break-even win rate (Phase-2 stop table), H1 cannot pay. This document freezes one selector study on **forward** `FRVP_OBS` stamps. It does **not** authorize trading.

## 2. Explicit non-goals

- Do **not** fit or tune a selector on `logs/ofvp-phase2-baseline.json` or any Phase-2 retrospective probe file.
- Do **not** use post-hoc RETURNED / excursion / P&L labels as features.
- Do **not** enable a live OFVP bot or change `executableSides` from this study.
- Do **not** retune thresholds after looking at the evaluation window.
- Live paper bots (Sniper, ICT, Hybrid, Trend Cont, Scalp1m) are **out of scope** for this workstream.

## 3. Population (fresh window)

| Field | Definition |
|---|---|
| Unit | One closed `paper_trades` row with a parseable `FRVP_OBS` JSON ending the notes |
| Version | `frvp.v = "frvp-rows48-v2"` |
| Quality | `frvp.d1.st = "OK"` |
| Start | First stamped trade on/after **2026-10-14** (IST session). Phase-2 history and FRVP *development* sessions (2026-10-01..10-12 profile tuning) are not used for fitting; stamps did not exist then anyway |
| Bots | Primary: `AutoBot-Sniper`. Replication (report only, not pooled): `AutoBot-Scalp1m` when stamped |
| Exclude | `excluded_from_evidence = true`; unparseable notes; top-level-only failures without `d1` |

This is a **trade-entry** population (conditioned on a bot having opened), not the Phase-2 VAH/VAL probe stream. It answers: *among entries we already take, do frozen profile features at decision time mark an economically better subset?* It does **not** revive Phase-2 probe fade as a strategy by itself.

## 4. Features allowed (probe / decision time only)

All from `FRVP_OBS` (and trade fields known at open). Nothing that requires future path:

| Feature | Source |
|---|---|
| `d1.pos` | `INSIDE_VALUE` / `ABOVE_VAH` / `BELOW_VAL` |
| `d1.open` | boolean (LVN ahead nearer than HVN ahead) |
| `d1.sh`, `d1.stb`, `d1.pp`, `d1.cp` | shape / stability / POC & centroid positions |
| `d1.lvnA_dist`, `d1.hvnA_dist`, `d1.rw` | distances / row width (points) |
| `d1.lvnA_dist_R` | `lvnA_dist / initial_risk_distance` when risk &gt; 0 |
| `d0.st`, `d0.sh`, `d0.pos`, `d0.open` | only if `d0.st = OK`; else mark unavailable |
| `tod_bucket` | IST hour of `opened_at` in {09,10,11,12,13,14,15} |
| `underlying` | `NIFTY50` / `BANKNIFTY` |

**Forbidden as features:** realized PnL, exit reason, RETURNED flag, post-entry excursion, any label that uses bars after `opened_at`.

## 5. Frozen primary selector (S1)

Evaluate **exactly** this rule (same corridor flag as FRVP protocol H1, restated for OFVP economics):

```
d1.st = OK
AND d1.open = true
AND d1.lvnA is not null
AND d1.lvnA_dist <= initial_risk_distance   -- distance in index points ≤ 1R
```

No other primary rule. Secondary **descriptive** slices (`pos`, shape agree/against) may be tabulated but **cannot** change S1 or promote.

## 6. Outcomes and cost bar

| Metric | Definition |
|---|---|
| Net PnL | `realized_pnl - fees` (rupees, as stored) |
| Net R | `net_pnl / (initial_risk_distance * quantity)` when planned risk &gt; 0 |
| Win | `net_pnl > 0` |
| Selected | S1 true; **Complement** = `d1.st=OK` and not S1 |

**Economic reference (from Phase-2, not re-derived here):** sealed floor **9.7 bps**; BE WR on the Phase-2 stop table **~64% (BANKNIFTY) / ~69% (NIFTY50)** at 1× excursion, higher at 2×. For this trade population, report selected win rate and mean net R; the Phase-2 BE WR is the **aspirational** bar for claiming OFVP-style economic viability. Crossing it on options paper is necessary for a later paper-bot protocol, not automatic permission.

## 7. Sample rule and verdicts

**Judge once** when all hold:

1. ≥ **100** closed Sniper rows with `d1.st=OK` in the fresh window  
2. ≥ **25** of them with **S1 = true**  
3. Coverage: ≥ **70%** of Sniper closes in the window carry parseable `FRVP_OBS` with `d1.st=OK`

Until then: **interim counts only** (no p-value, no PASS).

| Verdict | When |
|---|---|
| **PASS** | Sample rule met; selected mean net R &gt; complement (one-sided, day-clustered permutation, α=0.05); selected win rate ≥ **0.64** on the pooled selected set **or** both underlyings ≥ their Phase-2 BE WR; Scalp1m replication (if n≥25 S1) same sign on mean net R |
| **FAIL** | Sample rule met and (selected not better on mean net R **or** selected WR below 0.55) |
| **INCONCLUSIVE** | Sample rule unmet by **2026-12-31**, or OK coverage &lt; 70% |

Holm is not required (single primary S1). `tradingExecutionAuthorized` remains **false** on PASS; PASS only authorises a **separately dated** shadow/paper protocol.

## 8. Inventory note (2026-10-14, start of study)

Forward stamps exist (`frvp-rows48-v2`, nested `d1`/`d0`). As of study start: **18** closed stamped trades (17 Sniper, 1 TrendCont); **17/17** Sniper with `d1.st=OK`; **16/17** with `d0.st=OK`. S1 and economic tests are **not** powered. Descriptive cuts after this date must not rewrite §5.

## 9. Artifacts

- Extract / interim review: `apps/ml/run_ofvp_probe_selector_v1.py`  
- Machine interim JSON: `logs/ofvp-probe-selector-v1-interim.json` (gitignored if under `logs/`)  
- This prereg is the normative freeze; code must not silently change S1.

## 10. Change control

Any change to population, features, S1, sample rule, or verdict definitions requires a **dated amendment before** examining outcomes under the new rule.
