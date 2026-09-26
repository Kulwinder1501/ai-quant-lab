# ICT entry model — wide replication program v2

**Registered 2026-09-08, before any measurement on any instrument beyond the two indices.**
Nothing below may be revised after a result is seen; a design error gets a dated amendment and the
affected run is discarded, not re-scored. Supersedes nothing — v1
(`2026-09-08-ict-entry-model-falsification-program.md`) stands as recorded, and this program exists
because v1's verdict was **power-bound**, not because its answer is being appealed.

## What v1 established, and why widening is the only remaining lever

v1 returned NO_VIABLE_ENTRY_MODEL. Best arm: pooled t = 0.58 against a Bonferroni-corrected
threshold of 2.50. The reason was not that the effects were absent — `killzone` and `ote` were
positive on both instruments — but that the cell could not resolve them:

> Pooled SE ±97 per trade on 65 clustered sessions. Resolution floor ≈ ±195 per trade. The 2025 era
> on two indices yields 65 clustered sessions and that is the ceiling.

More features cannot move that number. More instruments can. This program does only that: it holds
the features fixed and widens the replication set.

## Feasibility, established before registering (data facts, not results)

Checked 2026-09-08. Only **nine** instruments carry 15m candles back to 2025-01-01. Every other
symbol in the universe starts 2026-06-08 with ~48 sessions — the silent-truncation pattern that has
bitten this repo before, and the reason this program is nine instruments and not twenty.

Seven of the nine have **zero** indicator snapshots at 15m. That turned out not to matter: a
FINNIFTY run produced 3,655 contexts, 127 signals and 64 trades, because the ICT engine derives
everything from causal candles and never reads an indicator. Verified rather than assumed, since
indicator coverage has silently blocked training here before.

**Common window.** The nine do not end on the same date (2026-08-04, 2026-08-07, 2026-09-08). All
runs therefore use a window every instrument covers: training **2025-01-01 .. 2025-12-31**, holdout
**2026-01-01 .. 2026-08-04**. No instrument gets a longer window than another.

## Instruments, grouped by exposure

Nine symbols are not nine replications. Several are near-duplicates, and pretending otherwise would
manufacture significance out of the same price series counted twice.

| group | members | note |
|---|---|---|
| NIFTY | NIFTY50, NIFTYBEES | NIFTYBEES is an ETF tracking NIFTY50. Not an independent draw. |
| BANK | BANKNIFTY, FINNIFTY | Heavy constituent overlap. Not an independent draw. |
| MIDCAP | MIDCPNIFTY | Distinct exposure. |
| NEXT50 | NIFTYNXT50 | Distinct exposure. |
| AXISBANK | AXISBANK | Single name, and a BANKNIFTY constituent — related to the BANK group. |
| ASIANPAINT | ASIANPAINT | Single name, unrelated sector. |
| BAJFINANCE | BAJFINANCE | Single name, financials. |

**Seven exposure groups.** A group's estimate is the unweighted mean of its members' per-instrument
mean-P&L-per-trade. Group signs, not instrument signs, are what the primary test counts.

## Arms

Two, plus control. **Held fixed from v1 — no new features.**

1. `{}` — control
2. `{"requireKillzone": true}`
3. `{"requireOte": true}`

`poiPreference` is **excluded**: v1's Amendment 2 established it is a structural no-op (the chosen
POI sets evidence fields only; entry, stop and target never consult it), and re-running a known
no-op would spend multiplicity for nothing.

The **combination** `{killzone + ote}` is deliberately NOT tested. It would be a fourth
configuration, and the doctrine's stacking claim deserves its own registration rather than a free
ride on this one.

**Configurations evaluated: 3.** Fixed now, so the multiplicity correction is fixed now.

## Estimator

Unit of analysis is the trade. Per instrument: trade count, session count, mean P&L per trade, and
its SE clustered on IST session date. Pooled figures cluster on session date **across** instruments,
because the nine on the same calendar day are not independent.

