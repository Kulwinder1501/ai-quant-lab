# Pending Work — AI Quant Lab

**Written 2026-08-04.** Everything below was verified against the tree and the live v2
database on that date. Where a figure is quoted, it was measured, not estimated.

---

## 0. Verify before you trust

Briefs in this repo have gone stale and cost real time. Check these first, and treat a
mismatch as "this file is older than the tree", not "the tree is broken".

```bash
cd apps/api && npx tsc --noEmit && npx vitest run
```
Expect a clean typecheck and **526 passed / 68 files**.

```bash
py -3.12 -m unittest discover -s apps/ml -p "test_*.py"
```
Expect **`Ran 238 tests ... OK`**.

```bash
git log --oneline -1
```
Expect **`a9bee88`** on `feature/champion-challenger`. **18 commits are unpushed**
(`origin/feature/champion-challenger` is at `d81bde5`).

| | state on 2026-08-04 |
|---|---|
| migrations | through **039**; next is **040** |
| system of record | **v2, port 5433**. v1 (5432) is a read-only audit trail |
| paper trades ever booked | **3** — 2 closed, 1 open, all BANKNIFTY CE |
| option chain history | begins **2026-08-04**. Forward-accumulating, no backfill exists |

---

## 1. Correctness — do these first

### 1.1 Two fictional trades still feed the account metrics

The entire closed-trade history is two BANKNIFTY trades booked against a **2026-08-04
expiry that BANKNIFTY does not list** (it carries no weekly series — every expiry the
provider returns is flagged `M`). Their premiums reproduce the model on a phantom 1.4-day
and 0.7-day tenor against a real tenor of ~22 days, so entry, exit and return are all
fiction.

The gate that would now refuse them exists (§ *Settled*), but **nothing excludes the rows
already written**. Verified live through `/api/v1/paper-accounts/:id/summary`:

| trade | recorded `returnPercent` | real contract |
|---|---|---|
| 57300 CE | **212.50 %** | +38 % |
| 57700 CE | **22.19 %** | +8.7 % |

Rupee P&L is only off by about ±₹1,000, so it looks survivable. It is not: capital at risk
was understated roughly **fivefold**, which is what makes every return percentage
meaningless. A 212 % winner and a 100 % win rate are exactly the numbers that would make a
strategy look validated.

**Why it was left:** the rows were deliberately not rewritten. Their expiry is the record of
the defect, and editing a closed trade's contract would hide it. The fix is to *exclude*,
not repair.

**Where:** `postgres-dashboard-query-repository.ts` (`getPaperAccountFullSummary`),
`paper-account-metrics.ts`. Options, in order of preference:

1. A `data_quality` / `excluded_from_evidence` column on `paper_trades`, set by migration
   for these two ids, honoured by every aggregate. Explicit and auditable.
2. Validate each closed trade's `option_expiry` against `option_expiry_calendar` on read
   and drop unlisted contracts from metrics. Self-maintaining, but silently reclassifies
   rows if a calendar is missing.

Option 1 is the one to build. Option 2 fails closed in the wrong direction.

### 1.2 The risk-free rate disagrees with itself

Two values are live, and an option is **priced at entry with one and marked with the
other**, so a position takes a small step in P&L the moment it opens.

| value | files |
|---|---|
| **0.07** | `paper-trading/domain/option-buyer-fill.ts:11`, `paper-trading/domain/option-mark-to-market.ts:10`, `pricing/application/price-option.ts:8` |
| **0.065** | `market-data/interfaces/http/market-data.routes.ts:23`, `postgres-option-chain-repository.ts:34`, `paper-trade-live-valuation.ts:102` |

I have **not** quantified the step — it is small next to the forward error already fixed in
`27b557f`, but it is a discontinuity with no justification behind it. Pick one constant,
export it from `pricing`, and delete the other five declarations.

Worth knowing while doing this: for a dividend-paying index the *market's* implied drift is
negative (measured −5.96 % annualised on 2026-08-04, from a parity forward 193 points below
spot). Neither 0.07 nor 0.065 describes that. The chain-mark path already sidesteps it by
using the parity-implied forward; the model path cannot, which is the real reason to prefer a
chain mark wherever one exists.

---

## 2. Coverage gaps that will bite quietly

### 2.1 The expiry gate is fail-closed, and two underlyings are not being collected

