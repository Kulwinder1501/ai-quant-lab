# FRVP rows observation protocol (`frvp-rows48-v1`)

**Date frozen:** 2026-10-13
**Status:** FROZEN. Observation only; nothing here changes whether or how a trade is taken.
**Relation to the first study:** `FRVP-MSP-P0-2026-10-12` stays closed as INCONCLUSIVE and is not reopened. This is a separate protocol with its own sample. The 2026-10-12 locked-test day is not used.
**Code:** `fixed-row-volume-profile.ts`, `volume-profile-observation.ts`, `index-futures-contracts.ts`, `ingest-index-futures-ohlcv.ts --auto`.

## 1. Why a second protocol

The first study could not reach a verdict, and the reasons were in its design, not in FRVP:

1. **The POC was often one stray bar.** The profile cut each 1-minute bar's volume evenly over every 0.05-point bin in its range, so a bar with almost no range put all its volume into one bin. BANKNIFTY 2026-10-05: the day's POC (54,950) was one zero-range 180-contract bar, 0.03% of the day's volume, 72% of its own bin. BANKNIFTY 2026-10-07: a one-point post-close bar was 57% of the POC bin. A conventional 50-row profile put the POC 300-400 points away on 10-05, 10-07 and 10-08.
2. **There were almost no nodes.** At one-tick resolution the detector found 0.29 low-volume nodes per session, so the policy selected 0 of 1,334 candidates.
3. **There were 7 sessions and a one-day test**, against a bar of 250 baseline and 100 policy trades. It could not have concluded.

The volume arithmetic of the first study was correct (volume conserved; an independent rebuild matched). What was wrong was the resolution at which nodes were defined, and the sample.

## 2. Definition

**Session.** The latest completed IST trading date before the entry's date that has at least 300 paired minutes. Prior session only; never the developing one.

**Contract.** Among `FUTURE` instruments for the underlying with expiry on or after the entry date, the one with the most volume in that session. (The first study also required two consecutive sessions of higher volume before rolling; that hysteresis is dropped. The contract is recorded in every stamp.)

**Volume from futures, price from the index.** Each minute's futures volume is placed on the *same minute's index* high-low range. The basis between futures and index is large and moves (NIFTY about 77 points, BANKNIFTY about 241, within-day range 60-140 points), so mapping futures price levels onto the index with one basis would misplace them by more than a row. Minutes where either series is missing are skipped; the share kept is recorded as `cov`.

**Rows.** 48 equal rows from the session's lowest index low to its highest index high. A bar's volume is split across the rows it overlaps in proportion to the overlap; a bar with high equal to low goes whole into the row that holds it.

**POC.** The busiest row; a tie goes to the row nearest the session VWAP (index typical price weighted by futures volume), then the lower one.

**Value area.** 70% of volume, market-profile convention: from the POC row, compare the next two rows above with the next two below, take the larger pair, repeat. `vah` is the top edge of the highest included row, `val` the bottom edge of the lowest.

**High-volume nodes (HVN).** Local maxima (a run of equal rows counts once, at its middle) holding at least 50% of the POC row's volume. The POC's own zone is included.

**Low-volume nodes (LVN).** Interior local minima holding less than 50% of the volume of the *quieter* of the two busiest sides, so a dip only counts if there is real volume both above and below it.

**Direction.** "Ahead" is above the entry for a LONG on the underlying and below it for a SHORT. Direction is the underlying thesis (`entry.underlyingDirection`), not the option's side.

**Entry price.** The trade idea's `entry_price`, the index level at the signal.

### How the constants were chosen, honestly

48 rows, 70%, 50% and 50% were set by looking at how the profile looks on the 14 session-profiles from 2026-10-01 to 2026-10-12 (4-8 nodes per session, against 0.29), not against any trade outcome. Those sessions are development data and are not part of the evaluation. The thresholds are round numbers that were not tuned further. They are frozen now.

## 3. The stamp

Appended last to `paper_trades.notes` for every bot trade at open:

