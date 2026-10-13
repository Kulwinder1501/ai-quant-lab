# Market Context observation protocol (`mkt-ctx-v1`)

**Date frozen:** 2026-10-13  
**Status:** FROZEN. Observation + shadow veto only; nothing here changes whether or how a trade is taken.  
**First consumer:** AutoBot-Sniper (`momentum-scalp-pattern`) only.  
**Code:** `apps/api/src/modules/market-context/domain/market-context-map.ts`, `digest-higher-timeframes.ts`, `apps/api/src/modules/paper-trading/application/market-context-observation.ts`.

## 1. Why this exists

Sniper enters on a candlestick + soft score ≥ 5. Support/resistance are bonus points; `enableSrVeto` and `requireStrictTrendAlignment` default off. Live idea generation attached slower bars as `higherTimeframeContexts` but never digested them into `higherTimeframes`, so pattern confluence HTF scores stayed 0.

This protocol builds a single point-in-time **Market Context Map** (trend + day extremes + S/R + location + competing level hypotheses), stamps it on every Sniper open, and records a **shadow veto** (would-have-blocked) without refusing the trade.

## 2. Feature contract (`mkt-ctx-v1`)

### Trend

| Field | Definition |
|---|---|
| `tf5` / `tf15` | `UP \| DOWN \| MIXED` from digested HTF context: strict = close vs EMA **and** Supertrend agree when both exist; soft = either. Stamp stores both. |
| `sessionBias` | `UP` if close > session open and close ≥ session VWAP proxy (typical of bars so far); `DOWN` if both below; else `MIXED`. |
| `htfAgreement` | `AGREE` / `DISAGREE` / `MIXED` / `UNKNOWN` vs the trade's underlying direction using soft TF biases. |

### Levels (index points; distances also in ATR)

| Level | Definition |
|---|---|
| Session high / low | Extremes of completed RTH 1m bars today (IST) up to decision time |
| Prior day high / low / close | Previous IST session OHLC |
| Opening range high / low | First **15** completed minutes from 09:15 IST |
| Prior VA H / L / POC | Optional; when supplied by caller from `frvp-rows48-v2` prior session — never recomputed under a second definition |
| Nearest swing S/R | From `priceActionEvents` SUPPORT / RESISTANCE |

Proximity band: **1.5 × ATR** (same as Sniper `maxSrDistanceAtr`).

### Location + hypothesis

`location`: `AT_RESISTANCE | AT_SUPPORT | INSIDE_RANGE | BREAKING_HIGH | BREAKING_LOW | FAR`

`hypothesis` (descriptive only):

- `FADE` — price probed beyond the nearest level then reclaimed inside within the last 30 completed 1m bars
- `BREAK` — price has held outside the nearest level for ≥ 15 consecutive completed 1m closes
- `AMBIGUOUS` — otherwise

Near a level, direction is **not** implied by the level alone. Fade and break are competing labels to be measured.

### Shadow veto (log-only)

`wouldBlock: true` when any of:

- `LONG_AT_RESISTANCE` — underlying LONG, location AT_RESISTANCE, hypothesis ≠ BREAK  
- `SHORT_AT_SUPPORT` — underlying SHORT, location AT_SUPPORT, hypothesis ≠ BREAK  
- `HTF_DISAGREE` — `htfAgreement === DISAGREE`  
- `AMBIGUOUS_AT_LEVEL` — at support or resistance with hypothesis AMBIGUOUS  

**Must never** block, resize, or delay an entry.

## 3. The stamp

Appended to `paper_trades.notes` for Sniper opens (before `FRVP_OBS` so FRVP stays last):

```
 Observed (log-only, no effect on entry): MKT_CTX {json}
```

Parse with `MKT_CTX (\{.*?\})(?:\s|$)` or extract via `MKT_CTX `. Fields include `v`, `dq`, trend, levels, `loc`, `hyp`, `nearest`, `dir`, `wouldBlock`, `vetoReasons`, `sentence`.

`dq`: `PASS` | `FEATURE_UNAVAILABLE` | `FAIL`.

## 4. Sample rule and decision (review gate)

**Judge once** when at least **80** closed Sniper trades with `MKT_CTX` and `dq = PASS` exist, and at least **25** of them have `wouldBlock = true`.

Primary: difference in mean net R (`realized_pnl / planned risk`) between `wouldBlock = false` and `wouldBlock = true`, permutation within session day, alpha 0.05, one-sided (blocked should be worse). Day-clustered bootstrap interval.

- **PASS:** blocked group materially worse; authorises a **separately dated** protocol to turn selected vetoes into live Sniper gates (still not automatic).  
- **FAIL:** powered sample, blocked not worse — do not promote these vetoes.  
- **INCONCLUSIVE:** sample rule unmet by 2026-12-31, or coverage of `dq = PASS` under 70%.

Until then: interim counts only. No live gate. No retuning of proximity/OR width after looking at outcomes.

## 5. Review query

```sql
SELECT t.id, t.opened_at, t.realized_pnl, t.initial_risk_distance, t.quantity,
       (substring(t.notes from 'MKT_CTX (\{.*?\})(?:\s|FRVP|$)'))::jsonb AS mkt
  FROM paper_trades t
  JOIN paper_accounts a ON a.id = t.account_id
 WHERE a.name = 'AutoBot-Sniper'
   AND t.notes LIKE '%MKT_CTX%'
   AND t.status = 'CLOSED';
```

Machine review helper: `apps/api/scripts/review-mkt-ctx-shadow.ts` (counts only until the sample rule is met).

## 6. Change control

Changing level definitions, proximity, OR minutes, veto reasons, or the sample rule needs a dated amendment **before** affected outcomes are examined.
