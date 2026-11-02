# Daily levels sheet and its reaction history (protocol written before any result)

Status: written 2026-11-02, before the study was run. Parameters below are fixed now and are not tuned afterwards.

## 1. What this is

A pre-open sheet for NIFTY50 and BANKNIFTY listing the price levels traders commonly watch, grouped into zones where several
sources agree, shown on a dashboard page and sent as a morning message. Every number is computed from stored data. No language
model supplies a price.

It is **context, not a signal**. It does not say price will bounce, and it does not feed any bot. The page also shows how these
levels behaved in our own history against random lines, so a reader can see whether they deserve any weight.

## 2. Level sources (the sheet)

| Family | Levels | Built from |
|---|---|---|
| `PRIOR_DAY` | previous day high, low, close | last completed daily bar |
| `PIVOT` | classic pivot P, R1-R3, S1-S3 | last completed daily bar |
| `RANGE_5D` | 5-session high and low | last 5 completed daily bars |
| `RANGE_WEEK` | previous calendar week high and low | completed daily bars of the previous ISO week |
| `ROUND_NUMBER` | the nearest two multiples of the round step above and below the reference price (NIFTY50 100, BANKNIFTY 500) | reference price |
| `OI_WALL` | highest call open interest strike above the reference price and highest put open interest strike below it, nearest expiry | last option-chain observation before 08:50 IST |

Reference price: the last completed daily close before the session date. Point in time: nothing observed on or after the session date
is used. Volume-profile levels are left out of this version: index volume is estimated (see the volume-profile notes), so they are
not a computed fact.

Zones: levels are sorted by price and grouped greedily; a group starts at its lowest level and takes every level within 0.10% of
that price. A zone's **confluence** is the number of distinct families in it, not the number of lines (a pivot and the previous high
come from the same bar, so two lines from one bar are not independent confirmation, and the sheet says so).

## 3. Reaction study (the honesty column)

Question: do these levels behave differently from arbitrary lines? Only families computable from daily bars are tested
(`PRIOR_DAY`, `PIVOT`, `RANGE_5D`, `RANGE_WEEK`, `ROUND_NUMBER`), because open-interest history is too short (since 2026-08-04).

- **Data:** 15-minute bars of NIFTY50 and BANKNIFTY, regular session 09:15-15:30 IST, every stored session from 2023-01-02 to the last complete session before the run.
- **Levels:** built for each session from daily bars strictly before it, exactly as in section 2.
- **Touch:** the first bar of the session whose low-high range comes within 0.05% of the level. The test side is set by the previous bar's close (the first bar uses the previous session's last close): below the level it is a **resistance test**, above it a **support test**. A level is touched at most once per session.
- **Outcome**, from the bars after the touch bar, first passage: **BOUNCE** if price moves 0.25% away from the level on the rejection side before it moves 0.25% through the level; **BREAK** the other way; **UNRESOLVED** if neither happens by 8 bars (two hours) or the session end, or both happen inside one bar.
- **Placebo:** for every real level, four lines at offsets of -0.50%, -0.35%, +0.35% and +0.50% from it, dropped if within 0.15% of any real level that session, run through the identical procedure.
- **Statistic:** BOUNCE share among resolved touches, per family and for all real levels, against the pooled placebo. The difference (real minus placebo) gets a day-clustered bootstrap 95% interval (resample sessions with replacement, 5,000 draws, seed 20261102).
- **Descriptive only:** confluence 2 or more against 1, and each instrument separately.

The page prints each number with its interval and a plain sentence ("no demonstrated difference from random lines" when the interval
contains zero). No result changes how the sheet is built, and the families are not pruned or re-weighted afterwards; a different
definition would be a new protocol.

## 4. What the result does

Nothing in trading. It sets the wording on the page and in the morning message.

## 5. Known limits

- 15-minute bars: a touch and a reversal inside one bar are not seen. The 0.05% band and 0.25% move are chosen for 15-minute resolution and are not optimised.
- Levels that traders really act on also include discretionary ones (chart swings, trendlines) that this sheet does not contain.
- Open-interest walls cannot be backtested, so the sheet shows them without a history column.
- A bounce share near 50% for real and placebo lines is the expected result if levels carry no information; a small difference would need years of data to confirm.