```
 Observed (log-only, no effect on entry): FRVP_OBS {json}
```

Parse with `FRVP_OBS (\{.*\})$`. Fields: `v` version; `st` status; `sess` session date; `fut` contract; `e` entry; `cov` share of futures minutes kept; `pos` `INSIDE_VALUE | ABOVE_VAH | BELOW_VAL`; `poc`, `vah`, `val`; `rw` row width in points; `lvnA`, `lvnB`, `hvnA` as `[level, distance]` or null (nearest LVN ahead, nearest LVN behind, nearest HVN ahead); `open` true when the nearest LVN ahead is nearer than the nearest HVN ahead (null when there is no LVN ahead).

`st` is `OK`, or one of `NO_ENTRY_PRICE`, `NO_PRIOR_SESSION_FUTURES`, `THIN_SESSION`, `PROFILE_NOT_BUILT`. No stamp at all means the lookup threw: unknown, not unavailable.

The profile rows are not stored. `sess` and `fut` are enough to rebuild any other node definition from the stored candles.

Futures bars come from `INDEX_FUTURES_EOD` (16:08 IST, retry 09:12), which derives the next two monthly contracts per index from the date.

## 4. Hypothesis and analysis (one primary)

**H1.** AutoBot-Sniper entries with `open = true` and `lvnA` distance of at most 1R-in-index-points have higher mean net result per trade than other Sniper entries with `st = OK`.

- **R in index points:** `initial_risk_distance` on the trade.
- **Outcome per trade:** `realized_pnl / ((entry_price - initial_stop_loss) * quantity)`, net of fees (the lab's `realized_pnl` already is).
- **Test:** difference in means, one-sided, by permuting the flag *within each session day* (10,000 permutations), because trades on one day share a market. A day-clustered bootstrap gives the interval. alpha = 0.05.
- **Sample rule:** judge once, when at least 150 closed Sniper trades with `st = OK` exist and at least 30 of them are flagged. Before that, interim counts only, no p-values.
- **Replication:** the same test on AutoBot-Scalp1m stamped trades, reported alongside, not pooled.

**Secondary (descriptive, never a basis for promotion):** result by `pos`; result by distance from POC; HVN ahead within 1R against the rest; the stamp's coverage by session.

## 5. Decisions

- **PASS:** H1 significant at 0.05 *and* the Scalp1m replication has the same sign. It authorises a separately dated protocol for a shadow or A/B filter. It does not turn on a live filter.
- **FAIL:** the test is powered (sample rule met) and the flagged group is not better. FRVP-as-LVN-corridor is closed for this strategy.
- **INCONCLUSIVE:** the sample rule is not met by 2026-12-31, or coverage of `st = OK` is under 70%. It is not a licence to retune.

Whatever the outcome, no live entry, stop, size or score changes from this protocol.

## 6. Known limits

- Only trades that opened are stamped, so this conditions on the bot having taken them.
- The profile is the prior session only. A developing-session profile is out of scope.
- 1-minute bars; futures volume on index price rather than traded futures price.
- Sniper's recent trade rate (10 on 2026-10-13) is not a forecast. If it falls to 1-2 a day the sample rule takes months, and the answer is to wait or to count Scalp1m, not to loosen the rule.
- Entries before the first stamped trade are not in the sample. They could be reconstructed from candles for a descriptive look, not for H1.

## 7. Change control

A change to the profile definition, the constants, H1, the sample rule or the decision rules needs a dated amendment before the affected outcomes are looked at. Adding stamped fields is allowed; removing or redefining one is an amendment.

## 8. Review query

```sql
SELECT t.id, a.name, t.opened_at, t.realized_pnl,
       (substring(t.notes from 'FRVP_OBS (\{.*\})$'))::jsonb AS frvp,
       t.initial_risk_distance, t.entry_price, t.initial_stop_loss, t.quantity
  FROM paper_trades t JOIN paper_accounts a ON a.id = t.account_id
 WHERE t.notes LIKE '%FRVP_OBS%' AND t.status = 'CLOSED';
```
