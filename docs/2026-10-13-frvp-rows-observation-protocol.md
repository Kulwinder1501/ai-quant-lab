# FRVP rows observation protocol (`frvp-rows48-v1`)

**Date frozen:** 2026-10-13
**Status:** FROZEN. Observation only; nothing here changes whether or how a trade is taken. **Amended 2026-10-13 (Amendment 1, at the end), before any trade was stamped.**
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

---

## Amendment 1 (2026-10-13, before any stamped trade): shapes, today's developing profile, and the shape hypothesis

**Why.** The trader this is for draws a fixed-range profile from a day's high to its low, reads its *shape* (P, b, D), and does the same on the current day from the open to now, on 5-minute charts. Section 2 measured only yesterday's levels. No trade has been stamped yet (the stamp has only existed since the evening of 2026-10-13, after the session), so this amendment cannot have been shaped by an outcome.

**Supersedes:** the stamp format in section 3 (now `frvp-rows48-v2`; v1 never stamped a trade) and where H1 reads its fields. Sections 2, 4 (H1's test), 5, 6 and 7 stand unless restated here.

### A1.1 Two profiles per entry

| Block | Range | Built from | Role |
|---|---|---|---|
| `d1` | the prior completed session, day high to day low | all of that session's paired minutes | the levels the market arrives at |
| `d0` | today, open to the last minute that had closed | paired minutes of today so far, rebuilt at each entry | what is forming now |

Drawing a profile bottom-to-top or top-to-bottom gives the same profile; direction matters only for what is read from it. Each block has its own `st`, level read-out and shape. Decisions are at 5-minute bar closes, as the strategies already are; the profile is built from 1-minute volume, the finest the data allows, so a 5-minute bar is never smeared over its range.

`d0` is not read before 30 paired minutes exist (`TOO_EARLY`): a shape on a few bars is noise. Its `asof` is the open time of the last minute actually used, which can trail the clock by a minute or two.

### A1.2 Shapes: what the sources say, and the numbers this lab uses

**What was read.** NinjaTrader's guide to the four common shapes; LuxAlgo's profile shape taxonomy; MarketCalls' market-profile day types (an Indian-market source); Traders Second Brain's profile guide; and a TradingView open-source shape detector, read in full. NexusFi's shape page refused the fetch, so only its search-result summary was used. Sources: [NinjaTrader](https://ninjatrader.com/futures/blogs/trade-futures-understanding-the-4-common-volume-profile-shapes/), [LuxAlgo](https://www.luxalgo.com/library/concept/profile-shape-taxonomy.md), [MarketCalls](https://www.marketcalls.in/market-profile/market-profile-different-types-of-profile-days.html), [Traders Second Brain](https://traderssecondbrain.com/guides/volume-profile-analysis), [TradingView detector](https://in.tradingview.com/script/NNkzKfmR-Simple-VP-Shape-Detector/), [NexusFi](https://nexusfi.com/a/concepts/profile-shapes).

**What they agree on (paraphrased).**

- **P:** the larger concentration of volume sits in the upper part of the range with a thin tail below. A fast move up, then acceptance higher. Usually read as bullish; also seen at the end of a downtrend as a short-covering rally, which several sources warn is often temporary. MarketCalls adds that a P at the top can raise the chance of a reversal.
- **b:** the mirror: concentration low, thin tail above. Long liquidation; usually read as bearish.
- **D:** one symmetric concentration in the middle with tapering tails. Balance.
- **Double distribution:** two separated concentrations with a thin neck between them (MarketCalls: single prints; Traders Second Brain: "multi-distribution"). NinjaTrader calls it **B** and describes it as two D profiles in one period, usually trend continuation. The TradingView detector uses "B" for something different (seller-dominant), so a letter alone is not a definition.
- **Caveats the sources themselves give:** shapes are practitioner shorthand, not forecasts; they are clean only in hindsight and change as the day builds; a P or b can sit inside a bigger trend or reverse; and shape alone does not say whether buyers or sellers were the aggressors.

**What none of them give: a number.** Not for "upper", "thin", "fat", or how deep a neck must be. Traders Second Brain says what to do about that: fix the rule before the session, freeze the completed profile, and treat a shape that changes when the row count changes as not stable enough to test. This amendment does the first two and records the third.

**Rules used here (the lab's, written before any outcome):**

- **B (double distribution), tested first:** a second hump at least a quarter of the range (12 of 48 rows) from the POC, holding at least 60% of the POC row's volume, with a neck between them under 40% of that second hump, the neck centred in the middle band (25-75%) of the range.
- **P:** POC in the upper third of the range. **b:** POC in the lower third. **D:** POC in the middle third.
- **Stability (`stb`):** true when the same shape results at 24, 32, 48 and 64 rows.

**Rejected on the way, and why.** (1) Calling any dip with a node on each side a B labelled 6 of 14 sessions B, including clear P and b days. (2) Reading P, b and D from the volume-weighted centre rather than the POC row called nearly every day D, including days that are plainly top- or bottom-heavy when drawn. Both were judged by drawing the 14 development sessions (2026-10-01 to 10-12), not by any trade outcome. The volume centre is still recorded (`cp`).

**Provisional.** The trader is the authority on what the shapes look like. The 14 profiles were drawn and sent for labelling. If their calls differ from these rules, the numbers are recalibrated to their labels by a dated amendment, which is allowed any time before an outcome is examined and never after. `pp` and `cp` are stamped, and the rest can be rebuilt from stored candles, so no stamped trade is lost to a recalibration.

"Where liquidity left" is read as the low-volume nodes, the existing `lvnA` and `lvnB`. A thin or trend profile ("I") is not classified; add it by amendment if it is used.

### A1.3 Volume source, and why index volume is not used

Futures volume only. Index volume was tested as a stand-in for the developing profile and rejected: over 16 session-profiles (NIFTY and BANKNIFTY, 2026-10-01 to 10-13) the minute-by-minute correlation with futures volume was 0.38 and the two classified the same shape in 7 of 16, about what chance would give. `d0` therefore needs today's futures bars in the database during the session, which `INDEX_FUTURES_INTRADAY` (every five minutes, :04) tries to supply from the history endpoint. It is not known whether that endpoint publishes same-day 1-minute futures bars mid-session (the existing code says the index series needed the live collector for that reason). If it does not, `d0` is `NO_TODAY_FUTURES`, which is itself the answer.

**Pre-registered fallback.** If fewer than half of stamped entries have `d0.st = OK` by 2026-10-31, H2 is tested on `d1` instead, and a live futures feed for `d0` becomes a separate piece of work with its own amendment.

### A1.4 Stamp v2

```
FRVP_OBS {"v":"frvp-rows48-v2","e":<entry>,"fut":"<contract>","d1":{...},"d0":{...}}
```

Each block: `st` (`OK`, `THIN_SESSION`, `PROFILE_NOT_BUILT`, `NO_PRIOR_SESSION_FUTURES`, `NO_TODAY_FUTURES`, `TOO_EARLY`); `sess`, `n`, `cov` (d1) or `n`, `asof` (d0); `sh` shape; `stb` shape stable across 24/32/48/64 rows; `pp` POC position in the range; `cp` volume-centre position; `pos` against the value area; `poc`, `vah`, `val`; `hi`, `lo` (the range); `rw`; `lvnA`, `lvnB`, `hvnA` as `[level, distance]`; `open`. A top-level `st` appears only for `NO_ENTRY_PRICE`.

### A1.5 Hypotheses (family of two, Holm-corrected)

**H1 (restated).** Unchanged, read from `d1`: Sniper entries with `d1.open = true` and `d1.lvnA` distance of at most 1R-in-index-points do better than other Sniper entries with `d1.st = OK`.

**H2 (the trader's method).** On `d0`, entries whose direction agrees with the shape's lean -- LONG when `d0.sh = P`, SHORT when `d0.sh = b` -- have a different mean result per trade than entries that go against it (LONG on b, SHORT on P). `D` and `B` entries are excluded from H2 and reported separately.

- **Two-sided,** because the lore is contested. Several sources read P as bullish (a fast move up, then acceptance); others read the same shape as a short-covering rally that is temporary and can be faded. A one-sided test would bake one reading in. The sign of the difference is the finding.
- **Outcome, test, clustering:** exactly as H1 (section 4): result per trade divided by planned risk, permutation of the label within each session day, day-clustered bootstrap interval.
- **Sample rule:** judge once, when at least 150 closed Sniper trades with `d0.st = OK` and a P or b shape exist, with at least 30 in each of agree and against. Interim counts only until then.
- **Replication:** the same test on AutoBot-Scalp1m, reported alongside, not pooled.
- **Correction:** H1 and H2 are judged together with Holm at family alpha 0.05. Neither is judged before its own sample rule is met.

**Secondary (descriptive only):** result by shape and direction for `d0` and `d1`; `d1` shape agreeing with `d0` shape; result by `pos`; distance from the POC.

### A1.6 Decisions

Section 5 applies to each hypothesis separately. A PASS on H2 authorises a separately dated protocol for a *shadow* filter on the shape, not a live one. A result on `d1` is never used to rescue a failed `d0` read.

### A1.7 Known limits added

- `d0` is built from a poll, so it can miss the last minute or two; the stamp says which minute it used.
- A shape on a developing profile changes as the day builds, and the sources themselves say it is only clean in hindsight. Recording the shape *at the moment of entry* is what makes H2 honest about this.
- The 5-minute chart the trader reads is not the resolution of the profile (1-minute volume); the decision times are 5-minute closes.
