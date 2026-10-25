# AutoBot-Scalp1m v9 (NIFTY50 1m, 8/12-point geometry): stopping rule

Status: **APPROVED by the operator on 2026-10-25** and binding from the commit that contains this line. Drafted the same day, before any v9 trade existed (re-checked at approval: 0 v9 trades opened or closed on NIFTY50; v9 has 3 trade ideas, none filled).

## Why a rule is needed

- v9 plans about Rs 260–300 of risk per trade (8 index points, option delta about 0.5, lot 65–75).
- A round trip costs about Rs 77 (fee model fitted on 582 closed trades: Rs 47 + 0.185% of entry premium cost, R² 0.98). That is about 0.29R per trade.
- At a 1:1.5 target the bot needs to win about **51.6%** of trades to break even. The old Scalp1m geometry won 29% (65 trades, -0.59R per trade).
- Across all bots, trades with planned risk under Rs 400 returned -0.64R per trade net (150 trades), and the highest fee share.

So v9 is a fair experiment, but it must not run indefinitely on hope. This rule says in advance when it stops.

## Population

Closed paper trades of account `AutoBot-Scalp1m`, strategy `momentum-scalp`, **version 9**, underlying NIFTY50, not `excluded_from_evidence`, counted from the first one. Counting query:

```sql
select count(*) closed_v9, sum((t.realized_pnl>0)::int) wins, round(sum(t.realized_pnl)) net_inr
from paper_trades t join paper_accounts a on a.id=t.account_id
join trade_ideas ti on ti.id=t.trade_idea_id join strategy_versions sv on sv.id=ti.strategy_version_id
join strategies s on s.id=sv.strategy_id
where a.name='AutoBot-Scalp1m' and s.strategy_key='momentum-scalp' and sv.version=9
  and t.status='CLOSED' and t.underlying_symbol='NIFTY50' and not t.excluded_from_evidence;
```

Metric: net R per trade = `realized_pnl` (already net of fees) divided by planned risk = |entry price − initial stop| × quantity.

## Rule

1. **Early futility, at 30 closed trades:** stop if wins ≤ 9 (win rate ≤ 30%).
2. **Drawdown, checked after every trade:** stop if cumulative net R reaches **−20R** (about Rs 5,300 on current sizing).
3. **Final decision, at 250 closed trades:** keep v9 only if mean net R per trade is above zero **and** the lower end of the day-clustered bootstrap 95% interval (4,000 draws) is above zero. Otherwise stop.
4. A checkpoint is applied once, when the count is reached. Looking at results between checkpoints does not change the rule, and no checkpoint is added or moved after seeing results.

A 60-trade checkpoint (stop if wins ≤ 22) was considered and left out: in simulation the drawdown stop always fires first, so it never changes the outcome.

## What the rule does (simulated, 250-trade runs; wins +1.5R, losses −1R, fee 0.29R)

| True win rate | Expectancy (R/trade) | Stopped by 30-trade check | Stopped by −20R drawdown | Runs to 250 | Average trades taken |
|---|---|---|---|---|---|
| 29% (old geometry) | −0.56 | 36% | 64% | 0% | 35 |
| 40% | −0.29 | 14% | 85% | 0% | 69 |
| 45% | −0.16 | 6% | 86% | 8% | 117 |
| 51% (break-even) | −0.01 | 1% | 35% | 64% | 208 |
| 55% | +0.09 | 0% | 7% | 93% | 241 |
| 60% | +0.21 | 0% | 0% | 100% | 249 |

Reading it: a bot like the old one is stopped within about 35 trades. A bot that is genuinely profitable (55% or more) is stopped by mistake in at most 7% of runs. A break-even bot runs on about two-thirds of the time, and the final 250-trade test then rejects it unless its interval is above zero.

## What "stop" means

- The operator decides; nothing stops itself. Stopping means removing `NIFTY50:1m` from AutoBot-Scalp1m's series (the `DISABLED_SERIES` set in `run-paper-trading-bot.ts` / `allowedSeries` in `bot-sandboxes.ts`).
- The trade history stays; nothing is deleted.
- Changing the geometry (stop, target, instrument, timeframe) after seeing results is a **new version with a new counter**, not a continuation. The 8/12-point geometry is not tuned on these trades.

## Pace

Old Scalp1m produced about 3.4 trades a day across both instruments over 19 days; NIFTY50 1m alone should be roughly 1–2 a day, so 30 trades is about 3–6 weeks and 250 about 4–8 months. v9 has had 3 ideas in its first two trading days.

## Integrity stops (any time)

Stop and investigate, without waiting for a checkpoint, if: any trade is filled at a price that implies a stop or target different from 8 and 12 points; the median fee exceeds 35% of planned risk over 20 trades; or the account's trades on this series stop being recorded.

## Known limits

- The simulation assumes independent trades with two outcomes; real exits (stall, invalidation, time stop) are messier.
- Fees are the recorded fees (Rs 77 on average). Spread and fill quality are in the recorded fill prices, not modelled separately.
- NIFTY lot size is 65 in reality but older records used 75 (P&L about 15% high); R is unaffected, rupee amounts are not.
- This governs a paper experiment. It is not a trading recommendation, and any live use needs the usual human review.
