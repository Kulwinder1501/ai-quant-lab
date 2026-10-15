# ICT daily-bias variants: results (2026-10-15)

Protocol: `docs/2026-10-15-ict-htf-bias-variants-protocol.md`, committed before any run. Settings as registered: `ict-structure-v1`, 2 bps slippage per side, up to 5 concurrent positions, quantity 1 (P&L in index points), **no fees**. The only difference between arms is the daily bias series.

## Verdict

**Neither variant passes the pre-registered rule. There is no evidence that a faster daily bias helps `ict-structure-v1`, and the live rule stays as it is.**

## Results

Net P&L is in index points; H1 and H2 are the two halves of each window, split at its midpoint, with trade counts in brackets. "Extra" are trades the arm took that the control did not; "dropped" are control trades the arm did not take.

### Primary cells (the two live bots)

| Cell | Arm | Trades | Net | PF | H1 | H2 | Extra trades | Dropped |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| NIFTY50 15m (2023-01-02 to 2026-10-14) | CONTROL | 106 | -6,714 | 0.24 | -2,255 (55) | -4,459 (51) | | |
| | A internal-choch | 100 | -5,997 | 0.25 | -893 (52) | -5,104 (48) | 27 → +222 | 33 → -495 |
| | B zone-tap-choch | 89 | -5,207 | 0.29 | -706 (41) | -4,501 (48) | 17 → +255 | 34 → -1,252 |
| BANKNIFTY 5m (2026-01-01 to 2026-10-14) | CONTROL | 36 | -1,827 | 0.59 | -1,664 (15) | -163 (21) | | |
| | A | 37 | -3,737 | 0.28 | -3,221 (18) | -516 (19) | 15 → -711 | 14 → +1,200 |
| | B | 34 | -2,180 | 0.53 | -1,664 (15) | -516 (19) | 5 → -272 | 7 → +81 |

### Secondary cells (context only, never used to rescue a primary)

| Cell | Arm | Trades | Net | PF |
|---|---|---:|---:|---:|
| BANKNIFTY 15m | CONTROL | 81 | -8,159 | 0.39 |
| | A | 83 | -9,691 | 0.31 |
| | B | 87 | -9,466 | 0.34 |
| NIFTY50 5m | CONTROL | 71 | -1,216 | 0.48 |
| | A | 77 | -1,875 | 0.29 |
| | B | 88 | -510 | 0.75 |

## Decision rule, line by line

On NIFTY50 15m both variants beat control on net P&L (A by 717 points, B by 1,507) and their extra trades were slightly positive, but the profit factor stayed far below 1 (0.25 and 0.29) and neither improved both halves: A was worse than control in the second half, and B was about equal. On BANKNIFTY 5m both variants failed every line: net P&L was lower than control, the profit factor was below 1, neither improved both halves, and their extra trades lost money. A variant needed every line on both cells, so both fail.

## What the results do say

- **The control loses on every cell over all available history**: profit factor 0.24 to 0.59, net negative on all four, before any fees. The strategy's earlier 20-month NIFTY50 15m result (+18,342, PF 2.46) was a window effect, as the registry note already warned; over 3.8 years the same cell is -6,714.
- **A faster daily bias mostly changes which trades are taken, not whether they win.** On NIFTY 15m it trades slightly less and loses slightly less; on BANKNIFTY it adds trades that lose.
- **The zone condition (B) helped a little more than none (A)** on NIFTY 15m and NIFTY 5m and about the same on BANKNIFTY. Nothing here is significant at these trade counts.

## Limits

BANKNIFTY 5m has 34-37 trades over 9.5 months, so a null there is mostly low power. The test prices the index, not the options the bots buy, and charges no fees. Four arms of comparison on small samples cannot separate a real small effect from noise. The control being negative everywhere means the comparison asks which of three losing rules loses less, which is a weak question.
