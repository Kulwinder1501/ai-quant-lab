# Phase 14: Interactive Full-Stack Web Application & Dashboard Operability

## Purpose

Phase 14 transforms the AI Quant Lab platform from a CLI-dependent research framework into a fully interactive, full-stack web application. Every quantitative engine—from candlestick pattern recognition to paper trading execution—is made directly operable from the Next.js frontend with real-time feedback, interactive modals, and institutional-grade visualizers.

This phase eliminates the need to run manual terminal commands for daily research workflows while strictly preserving the core safety boundary: **the application is NOT an automated trading system and will NEVER place real orders.**

## Theory and Why It Exists

In quantitative research, switching between command-line tools for signal generation and static reports for inspection creates cognitive friction and slows down strategy iteration. Phase 14 bridges this gap by introducing:

- **Bi-directional Frontend Transport**: Safe HTTP mutation helpers (`postResearchJson`) that allow UI components to trigger backend simulation evaluations, strategy proposals, and chart aggregations.
- **Unified Navigation & Research Shell**: An intuitive 6-tab navigation bar (`ResearchNavigation`) connecting Scanner, Predictions, Strategy, Paper Trading, Backtesting, and Charts.
- **Stateful Interactive UI Modules**: Rich client-side React components utilizing modern aesthetics (glassmorphism, vibrant dark mode palettes, and smooth micro-animations) to make complex market data scannable and engaging.

## Safety Boundary

Phase 14 adds UI operability exclusively for local research and simulated paper trading:
- All execution buttons (e.g., `🚀 Simulate in Portfolio`, `⚡ Evaluate Rules`) communicate only with local Express REST endpoints.
- No broker authentication, broker SDKs, or live order routing capabilities are exposed or implemented.
- Simulated paper fills require explicit user confirmation via interactive modals, ensuring human-in-the-loop control for all portfolio changes.

## Architecture & Transport Layer

```text
Next.js Frontend (Browser)                  Express API (Local Node.js)
  │                                           │
  ├─ GET /api/v1/watchlist ──────────────────>│ Read-only instrument projection
  ├─ GET /api/v1/market-scanner ─────────────>│ Completed-candle evidence scanner
  ├─ GET /api/v1/predictions ────────────────>│ ML model inference & explanations
  ├─ GET /api/v1/trade-ideas ────────────────>│ Active strategy proposals (PROPOSED)
  ├─ POST /api/v1/trade-ideas/generate ──────>│ Trigger breakout rule evaluation
  ├─ GET /api/v1/paper-accounts ─────────────>│ Simulated fund account balances
  ├─ POST /api/v1/paper-trades/open ─────────>│ Execute local simulated paper fill
  ├─ POST /api/v1/paper-trades/evaluate ─────>│ Evaluate open trade target/SL exits
  ├─ GET /api/v1/backtest-runs ──────────────>│ Chronological simulation tear sheets
  └─ GET|POST /api/v1/charts/data ───────────>│ Multi-layer OHLCV & overlay series
```

### Transport Helper (`postResearchJson`)
To support safe mutations from client components, `apps/web/src/features/research/api.ts` was extended with `postResearchJson(path, body, signal)`. This helper mirrors `getResearchJson` by enforcing JSON content types, handling network timeouts, and throwing structured error messages that UI modals render as user-facing alerts.

## Interactive Feature Modules

### 📈 1. Paper Trading Portfolio (`/paper-trading`)
- **Fund Selector & Creation Modal**: Users can switch between multiple simulated funds or create new accounts with custom INR (`₹`) capital balances (e.g., ₹1,000,000).
- **Simulated Execution Modal**: Clicking `+ Open Position` opens an interactive form where users select from active database trade proposals, input custom share quantities, and confirm simulated fills.
- **Automated Rule Evaluation**: A one-click `⚡ Evaluate Rules` action triggers backend logic to check if open positions have breached historical stop-loss or take-profit targets, updating realized P&L dynamically.
- **Institutional Tear Sheets**: Summary cards displaying Available Capital, Realized P&L, Unrealized P&L, and Win Rate % (`W / L`).