`resolveListedExpiry` refuses to open an option trade when no expiry calendar exists for the
underlying. That is the intended trade — it costs one collection run, where guessing costs
every number computed from the position. But the scheduled job covers **only NIFTY50 and
BANKNIFTY**:

```
apps/api/src/interfaces/scheduler/scheduler.ts:165   OPTION_CHAIN, */15 9-15 * * 1-5 IST
  --underlyings NIFTY50,BANKNIFTY --strike-count 15
```

SBIN and RELIANCE have calendars only because they were collected by hand on 2026-08-04.
Nothing refreshes them, so **option trades on any underlying outside those two will be
refused** once someone tries. Either add them to the scheduled job or accept that the
equity panel is index-only and say so somewhere the operator will read.

### 2.2 Fyers auth lapses every 15 days, and now that blocks trading

The refresh token is valid 15 days and there is **no non-interactive path** — a human must
log in. When it lapses the `OPTION_CHAIN` job starts failing, calendars go stale, and (via
§2.1) the expiry gate begins refusing legitimate contracts. Before the gate existed a lapsed
token only stopped data arriving; now it stops trades opening.

A stale calendar can only cause **false refusals**, never false admits — expiries are added
and never withdrawn — so the failure direction is safe. But nothing currently alerts on it.
The `scheduled_job_runs` table records failures; nothing reads them.

### 2.3 No IV history, so "unusually high IV" has no answer

Factor 5 of the pre-trade checklist asks whether IV is high *relative to its own history*.
Chain snapshots begin 2026-08-04, so there is no percentile to compute yet and no way to
backfill one — a chain endpoint returns the current book and no historical source exists.
This resolves itself with time and only with time. Do not try to reconstruct it.

### 2.4 No event calendar

Factor 11 (earnings, policy dates, expiry-week effects) has no data behind it at all. A
position can be opened straight into an earnings print with nothing objecting.

---

## 3. Security — the user's actions, not the agent's

### 3.1 The Postgres password is public

The real `POSTGRES_PASSWORD` has been in `origin/main` since commit **`5ecf97a`**, and the
repository is **public**. **Rotation is the user's action.** An agent must not rotate or
install credentials.

`.env.example` is git-tracked and must contain only empty placeholders. Real values live in
`apps/api/.env` (gitignored).

### 3.2 Both databases bind 0.0.0.0

`docker-compose.yml` and `docker-compose.v2.yml` publish `5432` and `5433` on all
interfaces. Consider `127.0.0.1:5433:5432`.

---

## 4. Settled — do not redo

Measured negative results. Re-deriving these is the most likely way to waste a session.

| finding | evidence |
|---|---|
| **Direction prediction has no edge** | CPCV accuracy loses 93 % of splits; 20× more data moved macro-F1 by 0.0004 |
| **Volatility expansion does** | macro-F1 ~0.44 vs trivial ~0.17, wins both metrics on 100 % of splits, holds across walk-forward folds. **This is the live track** |
| **RAG retrieval has no signal** | k-NN over real market context loses to trivial on accuracy and is matched by shuffled labels. Do not build the embedding pipeline |
| **Momentum-scalp has no edge** | loses on 1d even frictionless; the low-volatility edge decays out of sample |
| **Long straddles need 44.3 % EXPANSION precision** | gross edge +0.117 % of spot, dies at ~1.09 % cost per leg. Measured spreads: NIFTY 0.24 %, SBIN 2.24 % — the signal works where it cannot be traded cheaply |
| **BANKNIFTY is monthly-only** | provider flags every expiry `M`. NIFTY50 has weeklies. Every NSE expiry is a **Tuesday** |
| **Model marks can invert P&L sign** | on the live 57700 CE the model said +₹2,032 on a position down ₹651, from the r-carry forward. Trust `OPTION_CHAIN_MID`, treat `OPTION_MODEL` as unverified |

Guards now enforcing the above, so they cannot silently regress:
`resolveWeeklyExpiryWeekday` (refuses an `ASSUMED` weekday), `resolveListedExpiry` (refuses
an unlisted expiry), `resolveOptionExpiryInstant` (a date-only expiry means 15:30 IST, not
midnight UTC), `assertCalendarStorable`, `assertSnapshotStorable`, and the `beatsTrivial`
gate checking both accuracy and macro-F1.

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

Rebuilding matters: `--force-recreate` alone does **not** rebuild images, so `build` must
run first or the containers come back on the old code.
