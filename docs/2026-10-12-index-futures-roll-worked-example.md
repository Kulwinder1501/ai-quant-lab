# Index futures roll worked example — FRVP-MSP Phase 0

**Experiment:** `FRVP-MSP-P0-2026-10-12`  
**Rule (frozen in preregistration):** at each IST session start, among listed monthly `FUTIDX` contracts with expiry ≥ session date, prefer the contract with highest **prior completed session** traded volume; roll when the next contract’s prior-session volume exceeds the current for **two consecutive** completed sessions.

## Contracts registered in lab (2026-10-12 ingest)

| Lab symbol | Fyers id | Underlying | Expiry | 1m bars (ingest) | Notes |
|---|---|---|---|---|---|
| `NIFTY26OCTFUT` | `NSE:NIFTY26OCTFUT` | NIFTY50 | 2026-10-27 | 10780×1m (~10488 vol>0), from 2026-09-01 | Active / history available via Fyers |
| `BANKNIFTY26OCTFUT` | `NSE:BANKNIFTY26OCTFUT` | BANKNIFTY | 2026-10-27 | 10779×1m (~8948 vol>0), from 2026-09-01 | Active / history available via Fyers |
| `NIFTY26SEPFUT` / `BANKNIFTY26SEPFUT` | `NSE:*26SEPFUT` | … | 2026-09-29 | **No** | Fyers history returns HTTP 422 Invalid symbol after expiry |
| `NIFTY26AUGFUT` / `BANKNIFTY26AUGFUT` | `NSE:*26AUGFUT` | … | 2026-08-25 | **No** | Same — expired contracts not served by Fyers `/data/history` |

CLI: `apps/api/src/interfaces/cli/ingest-index-futures-ohlcv.ts` (`cont_flag=0` via `FyersHistoricalDataProvider`).

## Worked example (OCT window)

For session dates from **2026-09-30** through **2026-10-12** (IST), the only ingested monthly futures with volume are the **OCT** contracts. Causal selection therefore returns:

- NIFTY50 → `NIFTY26OCTFUT`
- BANKNIFTY → `BANKNIFTY26OCTFUT`

No two-session volume exceedance vs a next contract is measurable until **NOV** bars are ingested.

## Gap for Phase 0 confirmatory OOS length

Fyers does not return OHLCV for the expired AUG/SEP symbols under the public history API. Longer chronological splits require either:

1. Ingest **NOV+** as they trade, and/or  
2. A licensed historical product that retains expired FUTIDX bars (e.g. NSE Historical Order & Trade / vendor archive).

Until then, Phase 0 confirmatory evaluation is limited to sessions whose prior-session profile can be built from available futures volume (OCT series from first available bar onward).
