# Equity signal study (research only, not part of the app)

Run from this folder. `python fetch_universe.py` downloads daily Yahoo history for 49 NSE large caps into `sr_data/`
(1.2 s between requests; research use, same Yahoo risk the owner accepted). `python sr_study.py` runs the support /
resistance event study and the monthly cross-section; `python sr_study2.py` re-checks the level results with
month-clustering and without the 2008-09 and 2020 crashes. Parameters are fixed in the scripts (not tuned).
Results and caveats: `docs/2026-10-17-equity-signal-research.md` section 3. Survivors only; no costs in the numbers.
