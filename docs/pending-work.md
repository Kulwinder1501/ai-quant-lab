# Pending Work — AI Quant Lab

**Rewritten 2026-08-05.** Everything below was verified against the tree and the live v2
database on that date. Where a figure is quoted, it was measured, not estimated.

Section 4 records the items that were pending on 2026-08-04 and are now closed, with what
verified each. Reading it first is the fastest way to avoid redoing work.

---

## 0. Verify before you trust

Briefs in this repo have gone stale and cost real time. Check these first, and treat a
mismatch as "this file is older than the tree", not "the tree is broken".

```bash
cd apps/api && npx tsc --noEmit && npx vitest run
```
Expect a clean typecheck and **560 passed / 71 files**.

```bash
py -3.12 -m unittest discover -s apps/ml -p "test_*.py"
```
Expect **`Ran 258 tests ... OK`**.

```bash
cd apps/api && npm run build
```
Expect exit 0. This is what the Dockerfile runs, so a failure here means **no image can be
built** — and `vitest` will not catch it, because it does not typecheck. That combination
already shipped once.

| | state on 2026-08-05 |
|---|---|
| HEAD | `487c17d` on `feature/champion-challenger` |
| migrations | through **041**; next is **042** |
| system of record | **v2, port 5433**. v1 (5432) is a read-only audit trail |
| paper trades | **5 rows, 4 excluded from evidence** — 2 phantom-expiry, 2 synthetic verification |
| option chain history | begins **2026-08-04**. Forward-accumulating, no backfill exists |
| both databases | bound to `127.0.0.1` |

---

## 1. Open items

### 1.1 The entry gate never checks volume or events

`validateOptionsEntry` runs on every option entry and refuses on confidence, falling open
interest, spread over 3%, sub-1-DTE at low confidence, and delta under 0.40. Two of its
factors are permanently unevaluated, and it says so on every trade rather than staying quiet:

```
"unchecked": [
  "Macro events: no scheduled-event calendar exists, so event risk was not screened.",
  "Volume confirmation: no bar volume was supplied."
]
```

Volume is the cheap one: the open-trade route has an `instrument_id` and a timeframe, so it
could read the latest completed bar and pass `candleVolume`. Events are 1.3 below.

Do not "fix" this by removing the `unchecked` entries. A gate that reports `isValid: true`
while silently skipping factors is the exact failure this project has already paid for twice
— once with `greeks.price`, once with guards written `x !== null && x !== undefined` against
fields that did not exist.

### 1.2 No IV history, so "unusually high IV" has no answer

Chain snapshots begin 2026-08-04, so there is no percentile to compute and no way to
backfill one: a chain endpoint returns the current book and no historical source exists.
This resolves with time and only with time. **Do not try to reconstruct it.**

### 1.3 No event calendar, and headlines cannot substitute for one

Measured 2026-08-05 against the stored newswire: the keyword detector in
`check-macro-events` fires on **7 of 9 days**. Tightened to unambiguous phrases
("monetary policy", "federal reserve", "fomc", "cpi data", …) *and* requiring five
corroborating articles, it still fires on **4 of 9**. Financial media discusses monetary
policy continuously, so the detector mostly reports that a newswire exists.

It was a −50 confidence "circuit breaker" described as freezing trading, which meant idea
generation was being suppressed roughly four days in five. It is now a −10 caution and no
longer short-circuits the sentiment branch. Nine days is a small sample; the exact rate will
move, the direction will not.

A real filter needs a calendar of **scheduled** events — earnings dates, policy dates,
expiry-week flags — which this project does not have. That is the work; more keyword tuning
is not.

### 1.4 The pricing engine is duplicated on the web client

`apps/web/src/lib/black-scholes-engine.ts` and `implied-volatility.ts` are line-for-line the
same length as their API counterparts (168 and 281). Two implementations of the same maths
will drift, and every pricing bug fixed this week was fixed in the API copy only — none of
those fixes reached the browser.

Decide whether the client should price at all or only render what the API computed. If it
must price, the shared code belongs in `packages/`.

### 1.5 Chain collection has unbackfillable gaps, and failures are not diagnosable

On 2026-08-05 the first successful snapshot was 06:30 UTC (12:00 IST); three runs failed at
05:45, 06:00 and 06:15, and nothing was attempted during 09:15–11:15 IST. Chain data cannot
be backfilled, so that morning is permanently missing.

`scheduled_job_runs.error_details` recorded only:

```
npm run data:collect:option-chain -- --underlyings ... exited with code 1
```

The actual reason is not captured, so a failure cannot be diagnosed after the fact. The
child process's stderr should be recorded.

`assessFyersAuthHealth` does now count these failures and logs at error level from the
scheduler (see 4.4), but nothing pages anyone — an error line in a container log is only
found by someone already looking.

