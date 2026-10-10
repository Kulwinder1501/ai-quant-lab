# 2026-10-10 audit fixes: integration summary, deploy order and open items

This is the index for the audit-fix batch committed in `df3d8ca`. Per-area detail lives in the
documents linked below; this page records what was decided while integrating them, how it was
verified, and what has NOT been done.

**Nothing in this batch has been deployed, and no migration or data rebuild has been run against
the live database.** Research posture is unchanged: no live registration, kill-switch
`ORDERBOOK01_LIVE_GATE_ENABLED` defaults OFF.

## 1. What was fixed, by area

| Area | Headline defects fixed | Detail |
|---|---|---|
| Open interest / PCR / "GEX" | Monthly symbol tokens (`26SEP`) were matched against weekly expiry dates, so the monthly book was filed under the weekly date. PCR joined across expiries/sessions. "GEX" was not gamma exposure. | `docs/2026-09-29-iv-compression-volatility-expansion-check.md` (amended), migration 131 |
| Order flow / liquidity | Depth lookup used a symbol that never matched (0 rows; all 139 stored order-book verdicts NEUTRAL). Contact labels looked ahead. Candidates were re-registered on every bar after a breach. DI imbalance sign was near-constant per day. | `docs/2026-10-10-orderbook-liquidity-audit-fixes.md`, migration 132 |
| Pattern engine | `candlestick-v1` ignored flat bars and session boundaries, had no `known_at`, awarded +20 to neutral patterns and picked `patterns[0]` (alphabetical). | `docs/2026-10-10-pattern-recognition-v2-redetection.md`, migration 133, `scripts/redetect-candlestick-v2.ps1` |
| Volatility | Straddle implied move used a calendar clock against a trading-time forecast (gate 2.36x too easy). Flat holiday bars poisoned ATR. IV percentile mixed tenors and bases. VIX was compared with a differently-defined ATM IV. | `docs/2026-10-10-volatility-audit-fixes.md` |

## 2. Decisions made during integration

1. **Migration numbering.** `130-opening-gap-predictions` already existed and the runner test
   requires gapless ascending numbers, so the new migrations are:
   - `131-repair-mislabelled-monthly-expiry-rows`
   - `132-contact-label-versioning`
   - `133-candlestick-v2-pattern-definitions`

   All three are registered in `migrations/index.ts`.
2. **IV percentile wired into the entry gate.** `PrepareOptionEntry` now computes the tenor-matched
   percentile for the settlement expiry (`resolveIvPercentile`) and passes `intendedExpiryDate`
   and `ivPercentile` to `validateOptionsEntry`. If the chain reader has no `dailyAtmQuotes`, or
   the reading is unmeasurable, the percentile is `null`, which the validator records as
   *unchecked*, never as passed.
3. **Day-over-day OI decline is informational, not a veto.** `openInterestChange` is the vendor's
   `open_interest - previous_open_interest` (change versus the previous day's close, not intraday
   flow), and declines are routine near expiry. Nothing in this repo shows a decline predicts worse
   entries. The old gate test was replaced; the informational wording is asserted in
   `options-entry-validator.test.ts`.
4. **Frozen research strategy left untouched.** The pattern work also modified
   `momentum-scalp-pattern-strategy.ts` (support/resistance lookback). That file is frozen by the
   scalp research harness (checksum test), so the change was reverted and saved as
   `docs/patches/2026-10-10-scalp-sr-lookback-needs-new-research-version.patch`. Applying it
   requires a new research strategy version and checksum.
5. **Quarantine self-check no longer depends on a defect.** `autonomous-v2-quarantine.test.ts`
   asserted the V1 agent still contained `patterns[0]`. That defect is fixed, so the regex is now
   proven against an inline fixture.

## 3. Verification (2026-10-10)

- `npx tsc --noEmit -p apps/api`: clean.
- `npx vitest run` (apps/api): 327 files passed, 9 skipped; 3,496 tests passed, 65 skipped.
- ML suite in the `aiquantlab-api-v2` image: 527 passed.
- All 135 migrations applied from scratch on a throwaway `pgvector/pgvector:pg16` database.
- Migration 131 exercised on seeded data: a mislabelled monthly row is re-filed onto the monthly
  date, a duplicate whose correct slot was occupied is deleted, a genuine weekly row is untouched,
  and a second run is a no-op.

Not verified: migrations 132/133 against production-sized data (133 backfills `known_at` on the
full `pattern_detections` table inside one transaction; expect a noticeable lock, so run it in a
quiet window), and any behaviour that needs a live Fyers feed.

## 4. Deploy order (needs a decision; not done)

The API container runs `migrate.js` before starting the server, so rebuilding the API applies
131-133 automatically. Rebuilding the scheduler restarts the live bots `AutoBot-IctNifty15m` and
`AutoBot-IctBankNifty5m`; do that at the pre-agreed review point, not before.

1. Rebuild/restart the API (applies 131-133). Check the migration log lists all three.
2. Rebuild/restart the scheduler (new depth lookup, kill-switch guard, volatility gate).
3. Only then run the data rebuilds in section 5.

