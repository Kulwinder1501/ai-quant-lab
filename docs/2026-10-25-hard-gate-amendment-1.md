# Amendment 1: forward re-run of the stop-outside-normal-noise test

Amends `docs/2026-10-25-hard-gate-closed-trades-preregistration.md` (commit `ccc10b9e`) for the **forward re-run only**. Written 2026-10-25, before any trade opened on or after 2026-10-26 exists (checked: 0 trades). It binds when committed. The original test and its recorded result are not changed.

## Why this amendment exists

The original test passed as written (kept minus skipped +0.47R, Holm p ≈ 0) but the follow-up checks, run afterwards and labelled post-hoc, showed the pass does not hold up:

- Rupee P&L gained by skipping the flagged trades was Rs 29.4k against Rs 26.9k for skipping the same number at random within each bot (p = 0.39).
- Win rate kept minus skipped was +6.4 points (p = 0.13).
- 168 of the 170 flagged trades sat in the highest fee-to-risk third of trades; controlling for fee-to-risk the stop rule's coefficient was −0.18R, 95% interval [−0.58, +0.17].
- The statistic chosen in the original (net R) divides each result by the rupees risked at the stop, so any rule that picks small-risk trades looks good because fixed charges and the spread weigh more on them. That was a weak choice of statistic.
- H-B ("any hard rule") was the stop rule plus rules that never triggered or had no effect; it was not independent evidence and is dropped.
- The original's power note said "about 70 days"; the data cover 40 trading days.

## Unchanged

The rule itself: stop distance in index points = (entry price − initial stop) ÷ |delta|; typical move over a **15-minute hold** = 0.7979 × S × IV × mean(1/√365, 1/√252) × √(15/375); **fails if the ratio is below 0.5**. The charges line is fixed at 47.2 + 0.1847% of the entry premium cost and is **not refitted**. Same four accounts, same exclusions (`excluded_from_evidence`, cancelled orders).

## Changed

1. **One hypothesis**, not two: trades that fail the stop rule do worse than the others.
2. **Population:** paper trades opened on or after **2026-10-26 00:00 IST**. Evaluated **once**, on the **first 150 trades by opening time**, after all 150 have closed. If fewer than 40 of them fail the rule, the result is "not assessable". Later trades are reported descriptively and cannot change the verdict.
3. **Three co-primary metrics, all of which must hold** (so no multiplicity correction is needed; the cost is lower power):
   - **M1, rupees:** the rupee P&L gained by skipping the flagged trades must beat skipping the same number at random within each bot (10,000 shuffles), one-sided p < 0.05.
   - **M2, win rate:** win rate of the kept trades minus the flagged trades must be positive, p < 0.05 by the same within-bot shuffle.
   - **M3, controlling for charges:** in net R ~ (fails the rule) + (estimated charges ÷ planned risk), the coefficient on "fails the rule" must be negative with the upper end of its day-clustered bootstrap 95% interval (2,000 draws) below zero. This is the test of whether the rule carries anything beyond the cost-over-small-risk channel.
   - **Halves:** the sign must agree in the first and second half by opening time for M1 (flagged trades earn less than the average trade) and for M3 (coefficient negative).
4. **Net R kept-minus-skipped** (the original statistic) is still printed but can no longer pass anything.
5. **Descriptive only, no claim:** the same three metrics excluding `AutoBot-Scalp1m`. On the historical data that subgroup looked more favourable (win rate p = 0.03; M3 −0.39R, interval [−0.94, −0.06]). That was a single look taken after the main result, in a subgroup chosen after seeing it, and it does not change the primary population or the pass rule.

## The code is frozen

`docs/research-scripts/2026-10-25-hard-gate-forward-rerun.py` is committed with this amendment and is not edited afterwards (a change is a new amendment). Checked for reproduction, not new analysis: run on the 582 historical trades it gives M1 Rs 29,364 vs Rs 26,888 (p 0.377), M2 +0.064 (p 0.121), M3 −0.179R with interval [−0.578, +0.195], matching the earlier post-hoc figures up to random-shuffle noise, and the verdict FAIL.

Export (run it, save the CSV, then `python -I <script> trades.csv`):

```sql
select a.name acct, t.id, t.status, t.excluded_from_evidence::int excluded_from_evidence, t.opened_at,
       t.quantity, t.entry_price, t.initial_stop_loss, t.realized_pnl, t.fees,
       t.underlying_entry_price ue, t.entry_iv iv, (t.fee_breakdown->'option'->'greeks'->>'delta')::numeric delta
from paper_trades t join paper_accounts a on a.id = t.account_id
where a.name in ('AutoBot-Sniper','AutoBot-Classic','AutoBot-Scalp1m','AutoBot')
  and t.opened_at >= '2026-10-26 00:00:00+05:30'
order by t.opened_at;
```

## Power (stated now)

150 trades, perhaps 30–45 of them flagged. The standard error of the net R difference is about 0.2R, so only large effects (roughly 0.5R or more) can be separated from noise, and requiring three metrics to hold lowers the chance of a pass further. A failure therefore means "not shown", not "shown not to work". Expected pace: Sniper alone produces about 9 trades a day, so 150 trades is roughly three weeks.

## What each outcome does

- **Pass:** the checklist labels the rule "supported on forward paper trades (150 trades), not a guarantee". Still not a basis for live trading.
- **Fail or not assessable:** the rule stays labelled an untested rule of thumb. No re-tuning (hold, cutoff, window) on these trades; a different rule is a new pre-registration. The stop-noise check may then be demoted from a pass/fail line to an information line, a decision for the operator.

## Known limits

- The flagged trades are concentrated in particular bots (about 65% of Scalp1m, 39% of Classic, 10% of Sniper historically); the within-bot shuffle controls the mix but not the stop geometry within a bot. Classic has stopped trading, so the forward sample is mostly Sniper and Scalp1m v9 (whose 8-point stop will mostly fail the rule by design).
- Trades cluster by day; the bootstrap for M3 handles this, the permutation tests for M1 and M2 do not.
- The hold is a fixed 15 minutes because the planned hold is not recorded.
- Charges, fills and quotes are paper-trading estimates, not real-broker fills.
- This is a test of a paper strategy, not a trading recommendation; any live use needs the usual human review.