## Decision rule

**Primary test — group sign test.** For an arm to pass, its mean-P&L-per-trade must exceed the
control's in at least **6 of the 7** exposure groups. Under the null of no effect, the probability of
6 or more of 7 improving by chance is `8/128 = 0.0625`; of 7 of 7, `1/128 = 0.0078`. With three
configurations the Bonferroni-corrected α is 0.0167, so:

- **7 of 7 passes** (p = 0.0078 < 0.0167).
- **6 of 7 does not** (p = 0.0625 > 0.0167) and is recorded as suggestive, not as a pass.

This is the primary test precisely because it does not depend on the standard error that bound v1.
It is also the test that killed the HTF-confluence veto, which won on two ETFs and then made 14 of
20 equities worse.

**Supporting gates**, all required alongside the primary test:

- **Pooled noise floor.** Pooled t > 2.0, session-date-clustered, Bonferroni-corrected to t ≈ 2.39
  for three configurations. Reported whether or not it passes — if the primary test passes and this
  fails, the verdict is UNDERPOWERED_BUT_CONSISTENT, which is **not** a promotion.
- **Paired within-run delta.** For `killzone`, replicated per instrument: split each control run's
  own trades by whether the signal bar (entry bar minus one 15m candle) fell inside a window, and
  compare. This avoids the concurrency and capital confounds entirely, and is the cleanest evidence
  available. It must agree in sign with the arm in at least 6 of 7 groups.
- **Population retention.** An arm that cuts trade count by more than half in any group is reported
  ambiguous for that group, and that group counts as a failure for the primary test.
- **Era holdout.** Only an arm that passes everything above on training is run on
  2026-01-01 .. 2026-08-04, **once**, where it must again pass the group sign test at 6 of 7 or
  better. A second look voids the arm.

### The holdout is spent here

v1 never consulted its 2026 holdout, so the era is still clean. This program spends it. After this,
**the 2026 era is burned for ICT entry-model questions** and any further work needs genuinely new
data — not a re-slice of the same window. Recorded so that nobody later mistakes a third look for a
fresh test.

## Pre-committed threats to validity

- **NIFTYBEES ≈ NIFTY50 and FINNIFTY ≈ BANKNIFTY.** Handled by grouping, but the grouping is a
  judgement, not a measurement. Per-instrument numbers are reported alongside group numbers so a
  reader can regroup.
- **AXISBANK is a BANKNIFTY constituent**, so the AXISBANK group is not fully independent of the
  BANK group. It is kept separate because a single name behaves differently from its index, and this
  is recorded as a known dependency rather than corrected away.
- **ICT is doctrine for FX and indices.** Applying it to three single stocks is itself an
  assumption. A result that holds on indices and fails on stocks is a legitimate outcome and must not
  be reported as a partial success.
- **Single stocks carry corporate actions.** Splits and bonuses are not handled by this replay path;
  a discontinuity will read as a large move. Any group whose result is driven by one session is
  flagged.
- **Seven groups is still a small replication set**, and the sign test's resolution is coarse — it
  cannot distinguish a small consistent effect from a large one. A pass licenses further work, never
  a promotion to live.
- **Clustering on session date across instruments is conservative** for single stocks, whose
  idiosyncratic moves are not shared. This biases the pooled t downward, which is the direction to
  err in.

## Stopping condition

If no arm passes the group sign test at 7 of 7, the verdict is **NO_REPLICATED_ENTRY_EDGE** and
`ict-structure-v1` stays `TERMINAL_UNOWNED` permanently for this line of work. The features remain
behind their default-off switches with both programs' measurements attached, and the honest summary
becomes: the ICT entry model was tested on nine instruments across two eras with the rule fixed in
advance, and it did not replicate.

## Results — training era, all nine instruments

2025-01-01 .. 2025-12-31, 15m, concurrency 5, 5,000,000 capital, 2bps. Mean P&L per trade.

