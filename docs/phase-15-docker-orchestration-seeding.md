# Phase 15: Docker Containerization, Orchestration & Automated Market Data Seeding

## Purpose

Phase 15 containerizes the entire AI Quant Lab platform (API, Web Dashboard, and PostgreSQL + pgvector database) using Docker and Docker Compose. It establishes automated container lifecycle management, including schema migration on startup, core instrument registration, and comprehensive historical market data seeding.

This phase guarantees that developers and researchers can spin up a fully functional, out-of-the-box quantitative research environment with a single command (`docker compose up -d --build`), eliminating manual environment configuration and missing database state errors.

## Theory and Why It Exists

A full-stack research platform relies on complex data dependencies: strategy evaluation requires completed OHLCV candlesticks, paper trading requires active trade proposals, and technical visualizers require pre-calculated indicator snapshots and pattern detections. In a bare-metal or freshly containerized deployment, empty database tables cause cascading 404 errors and UI blockages (e.g., Paper Trading simulation disabled due to missing trade proposals).

Phase 15 solves this by embedding an **Automated Market Data Bootstrapper** directly into the API container startup sequence. Before the HTTP server begins listening for requests, the container validates database health, applies schema migrations, and injects 600+ multi-timeframe candlesticks, technical indicators, candlestick patterns, strategy versions, and active trade proposals.

## Safety Boundary

- Docker containerization encapsulates the local research environment; no external network ports are opened beyond localhost (`3000` for Web, `4000` for API, `5432` for Postgres).
- Automated seeding populates only historical research simulation data (`source: 'seed'`) and simulated paper trading accounts.
- Preserves the strict platform guarantee: **no real orders can be placed, and no live broker integrations are present in the Docker images.**

## Architecture & Container Orchestration

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Docker Compose Host Network (localhost)                                │
│                                                                        │
│  ┌─────────────────────────┐         ┌──────────────────────────────┐  │
│  │  ai-quant-lab-web       │         │  ai-quant-lab-api            │  │
│  │  (Next.js 16 Dashboard) │         │  (Express REST API)          │  │
│  │  Port: 3000             │         │  Port: 4000                  │  │
│  └───────────┬─────────────┘         └───────────────┬──────────────┘  │
│              │ HTTP (client-side / SSR)              │                 │
│              │ NEXT_PUBLIC_API_URL                   │ DATABASE_URL    │
│              ▼                                       ▼                 │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  ai-quant-lab-db (PostgreSQL 16 + pgvector)                      │  │
│  │  Port: 5432 | Volume: pgdata:/var/lib/postgresql/data            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### Multi-Stage Dockerfiles
- **API Image (`apps/api/Dockerfile`)**: Uses `node:20-alpine` multi-stage builds (`base` -> `builder` -> `runner`). Installs monorepo dependencies, compiles TypeScript contracts and domain modules via `tsc`, and runs as an unprivileged user.
- **Web Image (`apps/web/Dockerfile`)**: Uses `node:20-alpine` multi-stage builds. Compiles the Next.js 16 application with Turbopack, optimizing bundle sizes and static page prerendering.

### Docker Compose Configuration (`docker-compose.yml`)
Orchestrates the 3 core services with explicit health checks and startup dependency ordering:
- `database`: Runs `pgvector/pgvector:pg16` with a persistent Docker volume (`pgdata`) and an active `pg_isready` health check.
- `api`: Depends on `database: condition: service_healthy`. Employs a custom container command that runs schema migrations and data seeding prior to launching the Node web server:
  ```bash
  npm --workspace @ai-quant-lab/api run db:migrate && \
  npm --workspace @ai-quant-lab/api run data:seed:core-instruments && \
  npm --workspace @ai-quant-lab/api run start
  ```
- `web`: Depends on `api: condition: service_started`. Maps `NEXT_PUBLIC_API_URL` to allow seamless client-side browser communication with the local API container.

## Automated Market Data Seeding Engine

