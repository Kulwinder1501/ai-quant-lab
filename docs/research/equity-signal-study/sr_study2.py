import math
src = open("sr_study.py").read().split("files = sorted")[0]
exec(src)
files = sorted(glob.glob(SP + "/*.json")); stocks = {os.path.basename(f)[:-5]: load(f) for f in files}
H = 20
rows = {k: [] for k in ("support_touch","support_break","resist_touch","resist_break")}
for name, s in stocks.items():
    if len(s["c"]) < 600: continue
    ev = events_for(s); fwd, base = baseline(s, H)
    for kind, idxs in ev.items():
        for t in idxs:
            if np.isfinite(fwd[t]) and np.isfinite(base[t]): rows[kind].append((s["date"][t].year, s["date"][t].month, fwd[t] - base[t]))
print("TIME-CLUSTERED CHECK (H=20): average events within each calendar month first, then t-stat across months")
for kind, r in rows.items():
    by = {}
    for y, m, x in r: by.setdefault((y, m), []).append(x)
    mm = np.array([np.mean(v) for v in by.values()]); t = mm.mean() / (mm.std(ddof=1) / math.sqrt(len(mm)))
    ex = np.array([np.mean(v) for (y, m), v in by.items() if not ((y == 2020 and m in (2, 3, 4)) or (y == 2008 and m >= 9) or (y == 2009 and m <= 3))])
    t2 = ex.mean() / (ex.std(ddof=1) / math.sqrt(len(ex)))
    med = np.median([x for _, _, x in r])
    print(f"{kind:14s} months={len(mm):3d} mean={mm.mean()*100:+.2f}% t={t:+.2f} | excl. 2008-09 & 2020 crashes: mean={ex.mean()*100:+.2f}% t={t2:+.2f} | median event excess={med*100:+.2f}%")
