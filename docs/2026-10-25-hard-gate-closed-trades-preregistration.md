# Do the checklist's hard rules separate good paper trades from bad ones? Pre-registered test (DRAFT until committed)

Status: written 2026-10-25, before any outcome was computed for this question. It binds when committed.

## Question

The "Before you buy" checklist and the OQG-1 proposal both say to reject some trades outright. If those rejections were applied to the 582 closed paper trades of the four AutoBots, would the rejected trades have been worse than the rest, by more than skipping the same number of trades at random?

## Disclosure: this is not an out-of-sample test

The stop-outside-normal-noise idea came from reviewing these same closed trades on 2026-10-25 (the trades with the smallest rupee risk lost most per unit of risk, even before charges). A pass here is therefore weak evidence. Two things limit the damage: the rule and its cutoffs (0.5× and 1×) were written into the checklist before this test and are not changed here, and the same script is committed to be **re-run on trades closed after 2026-10-25**, once at least 150 of them exist, with the result reported whatever it shows.

## Data (read-only)

`paper_trades` with `status = 'CLOSED'`, accounts `AutoBot-Sniper`, `AutoBot-Classic`, `AutoBot-Scalp1m`, `AutoBot`, not `excluded_from_evidence`: 582 trades, 2026-08-17 to 2026-10-23. All have the delta, implied volatility, underlying entry price, expiry, target and stop stored at entry (checked for coverage only, not outcomes).

- Planned risk (rupees) = |entry price − initial stop| × quantity.
- **Net R** = `realized_pnl` (already net of charges) ÷ planned risk. Gross R = (`realized_pnl` + `fees`) ÷ planned risk.
- The spread rule cannot be tested: the bid and ask are not stored per trade, only the ask paid. It is left out and said to be untested.

## The rules, applied as they would have been at entry

1. **Stop outside normal noise** (the checklist's rule). Stop in index points = (entry price − initial stop) ÷ |delta|. Typical day = 0.7979 × S × IV × mean(1/√365, 1/√252), with S the underlying at entry and IV the stored entry IV (the middle of the implied-move panel's daily band). Typical move over the hold = typical day × √(min(1, 15/375)): a **15-minute hold**, fixed in advance (the bots' median holds are 5 to 13 minutes). Ratio = stop points ÷ typical move. **Fails** if the ratio is below 0.5.
2. **Expiry-day entry** (from the proposal): the IST date of entry equals the IST date of the option's expiry.
3. **Reward too small for the charges** (from the proposal): planned reward ((target − entry) × quantity) is below 2.5× the round-trip charges. Charges are estimated ex ante from a line fitted to all 582 trades: 47.2 + 0.1847% of the entry premium cost (R² 0.98).
4. **Delta outside 0.45–0.65** in absolute value (from the proposal).

## Hypotheses

- **H-A (primary):** trades that fail rule 1 have a lower mean net R than the other trades.
- **H-B (secondary):** trades that fail **any** of rules 1 to 4 have a lower mean net R than trades that fail none.
- Holm correction across H-A and H-B. The per-rule results for 2, 3 and 4 are reported for information only and carry no claim.

## Statistic and pass rule

Statistic: mean net R of the trades the rule would keep **minus** mean net R of the trades it would skip (positive means the rule helps).

- Day-clustered bootstrap (resample trading days, 4,000 draws), 95% interval.
- Permutation: shuffle the skip labels among the trades of the same bot (so the number skipped per bot is unchanged), 10,000 shuffles, one-sided p.
- **A hypothesis passes only if** the interval's lower end is above zero **and** the Holm-adjusted p < 0.05 **and** at least 40 trades are skipped (otherwise "not assessable") **and** the sign agrees in the first and the second half of the trades by date.

## Reported with every result, no pass/fail

Skipped and kept counts per bot; gross R of both groups (to separate charges from the stop effect); the rupee P&L the rule would have changed; the **absolute** net R of the kept group with its interval. A gate that only removes the worst trades from a set that still loses money has not made a strategy: if the kept group's net R is below zero that is stated plainly.

## Sensitivity (cannot rescue a failure)

Hold of 5 and 30 minutes for rule 1; skipping when the ratio is below 1 instead of 0.5; the Sniper bot alone.

## Power (stated now)

About 580 trades on about 70 days. If 25–35% are skipped, the standard error of the difference is about 0.09R, so only a difference of roughly 0.25R or more can be separated from noise. A pass needs a large effect; a failure means "no large effect".

## Failure handling and next step

A failure is recorded, and the rule stays in the checklist labelled as an untested rule of thumb (as it already is). A pass moves it from "rule of thumb" to "supported on past paper trades, not yet out of sample" and triggers the committed re-run on trades after 2026-10-25. Nothing here supports live trading; any live use needs the usual human review.

## Known limits

- Bots chose their own strikes and stops, so the stop-distance variation is partly a bot design difference; the within-bot permutation controls the bot mix but not the geometry within a bot.
- Trades are clustered by day; the day bootstrap handles this, the permutation does not.
- NIFTY lot size is 65 in reality but older records used 75; R is unaffected, rupee amounts are about 15% high for those trades.
- The hold used for rule 1 is a fixed 15 minutes, not each trade's own, because the planned hold was never recorded.