### 1.6 `fyers-live-streamer` is untyped and untested

128 lines backing an SSE tick endpoint, with `private socket: any` and no test. It works
insofar as the endpoint responds; nothing pins its reconnect or resubscribe behaviour. The
`fyers-api-v3` dependency and `apps/api/src/types/fyers-api-v3.d.ts` (a hand-written ambient
declaration, `export const fyersModel: any`) exist solely for it.

### 1.7 A BANKBEES/NIFTYBEES 5m TCN window must start no earlier than 2020-01-01

Measured 2026-08-05, after backfilling NIFTYBEES 5m and BANKBEES 1m/5m from Fyers back to
2019-01-01 (previously NIFTYBEES 5m stopped at 2023-01-02 and BANKBEES had zero rows).

The `tcn-5m` exact-window gate (`SEQUENCE_WINDOW_GATES` in `sequence_readiness.py`) requires
a zero-volume fraction ≤ 1%. BANKBEES 5m fails if the window reaches back to 2019 — that year
alone is **20.0%** zero-volume (3,656 of 18,280 bars), while every year from 2020 onward is
≤ 0.43% and usually ~0.00%. BANKBEES was thinly traded in its first year as an ETF and has
been reliably liquid since. This is not a collection defect and more backfilling will not fix
it.

**The fix is the training window, not the data or the gate**: start no earlier than
2020-01-01. That leaves ~122,237 bars across ~1,600 sessions for BANKBEES 5m — past the
100k-bar/250-session floor — at ~0.07% zero-volume.

| series | bars | sessions | range |
|---|---|---|---|
| NIFTYBEES 1m | 331,516 | 888 | 2023-01-02 → 2026-08-03 |
| NIFTYBEES 5m | 140,524 | 1,882 | 2019-01-01 → 2026-08-04 |
| BANKBEES 1m | 331,888 | 889 | 2023-01-02 → 2026-08-04 |
| BANKBEES 5m | 140,517 | 1,882 | 2019-01-01 → 2026-08-04 (use `--from 2020-01-01`) |

No BANKBEES training pipeline exists yet — `train_tcn.py` and `train_stack.py` still hardcode
`AUTHORIZED_SYMBOL = "NIFTYBEES"`. A note for whoever builds that track, not a change made to
either file.

### 1.8 Leftover verification rows

Two `trade_ideas` rows carry `evidence->>'synthetic' = 'true'`, created to exercise the
option open/close path while the market was closed (the real generator persists nothing
without a new candle). They cannot be deleted without orphaning the paper trades keyed to
them. The two trades they produced are flagged `excluded_from_evidence`, so no aggregate sees
them.

---

## 2. Security — the user's actions, not the agent's

### 2.1 The Postgres password is public

The real `POSTGRES_PASSWORD` has been in `origin/main` since commit **`5ecf97a`**, and the
repository is **public**. **Rotation is the user's action.** An agent must not rotate or
install credentials.

`.env.example` is git-tracked and must contain only empty placeholders. Real values live in
`apps/api/.env` (gitignored), and `scratch/` is gitignored because it held a probe that reads
an access token out of `provider_credentials`.

---

## 3. Settled — do not redo

Measured negative results. Re-deriving these is the most likely way to waste a session.

| finding | evidence |
|---|---|
| **Direction prediction has no edge** | CPCV accuracy loses 93% of splits; 20× more data moved macro-F1 by 0.0004 |
| **Volatility expansion does** | macro-F1 ~0.44 vs trivial ~0.17, wins both metrics on 100% of splits, holds across walk-forward folds. **The live track** |
| **RAG retrieval has no signal** | k-NN over real market context loses to trivial on accuracy and is matched by shuffled labels. Do not build the embedding pipeline |
| **Momentum-scalp has no edge** | loses on 1d even frictionless; the low-volatility edge decays out of sample |
| **Long straddles need 44.3% EXPANSION precision** | gross edge +0.117% of spot, dies at ~1.09% cost per leg. Measured spreads: NIFTY 0.24%, SBIN 2.24% — the signal works where it cannot be traded cheaply |
| **BANKNIFTY is monthly-only** | the provider flags every expiry `M`. NIFTY50 has weeklies. Every NSE expiry is a **Tuesday** |
| **Model marks can invert a P&L sign** | on a live 57700 CE the model said +₹2,032 on a position down ₹651, from the r-carry forward |
| **Headlines are not an event calendar** | 78% of days flagged; 44% even when tightened and corroborated (1.3) |

