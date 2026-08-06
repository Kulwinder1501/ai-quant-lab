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
cd apps/api && npm run build && npx vitest run
```

`npm run build` rather than `npx tsc --noEmit`, because the shared packages emit `dist` and
the API typechecks against it. On a fresh clone, or after deleting `dist`, a bare
`npx tsc --noEmit` reports dozens of "Cannot find module '@ai-quant-lab/pricing'" errors that
are an artefact of the unbuilt package, not of the tree. `npm run build` builds both packages
first.
Expect a clean typecheck and **605 passed / 75 files**.

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
| HEAD | `5859121`+ on `feature/champion-challenger` |
| migrations | through **043**; next is **044** |
| system of record | **v2, port 5433**. v1 (5432) is a read-only audit trail |
| paper trades | **3 rows, 2 excluded** — both phantom-expiry, kept as the defect record |
| option chain history | begins **2026-08-04**. Forward-accumulating, no backfill exists |
| both databases | bound to `127.0.0.1` |

---

## 1. Open items

### 1.1 Fyers refresh can refuse with code -16, and everything Fyers-dependent stops

Hit 2026-08-05 mid-backfill:

```
Fyers token refresh failed (HTTP 400, code -16).
Refresh token API is currently disabled to comply with SEBI regulations.
```

**It was transient.** `last_refreshed_at` shows a refresh succeeding 19 minutes later, which
cleared `last_error` and rolled the window forward. So refresh does work; it can simply refuse,
and while it refuses every Fyers path fails — collection, the option-chain expiry gate, the
tick stream.

I first recorded this as "the refresh API is disabled, renewal is manual only" and advised
against consolidating onto Fyers on that basis. That was an overstatement from a single
19-minute window, corrected here and in the memory. Access tokens were observed lasting ~8
hours (06:27 → 14:27, then 14:46 → 22:46 UTC).

What still holds:

- **A refusal is silent unless something watches the right clock.** While it lasted,
  `refresh_token_expires_at` read 2026-08-20 and the credential looked healthy. Fixed in 4.13.
- **It is the most likely cause of the OPTION_CHAIN and EOD_PIPELINE failures** in 1.5.
- **Recovery is `npm run data:auth:fyers`** when refresh keeps refusing.

A **bounded retry** now covers the short version of this (4.14): three attempts, 2s then 6s,
and only for failures that could plausibly clear — code -16, 429, 5xx, or a request that never
reached the provider. An unrecognised code is treated as terminal, because retrying it spends
the budget a real blip needs and walks into the 429 the provider returns after about a dozen
rapid calls.

Still open: **the retry does not cover a long outage.** The observed refusal lasted 19 minutes;
the budget is about 8 seconds, because it runs while the credential row is locked and every
other Fyers caller waits behind it. A refusal spanning the session still loses option-chain
intervals permanently, and still needs 4.13 to raise it and a human to run `data:auth:fyers`.

### 1.2 The entry gate cannot check events, and cannot check volume on intraday index ideas

`validateOptionsEntry` runs on every option entry and refuses on confidence, falling open
interest, spread over 3%, sub-1-DTE at low confidence, delta under 0.40, and now a
zero-volume source bar. What remains unevaluated is reported on every trade rather than
passed over in silence:

```
"unchecked": [
  "Macro events: no scheduled-event calendar exists, so event risk was not screened.",
  "Volume confirmation: BANKNIFTY 15m carries no volume in this dataset, so a zero
   cannot be read as absent participation."
]
```

Events are 1.3 below. The volume line is a **provenance** limit, not a wiring gap, and the
earlier version of this file mis-attributed it. Measured 2026-08-05 on stored BANKNIFTY bars:

| timeframe | source | bars | with volume |
|---|---|---|---|
| 15m | yahoo | 1,069 | **0** |
| 5m | fyers-api-v3 | 10,725 | **10,717** |
| 1d | yahoo | 884 | 875 |

Intraday index volume is *not* unavailable. **Fyers supplies it at 5m (99.9%)**; 15m belongs
to Yahoo under the provenance split, and Yahoo carries none. So this is not "wait for the
provider" — an idea raised on a **5m** bar is volume-checked today, with no change to any
code, because the probe is per instrument and timeframe. A 1d-sourced idea is checked too:
verified live, `sourceCandleVolume: 158800`.

What would close it: raise option ideas from a 5m Fyers series rather than 15m Yahoo. That is
an idea-generation decision, not a gate change, and it interacts with the settled note in 3 —
train on futures rather than spot, or a volume feature becomes a date proxy.

Do not "fix" this by removing the `unchecked` entries, and do not make the route substitute
the latest bar for the idea's own `source_candle_id` — that would judge an older idea on
information it never had. A gate that reports `isValid: true` while silently skipping factors
is the exact failure this project has already paid for twice: once with `greeks.price`, once
with guards written `x !== null && x !== undefined` against fields that did not exist.

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

### 1.4 The dashboard shows fabricated macro events

**Resolved 2026-08-06.** `upcoming-events.tsx` no longer renders invented CPI/FOMC
countdowns. It now lists stored option expiries from `/option-chain` and, separately,
keyword-matched macro *headlines* from `/macro-events`, labelled as not a scheduled
calendar. The heat strip next to it uses live market-watch session returns instead of
`Math.random()` cells.

A true economic/earnings calendar remains out of scope until a scheduled-event feed
exists (see 1.2).

### 1.5 Nothing *sends* a job-failure alert

Failures are now diagnosable (4.8) and **readable** (4.10): `GET /api/v1/health/jobs`
answers 503 with a `criticalFailures` list. What is missing is a sender — that needs a channel
and credentials, which belong to the operator, not to an agent. Point an uptime check at that
endpoint and the loop closes.

Polling it immediately surfaced failures nobody had noticed: **EOD_PIPELINE ×1** and
**INSTITUTIONAL_FLOWS ×3**, on top of the three OPTION_CHAIN failures already known. Their
`lastError` is still the old bare exit code, because they predate the capture in 4.8.

Option-chain failures are treated as critical because that series is forward-accumulating with
no backfill, so a lost interval is lost permanently — the 2026-08-05 morning session
(09:15–11:15 IST, plus 05:45, 06:00 and 06:15 UTC) is gone and cannot be reconstructed.

Deliberately **not** added: an immediate in-run retry. The provider answers 429 after roughly
a dozen rapid calls, so retrying hard against a rate limit makes the outage worse, and the
15-minute cron is already a retry that costs one interval.

### 1.6 A BANKBEES/NIFTYBEES 5m TCN window must start no earlier than 2020-01-01

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

The gate already refuses a 2019-reaching window with `WINDOW_ZERO_VOLUME`, and now **names the
year to start from** rather than leaving it to be rediscovered: it measures zero-volume per
year inside the window and reports the earliest year after which every later year is clean, or
says outright that no start would help. So the remaining work is only to pick the window when
that track is built.

| series | bars | sessions | range |
|---|---|---|---|
| NIFTYBEES 1m | 331,516 | 888 | 2023-01-02 → 2026-08-03 |
| NIFTYBEES 5m | 140,524 | 1,882 | 2019-01-01 → 2026-08-04 |
| BANKBEES 1m | 331,888 | 889 | 2023-01-02 → 2026-08-04 |
| BANKBEES 5m | 140,517 | 1,882 | 2019-01-01 → 2026-08-04 (use `--from 2020-01-01`) |

No BANKBEES training pipeline exists yet — `train_tcn.py` and `train_stack.py` still hardcode
`AUTHORIZED_SYMBOL = "NIFTYBEES"`. A note for whoever builds that track, not a change made to
either file.



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

### 4.6 One pricing engine, in `packages/pricing`

`apps/web/src/lib` held its own copy of the engine and the IV solver. Textually they had
barely drifted — one import extension — but **behaviourally they had**: the client re-solved
IV and greeks against **raw spot** while the server had moved to the put-call-parity forward.
On a live BANKNIFTY 57700 CE that is delta 0.61 against 0.53, and it showed as the number
changing the instant a tick arrived, because the client re-prices on the SSE tick stream
between 15-minute snapshots.

Deleting the client copy was not an option: that live repricing is real work the snapshot
endpoint cannot do. So the engine, the IV solver and `RISK_FREE_RATE` now live in
`@ai-quant-lab/pricing`, imported by both apps, and the client prices against
`impliedForwardByExpiry` from the API response.

Two things this had to get right, both of which bite silently:

- **The package ships built JavaScript, not source.** `main` pointing at a `.ts` file
  resolves fine under `tsc` and then fails at runtime under `node dist/server.js`.
  `packages/contracts` has exactly that shape and has never been caught, because nothing
  imports it.
- **Both Dockerfiles copy `packages/pricing`** in the builder and runner stages, and the
  API's `build` script builds the package first. Missing either produces an image that
  builds and then cannot start.

Verified: api tsc 0, 563 tests pass, `next build` succeeds, both images build, and the
running container serves the chain endpoint with delta 0.529211 — identical to before the
extraction. The engine's tests stay under `apps/api`, so the API suite now guards the web
client's pricing too.

### 4.7 Scheduled-job failures record why

`runCommand` used `stdio: "inherit"`, so a child wrote straight to the scheduler's streams and
nothing was kept. A FAILED row therefore held only
`npm run data:collect:option-chain -- ... exited with code 1`, which is why three real
OPTION_CHAIN failures are permanently undiagnosable.

Output is now piped, forwarded unchanged to the container log, and the last 4,000 characters
are kept for the failure message. stderr is preferred with stdout as a genuine fallback,
because this project's CLIs report failures as JSON on stdout via `console.info` — a
stderr-only capture would have recorded nothing for exactly the jobs most likely to fail. A
signal is reported as a signal rather than `exit code null`, and no output at all says so
outright instead of leaving an empty tail.

`close` rather than `exit`, so the streams have flushed and the captured tail is complete when
the message is built.

Four tests spawn real failing processes to prove the capture. The cron window (9–15 IST) had
passed when this shipped, so it has not yet been exercised by the live scheduler.

### 4.8 The live streamer is typed, validated and tested

Was 128 lines with `private socket: any`, no test, and three defects behind that:

- **A tick could carry `undefined` as a `number`.** `ltp: message.ltp ?? message.last_price`
  is typed `number`, so a payload with neither produced a Tick whose price was undefined. It
  reached the browser, made the chain's spot undefined, and stopped repricing in silence.
  `parseTick` now returns null for anything without a symbol and a positive price, and a zero
  bid or ask reads as absent rather than as a price of zero.
- **Every tick was logged at info level.** `console.log("[RAW TICK]", …)` per message floods a
  session's container log and buries everything else. Unparseable messages are now counted and
  the total is reported on close, via `droppedMessageCount()`.
- **Reconnect was a fixed 5 seconds, uncapped.** Fyers auth lapses every 15 days with no
  non-interactive path, and each attempt calls `getAccessToken()`, which takes a row lock and
  can spend a refresh against the provider. An overnight failure was thousands of those.
  Backoff now doubles from 5s to a 5-minute ceiling, and resets on a successful `connect`
  event rather than on an attempt.

The vendor socket has a narrow `FyersDataSocket` interface and is injectable, so 17 tests
cover parsing, backoff, resubscribe-on-reconnect, and that nothing is sent before the
handshake completes. `isConnected` is optional on the vendor object, and its absence is no
longer read as connected.

### 4.9 An IV percentile exists, and refuses honestly until it can answer

Factor 5 of the checklist — is IV high *relative to its own history* — had no answer at all.
`atmImpliedVolatilityPercentile` on the chain endpoint now answers it, or says exactly why it
cannot:

```json
{ "measurable": false, "reason": "INSUFFICIENT_HISTORY",
  "observedDays": 2, "requiredDays": 20,
  "explanation": "... history is forward-accumulating and cannot be backfilled, so this
                  resolves with time." }
```

The percentile is over **one value per day**, and that is the whole design. Fifteen-minute
snapshots are heavily autocorrelated — 25 observations from one session are one day's
information, not 25 independent samples — so ranking against raw observations would report a
confident percentile built from two days, and would call an ordinary IV extreme. It needs 20
distinct days, so with history from 2026-08-04 it starts answering around **2026-09-01**.

Each historical day is solved from that day's last snapshot, its own spot, its own ATM strike
and the nearest expiry only. A fixed strike across months would measure moneyness drift, and
mixing tenors would rank front-month IV against far-month, which is a different quantity.
Losing the history read cannot cost the caller the live chain.

### 4.10 Job failures are readable from outside the process

`GET /api/v1/health/jobs?lookbackHours=48` returns per-job failed/completed/running counts,
the last failure time and the captured `lastError`, and answers **503** when a job flagged
critical (OPTION_CHAIN, EOD_PIPELINE) has failed. It deliberately sends nothing itself: that
needs a channel and credentials, which are the operator's to install. Extended the existing
`health.routes.ts` rather than adding a second endpoint.

### 4.11 The verification rows are gone

Migration 042 removes the four synthetic ideas and their four paper trades, in foreign-key
order, scoped to the synthetic marker *and* `excluded_from_evidence` so a real trade cannot be
caught by a mis-set flag. Exclusion kept the metrics honest but left four of seven rows as
scaffolding a reader had to filter by hand.

The two trades booked on the phantom BANKNIFTY 2026-08-04 expiry are deliberately kept. They
record a real defect, and deleting them would erase the evidence rather than the noise.
`paper_trades` is now three rows: those two, still excluded, and one real trade.

### 4.12 One provider per candle series, enforced by the database

The rule was prose in `fyers-historical-data-provider.ts` — the split is by timeframe "so that
no single series is ever half Fyers and half Yahoo" — and enforced only in
`collect-historical-data.ts`. Seeds, the scheduler and every other writer went straight to
`candles`, and the rule was broken exactly as warned:

```
NIFTY50 15m  fyers-api-v3  21,102 bars  2023-01-02 → 2026-06-05   27% with volume
NIFTY50 15m  yahoo          1,069 bars  2026-06-08 → 2026-08-05    0% with volume
```

Migration 043 adds `candle_series_provenance`, one row per (instrument, timeframe) naming the
permitted source, with a foreign key from `candles`. A per-row repository check would mean a
lookup per candle on a 300k-bar backfill; a key costs nothing and covers every write path.
Verified by attempting a Yahoo 15m insert on a Fyers-declared series:

```
ERROR: insert or update on table "candles" violates foreign key constraint
       "candles_series_provenance_fkey"
```

Mixed series: **0**. Reassignment means deleting that series' candles and updating the
declaration — the key blocks the shortcut, so the discipline is no longer something to
remember.

The CLI guard now **reads that table** rather than a static map. Keeping a map was briefly a
second source of truth and immediately misfired: setting it to "15m is Fyers" made the CLI
refuse Yahoo 15m for equities whose declaration had legitimately stayed Yahoo. Ownership is
per series, so only the table can answer it. The static policy still applies to a series with
no declaration, so a new one lands on the intended provider.

**15m ownership ended up split, deliberately:**

| declared owner | instruments | why |
|---|---|---|
| `fyers-api-v3` | 6 — NIFTY50, BANKNIFTY, NIFTYBEES, ASIANPAINT, AXISBANK, BAJFINANCE | deep history and real index volume; 9,830 bars each from 2025-01-01 |
| `yahoo` | 19 — the remaining equities, and INDIAVIX at every timeframe | full equity volume, no auth dependency |

The intent was all of 15m on Fyers. The token died partway through (1.1), and Yahoo 15m is
capped at **60 days** — measured, `--from=2026-06-01` is refused as outside the window. So the
19 were restored from Yahoo at ~1,050 bars each. Finishing the move needs a live token:

```bash
npm run data:collect:historical --workspace @ai-quant-lab/api --   --instrument=SBIN --provider=fyers --timeframe=15m --from=2025-01-01 --to=<today>
```

Delete the Yahoo rows and update the declaration first, or the key refuses the insert.

### 4.13 The auth-health check watches the access token, not the refresh window

`assessFyersAuthHealth` took its verdict from `refresh_token_expires_at` with a two-day window.
That reports OK whenever the *refresh* credential is comfortable, which is exactly the state
during a code -16 refusal: refresh window a fortnight out, access token dead, every job
failing.

It now reads `access_token_expires_at`, and the question is cadence-aware rather than a generic
window. The check runs once at **08:00 IST**, before the 09:15 open, so what matters is whether
the token survives to the **15:30 IST close** — a token dying at noon strands the afternoon,
and option-chain intervals cannot be backfilled. `mustRemainValidUntil` is passed in by the
scheduler so session-calendar knowledge stays out of the domain function, and is omitted after
the close, when a token expiring today has stranded nothing.

`checkCredentialHealth` now returns both clocks. The refresh window is still reported, but only
as context and only when something is already wrong, with the explicit note that it says
nothing about whether the access token is usable right now.

Verified against the live credential: it reports **ERROR** naming the 3 failed Fyers-dependent
jobs, where the old logic would have said OK until 2026-08-20. 10 tests, including that a dead
access token with a fortnight of refresh window still reads EXPIRED.

### 4.14 A refused refresh is retried, briefly and selectively

`FyersRefreshError` now carries whether trying again could help, and `refreshWithRetry` spends
a small budget on the ones that could: **3 attempts, 2s then 6s**.

Two decisions worth keeping:

- **Retryable is an allowlist, not a default.** Code -16, 429, 5xx and a fetch that threw
  before reaching the provider are retried; everything else — including `-371`, the wrong
  appIdHash — fails on the first attempt. Retrying a terminal failure spends the budget a real
  blip needs, and the provider answers 429 after about a dozen rapid calls, so a retry loop
  against a refusing auth endpoint is its own outage.
- **The retry runs inside the `FOR UPDATE` on the credential row, and that is why it is
  small.** Holding the lock is correct — it is what stops two callers each burning a refresh,
  and a caller that waits then gets the fresh token rather than an error — but it also means
  the budget is how long every other Fyers caller is blocked. Retrying for 19 minutes inside a
  row lock would be worse than the failure.

So this narrows the window; it does not remove the failure mode. The final error names the
attempt count, so a `last_error` row distinguishes one refusal from a sustained outage.

13 tests, including that a terminal failure is attempted exactly once and that a valid access
token triggers no refresh at all.

### 4.15 Both databases bind to localhost

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
