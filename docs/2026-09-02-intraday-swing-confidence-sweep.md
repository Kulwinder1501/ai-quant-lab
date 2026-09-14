# 2026-09-02 — Can the intraday/swing rule earn its own evidence?

**Written 2026-09-02.** Every figure was measured that day by replaying stored bars through
`measure:strategy-tier`, with the command given so it can be re-run rather than trusted. The gate was
**pre-registered before any result was viewed** and is reproduced verbatim below.

Headline: **60m is consistent but cannot accumulate enough samples to ever prove itself, and 1d is
worse than taking every bar.** The hypothesis under test was refuted, and the way it was refuted is
the useful part.

## 0. Why this was run

`trend-breakout` — the only strategy owning 15m/30m/60m/1d — was marked `TERMINAL_UNOWNED` earlier the
same day on a tier replay. One cell of that replay was uncomfortable: 60m cleared break-even in all
four instrument-side cells, failing only a 2xSE noise floor, and purely because n was 12-25. If that
was sample scarcity rather than absence of signal, the marking would have been premature.

## 1. Pre-registration (verbatim, written before running)

**H1.** `trend-breakout`'s 60m edge is real, and the noise-floor failure is caused by sample scarcity
from `minimumConfidence: 0.7` rather than by absence of signal.

- If H1 is true: lowering the floor raises n substantially while the gated hit rate stays materially
  above 0.3333 and above its own same-side baseline, so the 2xSE floor becomes attainable.
- If H1 is false: as n grows the gated hit rate decays toward the unconditional baseline.

**Primary read.** The *trend* of `gated - baseline` as n grows — deliberately not "does any single
cell pass". The sweep is 5 thresholds x 2 instruments x 2 sides = 20 cells, and at these sample sizes
several would clear a threshold by chance.

**Pass criteria — all four, no substitutions.** (1) gated > break-even 0.3333; (2) gated beats its own
same-side baseline; (3) clears `0.3333 + 2*sqrt(0.3333*0.6667/n)`; (4) replicates on both instruments
on the same side. These are the three guards that killed the earlier tier sweep plus the baseline
column the tool itself calls deciding. Nothing loosened.

## 2. Method

`--strategy-config` was added to `measure:strategy-tier`, mirroring the flag `run-backtest` already
had, so an arm can differ by one setting without editing the registration — which would silently
change what every other run means. The override is echoed on each result so a swept arm cannot be
read back as the registered default.

```bash
docker exec ai-quant-lab-api-v2 npm run measure:strategy-tier -- \
  --instrument=NIFTY50 --timeframe=60m --strategy-config='{"minimumConfidence":0.5}'
```

Control first: at the registered 0.7 the tool reproduced the morning's numbers exactly
(LONG 0.4167 on 12 resolved, SHORT 0.4000 on 25).

## 3. The confidence floor is inert downward

`minimumConfidence` from 0.7 down to 0.3 produced **byte-identical results at every step** — same
signals, same resolved counts, same hit rates, on both instruments and both timeframes.

It is not ignored. Raising it discriminates sharply:

| `minimumConfidence` | LONG signals | SHORT signals | signals/session |
| :--- | ---: | ---: | ---: |
| 0.70 (registered) | 17 | 25 | 0.04 |
| 0.85 | 17 | 25 | 0.04 |
| 0.95 | 0 | 0 | 0 |
| 0.99 | 0 | 0 | 0 |

So every one of the 42 signals scores between 0.85 and 0.95, against a formula whose range is
`0.38 + 0.3*trigger + 0.22*pattern + 0.1*emaDistance`. The floor bites only above 0.85, and the
scarcity is created entirely upstream: the rule requires a confirmed breakout trigger **and** a
candlestick pattern, and anything clearing that conjunction scores highly by construction.

**H1's premise is therefore false.** The noise-floor failure is not caused by the confidence floor and
cannot be relaxed away. n cannot be raised by this lever at all.

## 4. Results against the gate

Break-even 0.3333. Gated hit rate (resolved n), same-side baseline, advantage, 2xSE floor:

| tier | cell | gated | baseline | advantage | floor | clears floor |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| 60m | NIFTY50 LONG | 0.4167 (12) | 0.3506 | +0.0661 | 0.605 | no |
| 60m | NIFTY50 SHORT | 0.4000 (25) | 0.3345 | +0.0655 | 0.522 | no |
| 60m | BANKNIFTY LONG | 0.4737 (19) | 0.3429 | +0.1308 | 0.550 | no |
| 60m | BANKNIFTY SHORT | 0.3636 (22) | 0.3068 | +0.0568 | 0.534 | no |
| 1d | NIFTY50 LONG | 0.2500 (12) | 0.3989 | **-0.1489** | 0.605 | no |
| 1d | NIFTY50 SHORT | 0.1000 (10) | 0.2665 | **-0.1665** | 0.631 | no |
| 1d | BANKNIFTY LONG | 0.3333 (3) | 0.3626 | **-0.0293** | 0.878 | no |
| 1d | BANKNIFTY SHORT | 0.0000 (3) | 0.2897 | **-0.2897** | 0.878 | no |

**60m — criteria 1, 2 and 4 pass; criterion 3 fails in every cell.** It is above break-even
everywhere, beats its baseline everywhere, and replicates across both instruments on both sides. That
is a more coherent picture than anything the directional work has produced. It still fails, and the
sweep has now closed the only route to fixing it.

**1d — criteria 1 and 2 both fail, and the second failure is the interesting one.** The gated rate is
*below* the unconditional baseline in all four cells, by up to 29 points. Taking every bar beats
taking this rule's signals. Swing is not unproven here; the selection is measurably counterproductive.