Executable guards, so none of the above can silently regress: `resolveWeeklyExpiryWeekday`
(refuses an `ASSUMED` weekday), `resolveListedExpiry` (refuses an unlisted expiry),
`resolveOptionExpiryInstant` (a date-only expiry means 15:30 IST), `assertCalendarStorable`,
`assertSnapshotStorable`, the premium-geometry check in `mapIdeaToOptionBuyerFill`, and the
`beatsTrivial` gate checking both accuracy and macro-F1.

---

## 4. Closed since 2026-08-04

### 4.1 Options are priced from the observed book, not the model

Both legs now come from the chain where a snapshot covers the contract:

| | source | verified value |
|---|---|---|
| entry fill | observed **ask** | 752.75, `fillSource: OPTION_CHAIN_QUOTE` |
| live mark | observed **mid** | 748.25, `source: OPTION_CHAIN_MID` |
| exit | observed **mid** | 748.25 booked against a requested `1`, so the server mark wins |

**The entry deliberately takes the ask, not the mid.** A buyer pays the offer. Filling at the
mid would understate the entry by half the spread on every trade, and spread is the cost that
decides whether an options edge exists at all. The **−₹67.50** a fresh 1-lot position shows is
therefore real — the cost of crossing — where the **−₹329.55** it replaced was the model
being wrong. Do not "fix" the residual by moving to the mid; that hides a cost measured as
decisive.

Stop and target are repriced on the IV solved from the observed mid, so all three premiums
share one volatility surface. The model remains the fallback for contracts no snapshot
covers, which is most single-stock strikes.

Verified live on an open/close cycle: `solvedDelta` on the entry record and the live
valuation's delta agree to six decimals (0.529211), because both come from one solver.

### 4.2 The phantom trades no longer feed metrics

Migration 040 added `excluded_from_evidence`, honoured in `getPaperAccountFullSummary` and
six aggregates in `postgres-paper-trade-repository`. The account reported a 212.50% return
and a 100% win rate from two trades booked on a BANKNIFTY expiry that never existed; it now
reports **1 closed trade at +7.94%**. The rows were deliberately not rewritten — their expiry
is the record of the defect.

### 4.3 One risk-free rate

`RISK_FREE_RATE = 0.065` in `pricing/domain/constants.ts`, imported by all seven consumers.
Previously 0.07 in the paper-trading paths and 0.065 in the chain paths, so an option was
priced at entry with one and marked with the other.

### 4.4 Expiry correctness, end to end

- **BANKNIFTY has no weekly series** (migration 038). NIFTY50 is weekday 2 `CONFIRMED`;
  monthly-only underlyings are NULL. This also unblocked NIFTY50 straddle pricing.
- **A caller-supplied expiry is checked against the provider's calendar** (migration 039,
  `option_expiry_calendar`). BANKNIFTY 2026-08-11 → 422 `EXPIRY_NOT_LISTED`, naming "no
  weekly series"; a listed expiry passes. Fail-closed: no calendar means no option entry.
- **A date-only expiry means 15:30 IST**, not midnight UTC, which had force-settled positions
  at the pre-open of expiry day against the prior session's spot — 64.40/contract on the one
  position that reached expiry.
- **Chain expiries no longer shift a day off-container.** `latestSnapshot` mapped
  `row.expiry_date as Date`, and node-pg returns DATE as *local* midnight, so on an IST host
  a stored 2026-08-25 read back as 2026-08-24 — every displayed expiry off by one and every
  IV and greek solved on a tenor 15.5 hours short. It looked correct inside the API container
  only because that container runs UTC, so the bug depended on where the code ran. Now routed
  through the existing `fromDateColumn` helper.

### 4.5 Collection coverage and auth health

`OPTION_CHAIN` collects **NIFTY50, BANKNIFTY, SBIN, RELIANCE** every 15 minutes, 9–15 IST, so
the fail-closed expiry gate does not refuse equity underlyings. `assessFyersAuthHealth` runs
from the scheduler, reads `scheduled_job_runs` failures, and logs at error level before the
15-day refresh token lapses. Remaining gap in 1.5.

### 4.6 Both databases bind to localhost

`127.0.0.1:5432:5432` and `127.0.0.1:5433:5432`.

---

## 5. Reference

Commands assume repo root.

```bash
npm run db:migrate --workspace @ai-quant-lab/api
```

```bash
npm run data:collect:option-chain --workspace @ai-quant-lab/api -- --underlyings=NIFTY50,BANKNIFTY,SBIN,RELIANCE
```

```bash
docker compose -f docker-compose.v2.yml build api-v2 web-v2 && docker compose -f docker-compose.v2.yml up -d api-v2 web-v2 scheduler-v2
```

Rebuilding matters: `--force-recreate` alone does **not** rebuild images, so `build` must run
first or the containers come back on the old code. And a chain mark is only used within 40
minutes of its observation, so verifying option marking outside market hours needs a fresh
collection run first.
