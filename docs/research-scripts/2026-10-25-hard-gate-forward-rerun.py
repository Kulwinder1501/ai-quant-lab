"""Forward re-run of the stop-outside-normal-noise test on paper trades opened on or after 2026-10-26.

Frozen by docs/2026-10-25-hard-gate-amendment-1.md. Do not edit after that amendment is committed: a change is a new amendment.

Usage:  python -I 2026-10-25-hard-gate-forward-rerun.py trades.csv [cutoff YYYY-MM-DD] [first_n]
        defaults: cutoff 2026-10-26, first_n 150

The CSV is the export in the amendment (one row per paper trade of the four AutoBots, any status). Nothing here reads the database.
"""
import sys
import numpy as np
import pandas as pd

IST = "Asia/Kolkata"
HOLD_MINUTES = 15            # fixed, as in the original pre-registration
RATIO_FAIL_BELOW = 0.5       # stop points over a typical hold move
FEE_INTERCEPT, FEE_PER_RUPEE = 47.2, 0.001847   # the line fitted on the first 582 trades; NOT refitted
MIN_SKIPPED = 40
ALPHA = 0.05
SEED = 20261026


def load(path, cutoff, first_n):
    d = pd.read_csv(path)
    if "status" in d.columns:
        d = d[d.status != "CANCELLED"]
    # The export writes excluded_from_evidence as 0/1 (cast in the SQL), so a text "f" is never read as true.
    excluded = d["excluded_from_evidence"].astype(int) if "excluded_from_evidence" in d.columns else pd.Series(0, index=d.index)
    d = d[excluded == 0]
    d["opened"] = pd.to_datetime(d.opened_at, utc=True, format="mixed").dt.tz_convert(IST)
    d = d[d.opened >= pd.Timestamp(cutoff, tz=IST)].sort_values("opened").head(first_n).reset_index(drop=True)
    if "status" in d.columns and (d.status != "CLOSED").any():
        raise SystemExit(f"{int((d.status != 'CLOSED').sum())} of the first {len(d)} trades are not closed yet; wait until all of them are.")
    return d


def prepare(d):
    d["day"] = d.opened.dt.date
    d["risk"] = (d.entry_price - d.initial_stop_loss).abs() * d.quantity
    d["netR"] = d.realized_pnl / d.risk
    d["grossR"] = (d.realized_pnl + d.fees) / d.risk
    d["win"] = (d.realized_pnl > 0).astype(float)
    d["fee_est"] = FEE_INTERCEPT + FEE_PER_RUPEE * d.entry_price * d.quantity
    d["ratio"] = d.fee_est / d.risk
    typical_day = 0.7979 * d.ue * d.iv * np.mean([1 / np.sqrt(365), 1 / np.sqrt(252)])
    typical_hold = typical_day * np.sqrt(min(1.0, HOLD_MINUTES / 375))
    d["stop_ratio"] = ((d.entry_price - d.initial_stop_loss) / d.delta.abs()) / typical_hold
    d["r1"] = d.stop_ratio < RATIO_FAIL_BELOW
    return d


def permute_within_bot(skip, bots, stat, rng, n=10000):
    groups = [np.flatnonzero(bots == b) for b in np.unique(bots)]
    obs = stat(skip)
    out = np.empty(n)
    for i in range(n):
        s = skip.copy()
        for g in groups:
            s[g] = rng.permutation(skip[g])
        out[i] = stat(s)
    return obs, float((out >= obs).mean()), float(out.mean())


def ols_r1(d, idx):
    X = np.c_[np.ones(len(idx)), d.r1.values[idx].astype(float), d.ratio.values[idx]]
    return np.linalg.lstsq(X, d.netR.values[idx], rcond=None)[0][1]


