# Phase 27 Step 2 — Premium-space measurement (preregistration)

**Document ID:** `PHASE27-STEP2-PREMIUM-MEASURE-V1`  
**Frozen:** `2026-10-14`  
**Status:** Research only — `tradingExecutionAuthorized: false`  
**Parent:** [phase-27-option-premium-scalping.md](phase-27-option-premium-scalping.md)  
**Does not reopen:** D2 / Phase 29 (`d2-premium-cost-gate.ts` is a different frozen candidate)

## 1. Why this study exists

Phase 27 Step 1 asked for ATM option premiums at scalping cadence before any strategy work. As of 2026-10-14:

| Parent constraint (2026-08-07) | Status |
|---|---|
| `option_chain_snapshots` ~every 15 minutes | **Still true** (~15–16 min) — not used as the mark for this study |
| Dense ATM premium quotes | **Available** — `option_premium_ticks` (~3.1M rows; typical good sessions &lt;1s between ticks, hundreds of distinct minutes/day) |
| Futures instruments missing | **Fixed** (out of scope here; premium path does not need them) |
| Step 2 measure / Step 3 implement | **Not done** |

This document freezes **Step 2 only**: measure whether a simple 1-minute premium-side rule clears **premium-space** round-trip cost at a **stated lot size**. It does **not** authorize a bot, a new strategy key, or live paper changes.

## 2. Explicit non-goals

- Do **not** signal on the index and hope options pay (parent §0 rejected that path).
- Do **not** use 15-minute `option_chain_snapshots` as entry/exit marks for this study.
- Do **not** retune signal thresholds after looking at the evaluation window.
- Do **not** treat a Track A underlying-bps pass as evidence (wrong unit for options).
- Do **not** implement Step 3 (premium-signal bot / scalp exit loop) unless this study returns **PASS**.
- Do **not** pool with D2’s 30-minute horizon candidate or reuse its PASS/FAIL.

## 3. Open questions from parent §4 — frozen answers for this study

| # | Question | Frozen answer |
|---|---|---|
| 1 | Where do premium bars live? | **Derived from `option_premium_ticks`**, aggregated to 1m OHLCV per `(provider_symbol, minute)` for the study only. No new `instruments` rows required for Step 2. |
| 2 | ATM band width? | At each decision minute: contracts present in ticks whose `underlying_value` is within **1 strike step** of ATM, nearest listed expiry with ≥2 DTE (same floor as live `MINIMUM_DAYS_TO_EXPIRY`). If multiple, pick highest tick count in the prior 5 minutes. |
| 3 | Lot size? | **5 lots** (parent §1: 1-lot tests reject strategies that can clear cost at 5). Quantity = `5 × lot_size` from the instrument/contract metadata used by paper trading. |
| 4 | Mark source for held path? | **Ticks only** for entry ask / exit bid. Chain snapshots are audit-only. |

## 4. Population and windows

| Field | Definition |
|---|---|
| Unit | One resolved 1m decision on one underlying (`NIFTY50` or `BANKNIFTY`) |
| Data | `option_premium_ticks` with non-null `bid`, `ask`, `underlying_value` |
| Session | IST RTH 09:20–15:20 (skip first 5 and last 10 minutes) |
| Train / tune | **None.** No threshold search. |
| Evaluation window | Sessions from **2026-09-01** through **2026-10-13** inclusive that have ≥200 distinct tick-minutes for that underlying (coverage gate). Sessions after freeze may be used only as a **holdout** listed in an amendment dated before they are scored. |
| Exclude | Minutes with missing bid/ask; spread &gt; 5% of mid; quote age &gt; 60s vs minute close (no usable tick in that minute) |

**Inventory note (2026-10-14):** dense NIFTY/BANKNIFTY tick minutes exist on multiple recent sessions (e.g. 2026-10-07..14). Thin days (e.g. 2026-10-05 NIFTY ~72 minutes) fail the coverage gate and are dropped, not imputed.

