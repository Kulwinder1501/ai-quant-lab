# Phase 18: Live Financial RSS Feed Ingestion, Quantitative Sentiment Engine & Autonomous Agent Circuit Breakers

## Executive Summary

Phase 18 equips **AI Quant Lab** with a real-time macro financial news ingestion pipeline and quantitative sentiment engine tailored for Indian markets (NSE / BSE). By automatically parsing live RSS feeds from major Indian financial publishers (**Moneycontrol** and **The Economic Times**) every 3 minutes, the system bridges technical indicator analysis with real-time macroeconomic intelligence.

Furthermore, this engine directly powers the **AI Autonomous Agent** with a 3-tier **Emergency Circuit Breaker System**, ensuring that when suspicious market activity, sudden geopolitical shocks, or extreme regulatory announcements occur, our simulated trading strategies react instantaneously to protect capital and adapt their decision-making algorithms.

---

## 1. Architecture & Core Components

```
+-----------------------------------------------------------------------------------+
|                                3-MINUTE CRON SCHEDULER                             |
|                           (Node.js setInterval in API Server)                     |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                            IngestRssNewsService (Worker)                          |
|  * Fetches Moneycontrol & Economic Times Markets RSS Feeds                        |
|  * Strips HTML & extracts headlines, descriptions, and publication timestamps       |
|  * Maps articles to Indian instruments (NIFTY50, BANKNIFTY, RELIANCE, HDFCBANK)    |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                         Quantitative Sentiment Lexicon Engine                     |
|  * Evaluates tokens against domain-specific Indian financial lexicons             |
|  * Calculates normalized score [-1.0 (Bearish) to +1.0 (Bullish)]                 |
|  * Assigns SentimentLabel: BULLISH | BEARISH | NEUTRAL | HIGH_VOLATILITY          |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                      PostgresNewsRepository (Database Storage)                    |
|  * Upserts articles via SHA-256 URL hash deduplication (market_news table)        |
|  * Computes 12-Hour Rolling Sentiment Averages per instrument                     |
+-----------------------------------------------------------------------------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
                       v                                   v
+---------------------------------------+ +-----------------------------------------+
|      AI Autonomous Agent (Tick Loop)  | |         Market News Web UI              |
|  * Reads 12h rolling average score    | |  * /news Interactive Next.js Dashboard  |
|  * Modulates trade proposal confidence| |  * Live Macro Sentiment Gauge & Alerts  |
|  * Triggers 3-Tier Circuit Breakers   | |  * Pill filters, Search & Sync Feed Now |
+---------------------------------------+ +-----------------------------------------+
```

---

## 2. Quantitative Sentiment Scoring & Lexicon Engine

Unlike black-box LLMs that introduce high latency and non-deterministic hallucination risks during live market ticks, our sentiment engine employs a deterministic, high-speed **Quantitative Lexicon Matching Algorithm**:

1. **Tokenization & Normalization**: Headlines and summaries are converted to lowercase, stripped of HTML entities, and tokenized.
2. **Indian Market Financial Lexicons**:
   - **Bullish Weight (`+1.0`)**: *surge, rally, breakout, profit, dividend, bullish, upgrade, expansion, record high, rbi liquidity, credit growth, acquisition*.
   - **Bearish Weight (`-1.0`)**: *crash, slump, plunge, loss, deficit, bearish, downgrade, default, probe, fraud, regulatory notice, npa, penalty, selloff, inflation*.
   - **High Volatility / Risk (`0.0` with Volatility Flag)**: *rbi rate hike, volatility, option expiry, fed decision, geopolitical, tariff, war, disruption*.
3. **Score Normalization**: The net score is bounded between `-1.00` and `+1.00`. An article is tagged:
   - `BULLISH`: Score $\ge +0.20$
   - `BEARISH`: Score $\le -0.20$
   - `HIGH_VOLATILITY`: Contains volatility keywords with neutral sentiment
   - `NEUTRAL`: Score between `-0.19` and `+0.19`

---

## 3. Autonomous Agent Emergency Circuit Breakers

To answer **User Request #9** (*"After how much time of interval we will check the news so that our trades will not get effected, if anything suspicious happen, we need to train our model to handle this situation as well"*):

The agent checks rolling news sentiment **every 3 minutes** via background RSS ingestion and evaluates the following **3 Emergency Circuit Breaker Rules** on every price tick:

| Circuit Breaker Rule | Trigger Condition | Automated Defensive Action | Algorithmic Adaptation & Logging |
| :--- | :--- | :--- | :--- |
| **Rule 1: New Trade Freeze** | Rolling 12h Sentiment $\le -0.50$ | **Freezes all new LONG trade proposals.** Deducts `40%` from AI setup confidence. | Prevents catching falling knives during macro selloffs. Logs defensive thought in agent memory. |
| **Rule 2: Stop-Loss Tightening** | Rolling 12h Sentiment $< -0.30$ | **Dynamically tightens Stop-Loss to `0.5%` trailing distance** below live market price for open LONG trades. | Locks in unrealized gains and shrinks value-at-risk (VaR) before volatility peaks. |
| **Rule 3: Panic Emergency Exit** | Rolling 12h Sentiment $\le -0.70$ | **Immediate Market Liquidation.** Closes open positions instantaneously at market price (`exitReason: "MANUAL"`). | Triggers automated post-trade self-reflection (`generateSelfReflection`), recording a permanent penalty rule for extreme sentiment conditions. |

---

## 4. How Our Application Continuously Trains & Adapts Its AI Model

To answer **User Request #5** (*"How our app will train model?"*), AI Quant Lab utilizes a **Multi-Loop Continuous Learning Architecture** designed specifically for quantitative finance without requiring destructive live broker execution:

### A. Closed-Loop Self-Reflection (Reinforcement from Paper Trade Outcomes)
Every simulated trade initiated by the AI Autonomous Agent is evaluated upon closure. In `generateSelfReflection()`, the agent inspects the technical indicators (RSI, Bollinger Bands, MACD) and news sentiment at entry versus the final realized P&L:
- **Winning Trades (Positive Feedback)**: The agent reinforces the indicator weightings that led to the profitable setup.
- **Losing Trades (Penalty Adaptation)**: If a trade fails (e.g. Stop-Loss hit during RSI divergence), the agent synthesizes an explicit improvement rule (e.g., `AI PENALTY: Avoid buying when RSI > 68 near upper Bollinger Band resistance`). On future ticks, the agent evaluates active rules and applies numerical penalties (`-15%` to `-25%` confidence reduction) to avoid repeating historical errors.

### B. Rolling Sentiment Adaptation & Shock Resilience
When suspicious market activity or macroeconomic shocks occur, the 3-minute RSS ingestion cycle captures the negative keywords (*crash, probe, penalty, selloff*). The rolling sentiment average drops precipitously, activating Circuit Breakers. When an emergency exit occurs under Rule 3, the agent records an explicit memory artifact associating the specific instrument and technical setup with high-volatility news risks, teaching the model to demand stronger technical confluence (`> 90%` confidence threshold) during periods of macroeconomic uncertainty.

### C. Strategy Versioning & Sharpe Ratio Optimization
All trade proposals, paper fills, and indicator states are persisted in PostgreSQL (`strategy_versions`, `trade_ideas`, `paper_trades`). By querying quantitative performance metrics (Win Rate, Profit Factor, Maximum Drawdown, and Sharpe Ratio), researchers can promote top-performing strategy versions and deprecate underperforming indicator parameters, ensuring the model's analytical edge evolves alongside Indian market regime changes.

---

## 5. API Endpoints & Web Dashboard Integration

### Backend REST API Endpoints
- `GET /api/v1/market-news`: Returns paginated news articles filtered by `provider` (`MONEYCONTROL`, `ECONOMIC_TIMES`), `sentiment` (`BULLISH`, `BEARISH`, `NEUTRAL`, `HIGH_VOLATILITY`), `symbol`, or keyword `search`, along with an aggregated `sentimentSummary`.
- `POST /api/v1/market-news/refresh`: Manually triggers immediate synchronous RSS ingestion across all configured feeds.

### Frontend Interactive Dashboard (`/news`)
Located under the **Market News** navigation tab (`📰 Market News`), the Next.js UI features:
1. **System Defense Status Banner**: A real-time visual indicator displaying active Circuit Breaker rules and rolling 12-hour sentiment scores.
2. **Interactive Pill Filters & Search**: Instant filtering across providers, sentiment tags, and Indian symbols (`NIFTY50`, `BANKNIFTY`, `RELIANCE`, `HDFCBANK`, `INFY`, `TATAPOWER`, `COALINDIA`).
3. **Live Feed Sync Button**: Allows researchers to trigger `POST /api/v1/market-news/refresh` directly from the browser.
4. **Read-Only Safety Boundary**: Enforces our core architectural guarantee: *The application is an inspection and simulation lab that never connects to live broker APIs or executes real monetary orders.*

---

## 6. Verification & Operational Guidelines

To verify the live RSS pipeline and Circuit Breakers locally:
1. Ensure the PostgreSQL database is running: `docker compose up -d postgres`.
2. Apply database migrations: `npm run db:migrate --workspace @ai-quant-lab/api`.
3. Start the local API and Web servers: `npm run dev`.
4. Open `http://localhost:3000/news` in your browser.
5. Click **Sync Feeds Now** to observe real-time RSS ingestion from Moneycontrol and The Economic Times, complete with quantitative sentiment scores and symbol mapping!