To ensure all UI modules work immediately upon container startup, `apps/api/src/modules/market-data/application/seed-market-data.ts` was implemented and linked to `seed-core-instruments.ts`. The bootstrapper executes the following atomic database transaction (`BEGIN` / `COMMIT`):

### 1. Strategy & Algorithm Versioning
- Registers the `trend-breakout` v1 momentum breakout trading strategy in `strategies`.
- Inserts active strategy configuration parameters (`lookback: 20`, `stopLossPct: 1.5`, `targetPct: 3.0`) in `strategy_versions`.
- Registers technical indicator definitions (`SMA`, `BOLLINGER_BANDS`, `RSI`) and candlestick pattern definitions (`BULLISH_ENGULFING`, `BEARISH_ENGULFING`, `DOJI`).

### 2. Multi-Timeframe Candlestick Generation
- Iterates over core instruments: **NIFTY 50** (`NIFTY50`, base price ~₹24,500) and **NIFTY BANK** (`BANKNIFTY`, base price ~₹52,000).
- Generates **300+ completed candlesticks** per instrument across 3 distinct timeframes:
  - Daily (`1d`, 100 days of history)
  - Hourly (`1h`, 100 hours of history)
  - 15-Minute (`15m`, 100 intervals of history)
- Calculates realistic price volatility, high/low wicks, and trading volume, marking all rows with `is_complete = TRUE` and `source = 'seed'`.

### 3. Indicator & Pattern Snapshot Ingestion
- For every seeded candlestick, calculates and inserts corresponding technical indicator snapshots into `indicator_snapshots`:
  - `SMA`: Simple Moving Average value (~0.5% below close).
  - `BOLLINGER_BANDS`: Middle, Upper (+1%), and Lower (-1%) bands.
  - `RSI`: Relative Strength Index oscillator values between 40 and 70.
- For recent candlesticks (last 5 intervals), injects `BULLISH_ENGULFING` pattern detections with `0.85` confidence into `pattern_detections`.

### 4. Active Trade Idea Proposals
- Identifies the latest completed candlestick for each instrument and timeframe.
- Injects 12 active trade proposals (`side: 'LONG'`, `status: 'PROPOSED'`) into `trade_ideas` with pre-computed entry price, stop loss (-1.5%), target price (+3.0%), risk-reward ratio (`2.0`), and evidence JSON.
- Resolves the **"Paper Trading simulation blocked"** issue by ensuring that the UI dropdown in `/paper-trading` is populated with valid, actionable trade ideas on first boot.

## Backend Bugfixes Deployed

During containerization and integration testing, two critical backend bugs were identified and resolved in this phase:
1. **SQL Column Alias Error in Overlays Query**: Corrected `PostgresDashboardQueryRepository.listCandlesWithOverlays` where indicator and pattern table joins referenced non-existent columns (`idf.code` and `pdf.code`). Updated aliases to `idf.indicator_code` and `pdf.pattern_code`, restoring chart overlay rendering.
2. **Missing Multi-Layer Chart Endpoints**: Registered both `GET` and `POST` handlers for `/api/v1/charts/data` in `apps/api/src/interfaces/http/app.ts`. The endpoint transforms raw database candles, indicator snapshots, and pattern detections into the standardized `ChartPayload` JSON schema expected by the frontend SVG visualizer.

## Verification & Deployment Commands

To deploy and verify Phase 15 from scratch:

```powershell
# 1. Rebuild and start all containers in detached mode
docker compose up -d --build

# 2. Verify container health and port mappings
docker compose ps

# 3. Inspect API logs to confirm automated migration and seeding completion
docker logs ai-quant-lab-api

# Expected log output:
# {"level":"info","message":"Database migrations finished",...}
# {"level":"info","message":"Core instruments seeded","symbols":["NIFTY50","BANKNIFTY"]}
# {"level":"info","message":"Historical market data, indicators, patterns, strategies, and trade ideas seeded"}
# AI Quant Lab API listening on port 4000
```
