# Pre-registration commit map (2026-10-25)

The pre-registration documents of 2026-10-25 were first committed locally, before each test was run, and cite those commit hashes. They were pushed afterwards by cherry-picking the same five commits onto `feature/stock-intelligence-m01`, which gave them new hashes. The documents and the script were **not edited** in the move: their content is identical to the locally frozen versions. The author dates of the pushed commits are the original local dates, which are the order of events.

| Document | Hash cited in the documents (local, before the test was run) | Hash on this branch |
|---|---|---|
| `2026-10-25-gold-dxy-residual-preregistration.md` | `49ff73fa` | `c558d157` |
| `2026-10-25-implied-move-exhaustion-preregistration.md` | `021884c1` | `9c35b93e` |
| `2026-10-25-gold-compression-breakout-preregistration.md` | `def55b61` | `0f9dab14` |
| `2026-10-25-hard-gate-closed-trades-preregistration.md` | `ccc10b9e` | `5b569549` |
| `2026-10-25-hard-gate-amendment-1.md` and `research-scripts/2026-10-25-hard-gate-forward-rerun.py` | `691669e0` | `66d326d2` |
| `2026-10-25-scalp1m-v9-stopping-rule.md` (approved by the operator on 2026-10-25; not a research test but fixed before any v9 trade) | `d2d03304` | `55e9668c` |

To check that a document is unchanged since it was frozen, compare it with its version in the commit listed in the last column; any later edit shows in `git log -- <path>`.

The local hashes remain in the repository's object store of the machine where the work was done but are not on the remote.