## 5. Why 60m can never earn it

At the observed rates each cell needs roughly **45 to 78 resolved signals** to clear its floor
(45 if the true rate is the best observed 0.4737, 78 if it is nearer 0.44), against 12-25 today. At
0.04 signals per session that is **2.4x to 6.5x** the current count — roughly **11 to 30 more years**
of history depending on the cell, on top of the 4.7 years already replayed.

That is the decisive fact, and it is a property of the rule rather than of the market: a rule this
selective cannot accumulate its own evidence within any horizon anyone will wait for. A different
rule with a looser trigger might; this one cannot.

## 6. What changed as a result

Nothing was wired. `SCAN_TIMEFRAMES` is still `1m/5m/15m`, and 30m/60m/1d remain unevaluated by
anything. `trend-breakout` keeps its `TERMINAL_UNOWNED` disposition, now on stronger grounds than the
morning's replay alone: not merely "fails the floor" but "fails the floor and cannot stop failing it".

Data was never the blocker and is worth recording: 15m 22,652/22,651 bars, 30m 14,996/14,993, 60m
8,076/8,074, 1d 2,397/1,158 (NIFTY50/BANKNIFTY), all current to 2026-09-02.

**If intraday or swing is to be revisited, the open question is a rule that fires often enough to be
falsifiable** — not a better threshold on this one. See also
`2026-08-12-intraday-volatility-and-fyers-consolidation.md`, which closed 30m/60m directional and
found 60m volatility-expansion had real skill (precision 0.47 against a 0.24 base rate) but no
tradable edge once straddle costs were applied.

---

# Addendum — the looser trigger (same day)

Section 5 ended by saying the open question was "a rule that fires often enough to be falsifiable",
and named the obvious candidate: breakout **or** pattern rather than **and**. That was then tested,
again pre-registered before any result was viewed. **H2 was refuted, and this time the refutation is
decisive rather than inconclusive — because the sample-size problem is solved and the edge disappears
anyway.**

## H2 and the arms

> The 60m signal is real; the scarcity is the `pattern AND trigger` conjunction. Relaxing it raises n
> enough for the 2xSE floor to become attainable while the gated-minus-baseline advantage survives.
> If H2 is false, the advantage decays toward zero as n grows.

Arms: **A** control (both required), **B** trigger-only allowed, **C** pattern-only allowed, **D**
either sufficient. Two instruments, 60m and 1d, at the registered `minimumConfidence` 0.7 and also at
0.5 for C and D — a pattern-only signal tops out at exactly 0.70, so it would be all but excluded at
the registered floor. 32 cells. Same four pass criteria, unchanged.

Two flags were added to the configuration, `requirePattern` and `requireTrigger`, both defaulting to
`true`. The control replay reproduced the morning's numbers exactly (0.4167 on 12 resolved LONG,
0.4000 on 25 SHORT), which is what establishes that the rule itself did not change.

## Result: zero passes in 32 cells, and the advantage decays with n

The primary read was the trend of `gated - baseline` against n. It is monotone, and it goes negative:

| arm | NIFTY50 60m LONG | BANKNIFTY 60m LONG |
| :--- | :--- | :--- |
| A control | +0.0661 (n=12) | +0.1308 (n=19) |
| B trigger-only | +0.0383 (n=18) | +0.0395 (n=34) |
| C pattern-only | -0.0306 (n=25) | +0.0000 (n=35) |
| D either | -0.0280 (n=31) | -0.0229 (n=50) |
| C @ conf 0.5 | -0.0336 (**n=265**) | -0.0347 (**n=279**) |
| D @ conf 0.5 | -0.0374 (**n=348**) | -0.0289 (**n=363**) |

That is the H2-false prediction exactly. As n grows 15-30x the control's apparent edge does not merely
shrink — it inverts. The 60m LONG advantage that looked like +0.13 at n=19 is **-0.03 at n=363**.

This is the decisive difference from the morning's finding. Then, the objection was "too few samples
to tell". Now there are 250-363 resolved signals per cell, which is ample, and the answer is that
there is nothing there.

## The one thread that is not obviously zero, and why it still fails

NIFTY50 60m SHORT, arm C at conf 0.5: gated 0.3750 against baseline 0.3345, advantage **+0.0405** on
n=256. That clears break-even and beats its baseline. It fails criterion 3 narrowly (floor 0.392
against 0.3750) — and it fails criterion 4 outright: the same arm on BANKNIFTY gives 0.3240, which is
**below break-even**. It does not replicate, which is the same way the 15m cells died.

## 1d: confirmed counterproductive

Every 1d cell has a negative advantage except two that are indistinguishable from zero
(D @ 0.5: -0.0020 and +0.0033). The SHORT side is negative in all twelve cells, between -0.07 and
-0.29. Loosening does not rescue it; at conf 0.5 with n=102 the NIFTY50 SHORT advantage is -0.0018 and
with n=49 the BANKNIFTY SHORT advantage is -0.1673. Taking every bar beats taking these signals.

## Verdict

The intraday and swing question is now closed on adequate samples rather than parked on thin ones.
`trend-breakout`'s `TERMINAL_UNOWNED` disposition stands, and the reason is stronger than it was this
morning: it is not that the rule fires too rarely to prove, it is that when made to fire 20x more
often it has no edge to find.

Nothing was wired. The two new flags default to the historical behaviour and exist so this measurement
is repeatable; the sweep commands are in the commit message and reproduce from stored bars alone.
