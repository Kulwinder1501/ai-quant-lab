import json, glob, os, sys, math, datetime as dt
import numpy as np
SP = os.environ.get("SR_DATA", "sr_data")
K, LOOK, TOL, ZONE, APPR, COOL = 5, 252, 0.015, 0.01, 0.02, 10   # fixed a priori, not tuned
HORIZONS = (10, 20)
rng = np.random.default_rng(7)

def load(fn):
    d = json.load(open(fn))["chart"]["result"][0]; q = d["indicators"]["quote"][0]
    ts, o, h, l, c, v = [], [], [], [], [], []
    for i, t in enumerate(d["timestamp"]):
        if q["close"][i] is None or q["high"][i] is None or q["low"][i] is None: continue
        ts.append(dt.datetime.fromtimestamp(t, dt.timezone.utc).date()); h.append(q["high"][i]); l.append(q["low"][i]); c.append(q["close"][i]); v.append(q["volume"][i] or 0)
    return dict(date=ts, h=np.array(h), l=np.array(l), c=np.array(c), v=np.array(v, float))

def pivots(arr, kind):
    n = len(arr); idx = []
    for i in range(K, n - K):
        w = arr[i - K:i + K + 1]
        if (kind == "low" and arr[i] <= w.min()) or (kind == "high" and arr[i] >= w.max()): idx.append(i)
    return np.array(idx, int)

def levels_at(t, piv_idx, piv_px):
    m = (piv_idx + K <= t) & (piv_idx >= t - LOOK)
    px = piv_px[m]
    if len(px) < 2: return np.array([])
    strength = (np.abs(px[:, None] - px[None, :]) <= TOL * px[:, None]).sum(axis=1)
    return px[strength >= 2]

def events_for(stock):
    h, l, c, n = stock["h"], stock["l"], stock["c"], len(stock["c"])
    pl, ph = pivots(l, "low"), pivots(h, "high")
    ev = {"support_touch": [], "support_break": [], "resist_touch": [], "resist_break": []}
    last = {k: -999 for k in ev}
    for t in range(LOOK + K + 1, n - max(HORIZONS) - 1):
        # support levels
        Ls = levels_at(t, pl, l[pl]) if len(pl) else np.array([])
        if len(Ls):
            for L in sorted(Ls, reverse=True):
                if c[t-1] >= L * (1 + APPR) and L*(1-ZONE) <= l[t] <= L*(1+ZONE) and c[t] >= L*(1-ZONE) and t - last["support_touch"] > COOL:
                    ev["support_touch"].append(t); last["support_touch"] = t; break
            for L in sorted(Ls, reverse=True):
                if c[t-1] >= L and c[t] < L * (1 - ZONE) and t - last["support_break"] > COOL:
                    ev["support_break"].append(t); last["support_break"] = t; break
        Lr = levels_at(t, ph, h[ph]) if len(ph) else np.array([])
        if len(Lr):
            for L in sorted(Lr):
                if c[t-1] <= L * (1 - APPR) and L*(1-ZONE) <= h[t] <= L*(1+ZONE) and c[t] <= L*(1+ZONE) and t - last["resist_touch"] > COOL:
                    ev["resist_touch"].append(t); last["resist_touch"] = t; break
            for L in sorted(Lr):
                if c[t-1] <= L and c[t] > L * (1 + ZONE) and t - last["resist_break"] > COOL:
                    ev["resist_break"].append(t); last["resist_break"] = t; break
    return ev

def baseline(stock, H):
    c, dates = stock["c"], stock["date"]; n = len(c)
    fwd = np.full(n, np.nan); fwd[:n-H] = c[H:] / c[:n-H] - 1
    years = np.array([d.year for d in dates]); base = np.full(n, np.nan)
    for y in np.unique(years):
        m = years == y; base[m] = np.nanmean(fwd[m]) if np.isfinite(fwd[m]).any() else np.nan
    return fwd, base