## 5. Data rebuilds that are NOT run by deploying

| Step | Command / script | Why it matters until it is run |
|---|---|---|
| Re-detect candlestick v2 | `scripts/redetect-candlestick-v2.ps1` | v2 table is empty; consumers read only v2, so there is no candlestick evidence. This is the honest state, not an error. |
| Regenerate liquidity candidates | `generate-liquidity-candidates` | Legacy `v1-legacy` duplicates remain; evaluate only `v2-dedup`. |
| Regenerate contact labels | `generate-contact-labels` | Existing labels are `v1-legacy` (look-ahead); evaluate only `v2-causal`. |
| Recompute depth-sequence flags | `apps/ml/recompute_depth_sequence_flags.py` | Stored `is_regression` markers were wrong. |
| Re-run ORDERBOOK-01 / hybrid / pattern studies | existing run scripts | Earlier conclusions rest on the defective code and must not be cited. |

Any re-run follows the governance already in force: dated amendment, one exploratory run, no
re-scoring of earlier results, pattern weight stays zero until v2 outcomes are re-measured.

## 6. Code gaps

### Closed in the follow-up (2026-10-10, second pass)

- **Point-in-time reads use `known_at`.** The strategy-context pattern/price-action queries gained a
  `known_at <= candle.close_time` guard (they had no time predicate); the backtest repository
  filters `known_at <= cutoff` and deliberately does NOT also require `detected_at <= cutoff`
  (rebuilds bump `detected_at` and would erase history from every replay); the market scanner and
  dashboard queries were aligned. The dashboard now reads the current rule set
  (`candlestickAlgorithmVersion`) instead of hard-coded `candlestick-v1`.
- **`strategy.ts` types.** `ConfluenceSignal` and related types (`NO_DEPTH`, `di_status`,
  `depth_state`, ...) replace the casts and the duplicated inline types in the gate, validator and
  hybrid strategy.
- **`di_tilde` is no longer always null.** The context repository loads the last raw DI of each
  complete prior minute (same IST session, front-month future, strictly before the decision minute)
  and `di_tilde = -(raw_di - mean(history))`. Fewer than 10 minutes of history gives `null` with
  `UNAVAILABLE_HISTORY`, never 0 (same constants as `orderbook_di.py`: 10 min minimum, 30 min
  window). A missing total no longer becomes 0, and the gate needs `di_tilde > 1e-9` so float
  noise on a flat one-sided book cannot fire it. The history query was checked read-only against
  the real schema: valid, uses `depth_frames_symbol_received_idx`, under 1 ms.
- **Depth-flag recompute in research scripts.** `run_hybrid_confluence_backtest.py` and
  `run_ofi_impulse_oos.py` recompute sequence flags from raw `sequence_no` / `is_snapshot` instead
  of trusting the stored `is_regression`.
- **Baseline.** `train.py` (and `backfill_volatility_shadow.py`) report a train-fitted
  time-of-day-stratified majority baseline alongside the trivial one, and promotion now requires
  beating the stronger of the two (`DID_NOT_BEAT_STRONGEST_BASELINE`).
- **Overnight labels.** Intraday forward labels must lie inside the source bar's IST session;
  rows whose horizon passes the close get no label (`session_forward.py`). Daily bars unchanged.

Behaviour changes that mean earlier results from the affected scripts must be re-run under a new
pre-registration: STRUCTURE-01 calibration (events with no in-session forward bar are dropped
rather than recorded NEUTRAL), and any promotion decision that relied on the trivial baseline.

### Still open

- `momentum-scalp-pattern-strategy.ts` (and the other frozen `momentum-scalp-*` strategies,
  `trend-breakout-strategy.ts`) default to `candlestick-v1`. Frozen research versions cannot be
  edited in place; they need new research versions with new checksums (see decision 4 and the
  patch file). The ML `contracts.py` / `features.py` / `sequence_inference.py` defaults and the
  `run-shadow-decisions.ts`, `run-scalp-research-harness.ts` and `verify-live-backfill-parity.ts`
  layer lists also still name `candlestick-v1`; they should move together with those new versions,
  after v2 re-detection.
- `run_hybrid_confluence_backtest.py` still takes the nearest depth frame across all symbols for
  the day (flags are now recomputed per symbol); restricting to the front-month contract is a
  separate fix.
- `train_tcn.py` still uses its own trivial baseline.
- The API depth history does not drop duplicate/regression frames the way the Python path does;
  taking the last frame per minute makes this mostly harmless.
- `iv_compression_signal_check.py` imports `option_chain_pcr.py`; the two must always land together.

## 7. Housekeeping

- A temporary `/tmp/phasec` directory (code and output only, no credentials) remains in the
  `ai-quant-lab-scheduler-v2` container.
- The old database password is in git history; rotate it.
- Working-tree LF/CRLF warnings under `core.autocrlf=true` are line-ending noise only.