| instrument | control | killzone | ote |
|---|---|---|---|
| NIFTY50 | +97.61 (91) | +126.16 (79) | +101.79 (62) |
| NIFTYBEES | -1.92 (109) | -2.01 (96) | -2.29 (72) |
| BANKNIFTY | -30.11 (121) | +8.70 (99) | +77.30 (62) |
| FINNIFTY | -56.02 (105) | -55.73 (88) | -0.78 (55) |
| MIDCPNIFTY | -1.03 (140) | -28.25 (114) | -36.51 (84) |
| NIFTYNXT50 | -171.97 (92) | -182.55 (86) | -202.22 (57) |
| AXISBANK | +2.55 (114) | +4.00 (104) | +6.96 (79) |
| ASIANPAINT | -10.82 (151) | -14.62 (125) | -15.94 (90) |
| BAJFINANCE | -0.85 (167) | -2.06 (137) | -6.40 (101) |

### Primary test — group sign test

| group | control | killzone | ote | kz > ctl | ote > ctl |
|---|---|---|---|---|---|
| NIFTY | +47.84 | +62.07 | +49.75 | yes | yes |
| BANK | -43.06 | -23.52 | +38.26 | yes | yes |
| MIDCAP | -1.03 | -28.25 | -36.51 | no | no |
| NEXT50 | -171.97 | -182.55 | -202.22 | no | no |
| AXISBANK | +2.55 | +4.00 | +6.96 | yes | yes |
| ASIANPAINT | -10.82 | -14.62 | -15.94 | no | no |
| BAJFINANCE | -0.85 | -2.06 | -6.40 | no | no |

**killzone: 3 of 7. ote: 3 of 7.** Both **FAIL**, and not marginally — 3 of 7 is below the 3.5 groups
chance alone would deliver. Seven of seven was required to pass.

The failure has the exact shape the registration warned about. Both arms win on the NIFTY group, the
BANK group and AXISBANK, and lose on all four others. Those first two groups are the two indices v1
measured. This is the HTF-confluence pattern reproduced precisely: monotone on the cell it was
selected on, worse everywhere else.

Note also that **control is negative in 5 of 7 groups**, NIFTYNXT50 at -171.97 per trade. The
strategy is broadly loss-making and the two indices v1 happened to use were its favourable draw.

### Pooled — and the power question, answered

Clustered on session date across all nine instruments:

| arm | trades | clusters | mean | SE | t |
|---|---|---|---|---|---|
| control | 1,090 | 183 | **-16.79** | 30.72 | -0.55 |
| killzone | 928 | 174 | -16.04 | 31.13 | -0.52 |
| ote | 662 | 156 | -7.90 | 34.87 | -0.23 |

**Widening did what it was supposed to do.** Clusters 65 -> 183, and SE +-97 -> **+-30.72**, a 3.2x
improvement. The resolution floor falls from roughly +-195 per trade to about +-61.

And with that power the answer is no longer "unresolved" — it is negative. v1's pooled control mean
of +24.71 on two indices becomes **-16.79** on nine. The favourable draw was the sample, not the
strategy.

Internal consistency check: v2's control on BANKNIFTY and NIFTY50 reproduces v1's numbers to the
digit (-30.11 and +97.61), so the two programs are measuring the same thing.

### Verdict

**NO_REPLICATED_ENTRY_EDGE.**

**The 2026 holdout was NOT spent.** The registration anticipated spending it, but the gate admits
only an arm that passes training, and neither did. So the era remains clean and available. This is
the ordering doing its job: had the holdout been run alongside the training era rather than behind
it, it would have been burned for nothing.

`ict-structure-v1` stays `TERMINAL_UNOWNED`, now on the strongest available evidence rather than on
an underpowered null: nine instruments, seven exposure groups, rule fixed in advance, and the entry
model did not replicate.