def run(d, label, rng):
    skip = d.r1.values
    pnl, win, bots = d.realized_pnl.values, d.win.values, d.acct.values
    n_skip = int(skip.sum())
    res = {"label": label, "n": len(d), "days": d.day.nunique(), "n_skip": n_skip}
    if n_skip < 1 or n_skip == len(d):
        return res
    # M1: rupee P&L gained by skipping, against skipping the same number at random within each bot
    gain, p1, rand_mean = permute_within_bot(skip, bots, lambda s: -pnl[s].sum(), rng)
    # M2: win rate of the kept trades minus the skipped trades, against random skipping within each bot
    wdiff, p2, _ = permute_within_bot(skip, bots, lambda s: win[~s].mean() - win[s].mean(), rng)
    # M3: coefficient on "fails the stop rule" in net R ~ r1 + fee/risk, day-clustered bootstrap
    ud, inv = np.unique(d.day.values, return_inverse=True)
    boots = []
    for _ in range(2000):
        pick = rng.integers(0, len(ud), len(ud))
        w = np.bincount(pick, minlength=len(ud))[inv]
        boots.append(ols_r1(d, np.repeat(np.arange(len(d)), w)))
    b3 = ols_r1(d, np.arange(len(d)))
    lo3, hi3 = np.percentile(boots, [2.5, 97.5])
    # halves by opening time: sign agreement for M1 (skipped trades earn less than the average trade) and M3 (coefficient negative)
    h = len(d) // 2
    halves = []
    for idx in (np.arange(h), np.arange(h, len(d))):
        sk = skip[idx]
        m1_sign = bool(sk.any() and pnl[idx][sk].mean() < pnl[idx].mean())
        m3_sign = bool(ols_r1(d, idx) < 0) if sk.any() and (~sk).any() else False
        halves.append((m1_sign, m3_sign))
    res.update(gain=gain, rand_mean=rand_mean, p1=p1, win_skipped=float(win[skip].mean()), win_kept=float(win[~skip].mean()), wdiff=wdiff, p2=p2,
               b3=float(b3), lo3=float(lo3), hi3=float(hi3), halves=halves,
               netR_diff=float(d.netR[~d.r1].mean() - d.netR[d.r1].mean()))
    return res


def verdict(r):
    if r["n_skip"] < MIN_SKIPPED:
        return f"NOT ASSESSABLE ({r['n_skip']} skipped, need {MIN_SKIPPED})"
    checks = {
        "M1 rupee gain beats random skipping (p<0.05)": r["p1"] < ALPHA,
        "M2 win rate kept above skipped (p<0.05)": r["p2"] < ALPHA and r["wdiff"] > 0,
        "M3 stop-rule coefficient negative with fee/risk controlled (CI upper < 0)": r["hi3"] < 0,
        "both halves agree on M1 and M3": all(a and b for a, b in r["halves"]),
    }
    return ("PASS" if all(checks.values()) else "FAIL") + "  " + "; ".join(f"{k}: {'yes' if v else 'no'}" for k, v in checks.items())


def show(r):
    if "p1" not in r:
        return f"  {r['label']}: n={r['n']} skipped={r['n_skip']} (nothing to test)"
    return (f"  {r['label']}: n={r['n']} on {r['days']} days, skipped {r['n_skip']}\n"
            f"    M1 rupee gain from skipping Rs {r['gain']:,.0f} vs Rs {r['rand_mean']:,.0f} at random, p={r['p1']:.3f}\n"
            f"    M2 win rate kept {r['win_kept']:.3f} vs skipped {r['win_skipped']:.3f} (diff {r['wdiff']:+.3f}), p={r['p2']:.3f}\n"
            f"    M3 stop-rule coefficient in net R with fee/risk controlled {r['b3']:+.3f}R, 95% CI [{r['lo3']:+.3f},{r['hi3']:+.3f}]\n"
            f"    halves (M1 sign, M3 sign): {r['halves']}   net R kept-minus-skipped (the original statistic): {r['netR_diff']:+.3f}")


if __name__ == "__main__":
    path = sys.argv[1]
    cutoff = sys.argv[2] if len(sys.argv) > 2 else "2026-10-26"
    first_n = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    d = prepare(load(path, cutoff, first_n))
    rng = np.random.default_rng(SEED)
    print(f"cutoff {cutoff}, first {first_n} trades by opening time: {len(d)} loaded")
    primary = run(d, "PRIMARY (all bots)", rng)
    print(show(primary))
    print("  VERDICT:", verdict(primary))
    print("\ndescriptive only:")
    print(show(run(d[d.acct != "AutoBot-Scalp1m"].reset_index(drop=True), "excluding AutoBot-Scalp1m", rng)))
    k = d[~d.r1]
    print(f"\nkept group: n={len(k)}, mean net R {k.netR.mean():+.3f}, mean net rupees {k.realized_pnl.mean():+,.0f} per trade")