def boot_ci(per_stock, B=3000):
    # per_stock: list of arrays of excess returns, cluster bootstrap by stock
    arrs = [a for a in per_stock if len(a)]; allv = np.concatenate(arrs); m = allv.mean()
    stats = []
    for _ in range(B):
        pick = rng.integers(0, len(arrs), len(arrs)); stats.append(np.concatenate([arrs[i] for i in pick]).mean())
    return m, np.percentile(stats, 2.5), np.percentile(stats, 97.5), len(allv)

files = sorted(glob.glob(SP + "/*.json")); stocks = {os.path.basename(f)[:-5]: load(f) for f in files}
print("stocks", len(stocks), "total bars", sum(len(s["c"]) for s in stocks.values()))
res = {}
for name, s in stocks.items():
    if len(s["c"]) < 600: continue
    ev = events_for(s)
    for H in HORIZONS:
        fwd, base = baseline(s, H)
        for kind, idxs in ev.items():
            ex = [fwd[t] - base[t] for t in idxs if np.isfinite(fwd[t]) and np.isfinite(base[t])]
            res.setdefault((kind, H), []).append(np.array(ex))
print("\nSUPPORT/RESISTANCE EVENT STUDY (excess forward return vs same-stock same-year average; cluster-bootstrap CI over stocks)")
print("expected if levels worked: support_touch > 0, resist_touch < 0, support_break < 0, resist_break > 0")
for (kind, H), per in sorted(res.items()):
    m, lo, hi, n = boot_ci(per)
    pos = np.mean(np.concatenate([a for a in per if len(a)]) > 0)
    print(f"{kind:14s} H={H:2d}  n={n:5d}  mean excess={m*100:+.2f}%  95% CI [{lo*100:+.2f}%, {hi*100:+.2f}%]  share>0={pos:.2f}")

# ---- 52-week-high, trend filter: monthly cross-sectional (non-overlapping 21-bar horizon)
print("\nMONTHLY CROSS-SECTION (non-overlapping), forward 21 trading days")
months = {}
for name, s in stocks.items():
    c, dates, n = s["c"], s["date"], len(s["c"])
    sma200 = np.array([c[max(0, i-199):i+1].mean() if i >= 199 else np.nan for i in range(n)])
    hi252 = np.array([c[max(0, i-251):i+1].max() if i >= 251 else np.nan for i in range(n)])
    for i in range(252, n - 21):
        if i + 1 < n and dates[i].month != dates[i+1].month:      # last bar of month
            months.setdefault((dates[i].year, dates[i].month), []).append((name, c[i] / hi252[i], c[i] / sma200[i], c[i+21] / c[i] - 1))
spread, above_minus_below, top5, new_high_excess = [], [], [], []
for ym, rows in sorted(months.items()):
    if len(rows) < 20: continue
    prox = np.array([r[1] for r in rows]); tr = np.array([r[2] for r in rows]); f = np.array([r[3] for r in rows])
    order = np.argsort(prox); q = len(rows) // 5
    spread.append(f[order[-q:]].mean() - f[order[:q]].mean())             # near-high quintile minus far-from-high quintile
    above = tr > 1; 
    if above.any() and (~above).any(): above_minus_below.append(f[above].mean() - f[~above].mean())
    nh = prox >= 0.9999
    if nh.sum() >= 2: new_high_excess.append(f[nh].mean() - f.mean())
def tstat(x):
    x = np.array(x); return x.mean(), x.mean() / (x.std(ddof=1) / math.sqrt(len(x))), len(x)
for label, x in [("near-52w-high quintile minus far quintile", spread), ("close above 200-day avg minus below", above_minus_below), ("new 52w-high stocks minus all stocks", new_high_excess)]:
    m, t, n = tstat(x); print(f"{label:46s} months={n:3d}  mean 21d diff={m*100:+.2f}%  t={t:+.2f}")
# split-sample stability
mid = len(spread) // 2
for label, x in [("near-high spread", spread), ("above-200d", above_minus_below)]:
    a, b = x[:len(x)//2], x[len(x)//2:]
    print(f"   {label}: first half mean {np.mean(a)*100:+.2f}%  second half mean {np.mean(b)*100:+.2f}%")