### 💡 2. Strategy Engine & Trade Ideas (`/strategy`)
- **Proposal Generation Modal**: Users can trigger the `trend-breakout` v1 strategy engine against recent completed candles directly from the UI by selecting an instrument symbol and timeframe (`1d`, `1h`, `15m`).
- **Dynamic Evidence Breakdown**: Proposal cards display confidence scores, risk-reward ratios, stop-loss/target geometry, and expandable JSON reasoning badges.
- **One-Click Simulation**: A dedicated button on each proposal card transfers the trade parameters directly into the Paper Trading execution modal.

### 🔄 3. Historical Replay & Backtesting (`/backtesting`)
- **Simulation Runner Form**: Users can configure and submit chronological strategy backtests over custom historical date windows (e.g., `2025-01-01` to `2026-06-30`) with adjustable initial capital and trade quantities.
- **6-Metric Tear Sheet**: An executive inspector showcasing Net P&L, Win Rate %, Profit Factor, Sharpe Ratio, Max Drawdown %, and Total Trades.
- **Granular Log Inspector**: Tabbed views allowing researchers to toggle between trade-by-trade execution logs and monthly performance tables.

### 📊 4. Interactive Technical Charts (`/charts`)
- **Multi-Layer SVG Canvas**: A custom, high-performance candlestick visualizer built with vanilla CSS and SVG, supporting responsive auto-scaling and crosshair inspection.
- **Technical Indicator Overlays**: Interactive toggle buttons for Simple Moving Average (`SMA 20`), Bollinger Bands (`BB 20, 2` shaded envelope), and Relative Strength Index (`RSI 14` sub-chart oscillator).
- **Automated Pattern Annotations**: Visual markers overlaid directly onto candlesticks indicating detected pattern evidence (e.g., Bullish Engulfing, Hammer) along with algorithm confidence scores.

### 🔎 5. Market Scanner & Watchlist (`/`)
- **Real-Time Evidence Table**: Scans active instruments and surfaces their latest completed-candle price action, RSI readings, trend direction, and ML model predictions in a single unified dashboard.
- **Instrument Registry Projection**: Displays core exchange metadata, KITE quote symbols, and canonical names.

### 🤖 6. ML Predictions & Explainable AI (`/predictions`)
- **Model Inference Cards**: Displays logistic regression market direction probabilities (`BULLISH` / `BEARISH` / `NEUTRAL`) generated from purged chronological validation splits.
- **Feature Contribution Inspector**: Visual progress bars showing the exact weight and direction of individual features (e.g., momentum, volatility, RSI) contributing to the model's prediction.

## UI Design Aesthetics & Motion System

To ensure an engaging and premium user experience, all modules adhere to the custom **UI Motion & Aesthetics System** (`docs/ui-motion-system.md`):
- **Glassmorphism**: Built using reusable `GlassPanel` containers with translucent backgrounds (`bg-slate-950/80`), subtle borders (`border-white/10`), and backdrop blurring (`backdrop-blur-md`).
- **Vibrant Curated Palettes**: Accent gradients using cyan (`from-cyan-500 to-blue-600`), emerald for bullish/profit states (`text-emerald-400`), and rose for bearish/loss states (`text-rose-400`).
- **Smooth Micro-Animations**: Page transitions and card rendering wrapped in `Reveal` components with CSS fade-in and translateY animations, providing tactile visual feedback for user interactions.

## Verification & Testing

- **Static Type & Build Integrity**: Verified via `npm run build --workspace @ai-quant-lab/web`, confirming all pages, route handlers, and domain interfaces compile cleanly under Next.js 16 (Turbopack).
- **Unit & Integration Suite**: Verified via `npm run test`, ensuring 100% pass rate across domain logic, repositories, and HTTP route handlers.