## 5. Frozen signal (one primary rule)

**S_premium_1m (long premium only — buy CE or PE, never short options):**

At the close of minute `t` (last tick in that minute):

1. Build 1m mid series: `mid = (bid+ask)/2` for the selected ATM contract.
2. Require at least **20** prior completed 1m mids for that contract continuous in the session.
3. **Signal UP:** `mid_t > mid_{t-1}` and `mid_t > SMA_20(mid)`. Buy **CE**.  
4. **Signal DOWN:** `mid_t < mid_{t-1}` and `mid_t < SMA_20(mid)`. Buy **PE**.  
5. At most **one** new entry per underlying per minute; skip if already in a simulated position on that underlying.

This is a **deliberately weak** directional premium rule. The question is economic viability under fees, not alpha hunting. A FAIL here does not prove “no premium strategy works”; it proves this frozen rule does not clear cost. A PASS only unlocks a separately dated Step-3 design — not live trading.

## 6. Execution and cost (premium space)

Reuse live fee machinery: `calculateTotalFees` / entry+exit from [brokerage-calculator.ts](../apps/api/src/modules/paper-trading/domain/brokerage-calculator.ts).

| Leg | Fill |
|---|---|
| Entry | **Ask** at first tick at or after signal minute end (≤60s) |
| Exit | **Bid** at first tick at or after horizon (≤60s), else timeout at last bid in horizon window |
| Horizon | **3 minutes** after entry (scalp; parent Step 3 context) |
| Stop | Exit early if bid ≤ entry_ask × (1 − 0.015) (1.5% of premium) |
| Target | Exit early if bid ≥ entry_ask × (1 + 0.025) (2.5% of premium) |
| Scenarios | (A) observed book; (B) +1 tick adverse each leg — report both; **primary** = (B) |

```
gross = (exit_fill - entry_fill) * quantity   # long premium
net   = gross - fees(entry) - fees(exit)
net_return = net / (entry_fill * quantity)    # return on premium paid
```

**Primary metric:** mean `net` (₹) and mean `net_return` under scenario (B), per underlying and pooled with Holm across two underlyings.

## 7. Sample rule and verdicts

**Judge once** when both underlyings have:

1. ≥ **10** evaluation sessions passing the coverage gate  
2. ≥ **200** resolved trades per underlying under S_premium_1m  
3. Fee model identical to production calculator (pinned by importing the TS/Python twin used in D2 or calling the same formulas)

| Verdict | When |
|---|---|
| **PASS** | Sample met; scenario (B) mean `net` &gt; 0 on **both** NIFTY50 and BANKNIFTY; day-clustered permutation one-sided α=0.05 on mean net (within underlying); Holm family α=0.05 across the two underlyings |
| **FAIL** | Sample met and either underlying has mean net ≤ 0 under (B), or permutation fails after Holm |
| **INCONCLUSIVE** | Sample unmet by **2026-12-31**, or coverage gate leaves &lt;10 sessions per underlying |

`tradingExecutionAuthorized` stays **false** on PASS. PASS only authorises writing a **Step-3 design prereg** (premium-signal bot + tick-speed exits). FAIL closes this signal family for Phase 27; a new rule needs a new document ID.

## 8. Deliverables

1. This prereg (normative).  
2. Runner: `apps/ml/run_phase27_step2_premium_measure.py` — reads ticks, applies S_premium_1m, costs with the frozen fee formulas, emits JSON under `logs/`.  
3. Human report: `docs/2026-10-14-phase27-step2-premium-measurement-result.md` (judged **FAIL** 2026-10-14).

## 9. Change control

Population, S_premium_1m, lot size, horizon, stop/target, scenarios, or verdict definitions require a **dated amendment before** scoring under the new rule.

## 10. Relation to live bots

Sniper and other option paper bots continue as they are. This study does not change their gates. Their fills already use premium ticks where available; that does **not** count as Phase 27 Step 2 clearance.
