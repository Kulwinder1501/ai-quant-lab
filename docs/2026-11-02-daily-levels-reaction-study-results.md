# Daily levels reaction study: results (run 2026-11-02, protocol 2026-11-02, study version levels-reaction-v1)

Run once, exactly as fixed in `2026-11-02-daily-levels-sheet-and-reaction-protocol.md` (committed before this run; the only change
between commit and run was the added session-exclusion rule, also committed before). Command:
`npm run research:daily-levels-study -- --to 2026-10-30`, read-only, 5 seconds. Nothing was tuned after seeing a number.

## Data

15-minute bars, regular session, 2023-01-02 to 2026-10-30. Sessions with fewer than 20 of 25 bars are skipped.

| | NIFTY50 | BANKNIFTY |
|---|---|---|
| Sessions used | 945 | 945 |
| Sessions skipped | 3 | 3 |
| Real-level first touches | 6,444 | 5,812 |

## Result: bounce share of resolved touches, real levels against placebo lines

Difference is real minus placebo in percentage points, with the day-clustered 95% bootstrap range.

### NIFTY50

| Levels | Real (n) | Placebo (n) | Difference (95% range) |
|---|---|---|---|
| All | 57.7% (4,758) | 55.8% (1,108) | +1.9 (-3.2 to +7.0) |
| Previous day | 53.6% (1,180) | 50.5% (196) | +3.0 (-5.7 to +11.4) |
| Pivot | 59.9% (1,595) | 58.6% (457) | +1.2 (-4.6 to +7.2) |
| 5-day range | 57.1% (343) | 51.8% (137) | +5.3 (-4.9 to +15.8) |
| Previous week | 60.8% (288) | 55.0% (131) | +5.8 (-5.0 to +17.0) |
| Round number | 58.2% (1,352) | 57.8% (187) | +0.5 (-7.6 to +8.7) |
| Confluence 2+ against 1 (descriptive) | 56.8% (3,138) | 59.5% (1,620) | -2.8 (-6.1 to +0.7) |

### BANKNIFTY

| Levels | Real (n) | Placebo (n) | Difference (95% range) |
|---|---|---|---|
| All | 56.1% (4,944) | 58.0% (3,154) | -1.8 (-5.4 to +1.9) |
| Previous day | 55.4% (1,387) | 60.5% (731) | -5.1 (-10.1 to +0.0) |
| Pivot | 56.6% (1,826) | 56.4% (983) | +0.3 (-4.3 to +4.8) |
| 5-day range | 57.7% (390) | 58.9% (265) | -1.2 (-9.2 to +7.2) |
| Previous week | 60.6% (343) | 58.1% (217) | +2.6 (-6.5 to +11.9) |
| Round number | 54.2% (998) | 57.4% (958) | -3.2 (-8.0 to +1.5) |
| Confluence 2+ against 1 (descriptive) | 54.6% (2,696) | 58.1% (2,248) | -3.5 (-6.8 to -0.1) |

## Reading

- **No level family bounced more often than placebo lines, on either index.** Every interval for the pre-registered comparison (family against its own displaced lines) contains zero; BANKNIFTY previous day only just (-10.1 to +0.0). The points are small and scattered on both sides of zero.
- **One interval excludes zero**: BANKNIFTY, confluence 2+ against 1, -3.5 (-6.8 to -0.1), the descriptive comparison. It misses zero by 0.1 point, is one of fourteen intervals, and is the opposite of what "agreeing levels matter" would predict. Fourteen intervals at 95% give about one in twenty by chance, so this is recorded and not read as a finding. It is not repeated on NIFTY50 (-2.8, -6.1 to +0.7).
- **Everything, placebo included, bounces about 50-61%.** That is the built-in bias of measuring from the line: the touch bar has often already moved away from the line when it closes, so a bounce needs less new movement than a break. It applies equally to real and placebo lines, which is why the comparison is with placebo and not with 50%.
- **What this can and cannot rule out.** The ranges are about 7-10 points wide for all levels and 9-22 points wide for a single family, so a difference of up to roughly five points for all levels, or ten for a family, cannot be excluded. What is excluded is a large one: if these levels held or broke price in a way that mattered at this scale, the numbers would not look like random lines.
- **Open-interest walls are not tested.** Their history starts 2026-08-04, too short to replay.

## What this changes

Nothing in trading. The sheet is shown as context, with this table beside it and the sentence "No demonstrated difference from
random lines" where that is what the interval says. A different definition of touch, bounce or window would be a new protocol,
not an edit of this one.
