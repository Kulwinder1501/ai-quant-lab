# ML workspace

The local research pipeline lives here: fixed feature construction, purged
chronological validation, three reproducible model families, checksum-verified
artifacts, explicit promotion, and explainable inference. `predict.py` records
one cutoff-bound model prediction only; it never creates a trade idea, paper
fill, broker connection, or real order.

Three algorithms share one pipeline contract (`imputer` → `scaler` →
`classifier`) and one promotion gate, selected with `--algorithm`:

| Choice | Estimator | Explained by |
| --- | --- | --- |
| `logistic` (default) | scikit-learn `LogisticRegression` | selected-class linear terms |
| `xgboost` | `XGBClassifier` | exact TreeSHAP contributions |
| `lightgbm` | `LGBMClassifier` | exact TreeSHAP contributions |

Install `apps/ml/requirements.txt`, then use `npm run ml:test`,
`npm run ml:train -- --help`, and `npm run ml:predict -- --help`. The operating
guides are [`docs/phase-10-machine-learning.md`](../../docs/phase-10-machine-learning.md),
[`docs/phase-11-explainable-ai.md`](../../docs/phase-11-explainable-ai.md), and
[`docs/phase-19-gradient-boosting-models.md`](../../docs/phase-19-gradient-boosting-models.md).
