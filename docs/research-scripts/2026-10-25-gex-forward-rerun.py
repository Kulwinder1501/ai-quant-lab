"""Forward test of the reversed-sign gamma-exposure (GEX) hypothesis on NIFTY50 option-chain snapshots.

Frozen by docs/2026-10-25-gex-forward-preregistration.md. Do not edit after that document is committed: a change is a new amendment.

Usage:  python -I 2026-10-25-gex-forward-rerun.py chain.csv m1.csv [first_day YYYY-MM-DD] [last_day YYYY-MM-DD]
        defaults: first_day 2026-10-26, no last day (the pre-registered look uses the first 100 trading days with usable snapshots)

chain.csv columns: u, observed_at, expiry_date, k, ty, bid, ask, last_price, oi, s   (one row per contract per snapshot, NIFTY50 only is used)
m1.csv columns:    symbol, close_time, close                                       (1-minute index closes)
Nothing here reads the database; the exports are in the pre-registration.
"""
import sys
import numpy as np
import pandas as pd
from scipy.stats import norm

R = 0.065                    # risk-free rate used to solve implied volatility, as in the in-sample analysis
IST = "Asia/Kolkata"
UNDERLYING = "NIFTY50"
HORIZON_MIN = 60             # the primary horizon, fixed in advance
WINDOW = (9 * 60 + 35, 14 * 60 + 45)   # snapshots between 09:35 and 14:45 IST
COST_BPS_POINTS = 1.9        # round-trip cost in index points, converted to bps at each snapshot's level
N_SHIFTS, N_BOOT, SEED = 600, 4000, 20261026
STUDY_DAYS = 100             # the single pre-registered look


def bs_price(S, K, T, sig, call):
    d1 = (np.log(S / K) + (R + 0.5 * sig ** 2) * T) / (sig * np.sqrt(T))
    d2 = d1 - sig * np.sqrt(T)
    c = S * norm.cdf(d1) - K * np.exp(-R * T) * norm.cdf(d2)
    p = K * np.exp(-R * T) * norm.cdf(-d2) - S * norm.cdf(-d1)
    return np.where(call, c, p)


def implied_vol(S, K, T, price, call):
    lo = np.full(len(K), 0.01)
    hi = np.full(len(K), 3.0)
    for _ in range(45):
        mid = (lo + hi) / 2
        up = bs_price(S, K, T, mid, call) > price
        hi = np.where(up, mid, hi)
        lo = np.where(up, lo, mid)
    iv = (lo + hi) / 2
    ok = (bs_price(S, K, T, np.full(len(K), 0.011), call) < price) & (bs_price(S, K, T, np.full(len(K), 2.99), call) > price)
    return np.where(ok, iv, np.nan)


def snapshots(chain):
    """One row per snapshot: the index level and the net gamma exposure (call OI minus put OI, times gamma, times S^2 times 0.01)."""
    ch = chain[chain.u == UNDERLYING].copy()
    ch["observed_at"] = pd.to_datetime(ch.observed_at, utc=True, format="mixed")
    ch["expiry_date"] = pd.to_datetime(ch.expiry_date)
    ch["mid"] = np.where((ch.bid > 0) & (ch.ask > 0), (ch.bid + ch.ask) / 2, ch["last_price"])
    rows = []
    for t, g in ch.groupby("observed_at"):
        ist = t.tz_convert(IST)
        exp = g.expiry_date.iloc[0]
        exp_dt = pd.Timestamp(exp.date()).tz_localize(IST) + pd.Timedelta(hours=15, minutes=30)
        T = (exp_dt - t).total_seconds() / (365 * 86400)
        if T <= 0.0005:
            continue
        S = float(g.s.median())
        pc, pp = g[g.ty == "CE"].set_index("k"), g[g.ty == "PE"].set_index("k")
        ks = sorted(set(pc.index) & set(pp.index))
        if len(ks) < 10:
            continue
        K = np.array(ks, float)
        call = K >= S                      # the out-of-the-money side prices the implied volatility
        price = np.where(call, pc.loc[ks, "mid"].values, pp.loc[ks, "mid"].values)
        iv = implied_vol(S, K, T, price, call)
        d1 = (np.log(S / K) + (R + 0.5 * iv ** 2) * T) / (iv * np.sqrt(T))
        gam = norm.pdf(d1) / (S * iv * np.sqrt(T))
        oic, oip = pc.loc[ks, "oi"].values.astype(float), pp.loc[ks, "oi"].values.astype(float)
        gk = (oic - oip) * gam * S * S * 0.01
        good = ~np.isnan(gk)
        if good.sum() < 10:
            continue
        rows.append(dict(t=t, ist=ist, day=ist.date(), S=S, gex=float(gk[good].sum())))
    return pd.DataFrame(rows).sort_values("t").reset_index(drop=True)


