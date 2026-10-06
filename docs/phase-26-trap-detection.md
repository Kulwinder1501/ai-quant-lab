# Phase 26: Option Trap Detection Logic

## Overview
Phase 26 introduces **Live Trap Detection** into the paper-trading mark-to-market engine. The system continuously evaluates open option positions against live market quotes to protect capital from depreciating options that fail to participate in underlying market movements.

When an option buyer pays premium, they face immediate headwinds from Theta (time decay) and Vega (implied volatility crush). In some market conditions (e.g., following a sharp volatility expansion), the underlying index may move in the expected direction, but the option premium may stagnate or fall. This phenomenon traps the buyer in a losing trade despite calling the directional move correctly.

The Trap Detection system intercepts these trades and triggers an automatic, preemptive exit, returning capital before the standard premium-based stop loss is hit.

## Mechanics

### 1. The Entry Anchor (`underlying_entry_price`)
To measure divergence, the engine must know exactly where the underlying index was when the option was purchased. 
- A new column `underlying_entry_price` was added to the `paper_trades` table.
- When an option trade is opened, the exact spot price of the underlying asset is snapshotted and persisted to this column via `OptionContractSpec`.

### 2. Live Evaluation Rules
During active market hours, the `evaluateOpenPaperTrades` background task receives live streaming ticks (or 1-minute closed candles) for the underlying index and evaluates every open position.

The logic evaluates two conditions for a Trap:
1. **Favorable Underlying Move**: Has the underlying index moved in the favorable direction by at least `0.05%` (e.g. ~12 points on Nifty)? 
   - `liveSpot - underlyingEntryPrice >= minFavorableMove` (for Call options)
   - `underlyingEntryPrice - liveSpot >= minFavorableMove` (for Put options)
2. **Premium Divergence**: Has the option premium failed to rise?
   - `markPremium <= entryPrice` (The P&L is negative or zero)

If both conditions evaluate to `true`, the `decideOptionBuyerLiveExit` and `decideOptionBuyerExit` functions immediately return an exit decision with `reason: "TRAP_DETECTED"`.

### 3. Execution & Visualization
- Trades closed by this logic are recorded with the `TRAP_DETECTED` exit reason in the `paper_trade_events` and `paper_trades` tables.
- The Live Positions dashboard handles the live marking and gracefully removes the position once closed.
- The Trade History component highlights the `TRAP_DETECTED` badge in orange/yellow to help users differentiate it from standard `STOP_LOSS` or `TARGET` exits.

## File Modifications
- **Database**: `043-paper-trade-underlying-entry.ts`
- **Domain Models**: `paper-trading.ts`, `paper-trade-exit-policy.ts`, `paper-trade-history.ts`, `backtesting.ts`
- **Engine**: `option-mark-to-market.ts`, `evaluate-open-paper-trades.ts`, `option-buyer-fill.ts`
- **Frontend**: `trade-history-table.tsx`, `domain.ts`