def attach_prices(snap, m1):
    px = m1[m1.symbol == UNDERLYING].copy()
    px["close_time"] = pd.to_datetime(px.close_time, utc=True, format="mixed")
    px = px.sort_values("close_time").reset_index(drop=True)
    times = px.close_time.values

    def price_at(t):
        i = np.searchsorted(times, np.datetime64(t.tz_convert("UTC").tz_localize(None)), side="right") - 1
        if i < 0 or (t - px.close_time[i]).total_seconds() > 180:
            return np.nan
        return float(px.close[i])

    snap["p0"] = [price_at(t) for t in snap.t]
    snap["pf"] = [price_at(t + pd.Timedelta(minutes=HORIZON_MIN)) for t in snap.t]
    snap["pb"] = [price_at(t - pd.Timedelta(minutes=HORIZON_MIN)) for t in snap.t]
    mins = snap.ist.dt.hour * 60 + snap.ist.dt.minute
    snap["inwin"] = (mins >= WINDOW[0]) & (mins <= WINDOW[1])
    snap["past"] = (snap.p0 / snap.pb - 1) * 1e4
    snap["fwd"] = (snap.pf / snap.p0 - 1) * 1e4
    snap["cost"] = COST_BPS_POINTS / snap.S * 1e4
    return snap


def evaluate(snap, rng, first_day, last_day, study_days):
    g = snap[snap.inwin].dropna(subset=["gex", "past", "fwd"]).copy()
    g = g[g.past != 0]
    g = g[g.day >= pd.Timestamp(first_day).date()]
    if last_day:
        g = g[g.day <= pd.Timestamp(last_day).date()]
    days = sorted(g.day.unique())[:study_days]
    g = g[g.day.isin(days)].sort_values("t").reset_index(drop=True)
    if len(days) == 0:
        return None
    sgn = np.sign(g.gex.values)
    cont = np.sign(g.past.values) * g.fwd.values            # continuation return of the move over the previous hour
    sig = sgn * cont                                         # REVERSED sign: positive GEX -> continuation, negative GEX -> reversal
    mean = float(sig.mean())
    ud, inv = np.unique(g.day.values, return_inverse=True)
    sums, cnts = np.bincount(inv, weights=sig), np.bincount(inv)
    boots = []
    for _ in range(N_BOOT):
        pick = rng.integers(0, len(ud), len(ud))
        boots.append(sums[pick].sum() / cnts[pick].sum())
    lo, hi = np.percentile(boots, [2.5, 97.5])
    n = len(sgn)
    shifted = []
    for _ in range(N_SHIFTS):
        k = int(rng.integers(30, n - 30)) if n > 100 else 1
        shifted.append(float((np.roll(sgn, k) * cont).mean()))
    p_shift = float((np.array(shifted) >= mean).mean())       # one-sided
    h = len(ud) // 2
    first_half, second_half = np.isin(inv, np.arange(h)), np.isin(inv, np.arange(h, len(ud)))
    return dict(days=len(ud), n=n, mean=mean, lo=float(lo), hi=float(hi), p_shift=p_shift, cost=float(g.cost.mean()),
                half1=float(sig[first_half].mean()), half2=float(sig[second_half].mean()),
                pos=(float(cont[sgn > 0].mean()), int((sgn > 0).sum())), neg=(float(cont[sgn < 0].mean()), int((sgn < 0).sum())),
                first=str(days[0]), last=str(days[-1]))


def verdict(r, study_days):
    if r is None or r["days"] < 0.85 * study_days:
        return f"NOT ASSESSABLE (needs at least {int(0.85 * study_days)} usable days, has {0 if r is None else r['days']})"
    conditions = {
        "mean above zero with the day-bootstrap 95% interval above zero": r["lo"] > 0,
        "shifted-signal placebo p < 0.05 (one-sided)": r["p_shift"] < 0.05,
        "mean beats the round-trip cost": r["mean"] > r["cost"],
        "both halves of the days positive": r["half1"] > 0 and r["half2"] > 0,
    }
    return ("PASS" if all(conditions.values()) else "FAIL") + "  " + "; ".join(f"{k}: {'yes' if v else 'no'}" for k, v in conditions.items())


if __name__ == "__main__":
    chain = pd.read_csv(sys.argv[1])
    m1 = pd.read_csv(sys.argv[2])
    first_day = sys.argv[3] if len(sys.argv) > 3 else "2026-10-26"
    last_day = sys.argv[4] if len(sys.argv) > 4 else None
    study_days = STUDY_DAYS
    snap = attach_prices(snapshots(chain), m1)
    r = evaluate(snap, np.random.default_rng(SEED), first_day, last_day, study_days)
    if r is None:
        print("no usable snapshots from", first_day)
        sys.exit(0)
    print(f"{UNDERLYING}, {HORIZON_MIN}-minute horizon, days {r['first']} to {r['last']}: {r['days']} days, {r['n']} snapshots")
    print(f"  reversed-sign signal mean {r['mean']:+.2f} bps, day-bootstrap 95% interval [{r['lo']:+.2f},{r['hi']:+.2f}], shifted-signal placebo p={r['p_shift']:.3f}, mean round-trip cost {r['cost']:.2f} bps")
    print(f"  halves of the days: {r['half1']:+.2f} / {r['half2']:+.2f} bps;  continuation after positive GEX {r['pos'][0]:+.2f} bps (n={r['pos'][1]}), after negative GEX {r['neg'][0]:+.2f} bps (n={r['neg'][1]})")
    print("  VERDICT:", verdict(r, study_days))
