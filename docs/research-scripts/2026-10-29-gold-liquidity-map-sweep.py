"""Pre-registered sweep test of the gold liquidity map (Asian, prior-day and prior-week high/low levels).

Frozen by docs/2026-10-29-gold-liquidity-map-sweep-preregistration.md. Do not edit after this script is committed: a change is a new amendment.

Usage:  python -I 2026-10-29-gold-liquidity-map-sweep.py xau_5m.csv [count-only]
        python -I 2026-10-29-gold-liquidity-map-sweep.py --selftest      (synthetic bars only; touches no market data)

xau_5m.csv columns: open_time (UTC, ISO 8601), open, high, low, close   (XAU_USD, 5m, completed bars, up to and including 2026-10-28)
Export: run this query in psql (against the v2 database) and save the result as CSV with a header row. Nothing else in this script reads the database.
  select to_char(c.open_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as open_time, c.open, c.high, c.low, c.close
  from candles c join instruments i on i.id = c.instrument_id
  where i.symbol = 'XAU_USD' and c.timeframe = '5m' and c.is_complete and c.open_time < '2026-10-29 00:00:00+00'
  order by c.open_time

The first stage only counts events, trades and days. The outcome stage runs only when the pre-registered floor is met.

Choices the document leaves open, fixed here:
  - one position at a time: a trade occupies bars t+1 .. t+HOLD, and an event on a bar up to and including t+HOLD is ignored;
  - the previous week must be the immediately preceding ISO week (by session date) to give a weekly level; the previous day is the previous session present in the data;
  - a level is built from whatever bars exist (no minimum bar count); thin sessions are counted in the diagnostics, not removed.
"""
import sys
import numpy as np
import pandas as pd

MIN_PEN_BPS, MAX_PEN_BPS = 3.0, 50.0      # inherited from the live Asian sweep configuration
HOLD = 12                                  # bars held: exit at the close of bar t+HOLD
WINDOW_MIN = (3 * 60 + 30, 15 * 60 + 25)   # sweep bar opens between 03:30 and 15:25 UTC, inclusive
COST_USD = 0.60                            # round trip, dollars per ounce (assumed; no gold bid/ask is stored)
N_BOOT, N_SHIFTS, SEED = 4000, 600, 20261029
MIN_SHIFT = 300
FLOOR_TRADES, FLOOR_DAYS = 300, 150
PRIMARY_START, PRIMARY_END_EXCL = "2020-01-01", "2025-11-01"
REPLICATION_END_EXCL = "2026-10-29"
CONTROL_BARS = 72                          # trailing-extreme control: previous 6 hours
BAR_NS = 300_000_000_000                   # five minutes
BIT_NAME = {1: "A", 2: "D", 4: "W"}


# ---------------------------------------------------------------- data

def load_bars(path):
    df = pd.read_csv(path)
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True, format="mixed")
    return df.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)


def prepare(df):
    t_utc = df["open_time"].dt.tz_convert("UTC")
    ts = t_utc.dt.tz_localize(None)
    ny = t_utc.dt.tz_convert("America/New_York").dt.tz_localize(None)
    # the code's gold session convention: the day rolls at 18:00 New York time (XAUUSD_OANDA_PROFILE)
    sess = ny.dt.normalize() + pd.to_timedelta((ny.dt.hour >= 18).astype(int), unit="D")
    week = sess - pd.to_timedelta(sess.dt.weekday, unit="D")
    off = ((ny - ts).dt.total_seconds() / 3600).round().astype(int)       # -4 in US summer time, -5 in winter
    return {
        "ts": ts.values.astype("datetime64[ns]"),
        "o": df["open"].to_numpy(float), "h": df["high"].to_numpy(float),
        "l": df["low"].to_numpy(float), "c": df["close"].to_numpy(float),
        "mod": (ts.dt.hour * 60 + ts.dt.minute).to_numpy(),
        "wd": ts.dt.weekday.to_numpy(),
        "udate": ts.dt.normalize().values.astype("datetime64[ns]"),
        "sess": sess.values.astype("datetime64[ns]"),
        "week": week.values.astype("datetime64[ns]"),
        "off": off.to_numpy(), "year": ts.dt.year.to_numpy(),
    }


def idx_at(b, date):
    return int(np.searchsorted(b["ts"], np.datetime64(date, "ns")))


# ---------------------------------------------------------------- levels and sweeps

def build_levels(b):
    """(type bit, side, price, start, end): side +1 is a high level (swept upward), -1 a low level; start..end are the bars it is live for."""
    n = len(b["h"])
    h, l, pos = b["h"], b["l"], np.arange(n)
    levels, diag = [], {}
    d = pd.DataFrame({"u": b["udate"], "mod": b["mod"], "h": h, "l": l, "i": pos})
    asia = d[d["mod"] < 360].groupby("u").agg(H=("h", "max"), L=("l", "min"), k=("h", "size"))
    live = d[d["mod"] >= 360].groupby("u")["i"].agg(["min", "max"])
    for u in asia.index.intersection(live.index):
        s, e = int(live.at[u, "min"]), int(live.at[u, "max"]) + 1
        levels.append((1, +1, float(asia.at[u, "H"]), s, e))
        levels.append((1, -1, float(asia.at[u, "L"]), s, e))
    diag["asian sessions built from fewer than 60 of 72 bars"] = int((asia.loc[asia.index.intersection(live.index), "k"] < 60).sum())
    for key, bit in (("sess", 2), ("week", 4)):
        g = pd.DataFrame({"k": b[key], "h": h, "l": l, "i": pos}).groupby("k").agg(H=("h", "max"), L=("l", "min"), s=("i", "min"), e=("i", "max"), k=("h", "size"))
        ks = list(g.index)
        thin = 0
        for j in range(1, len(ks)):
            if key == "week" and (ks[j] - ks[j - 1]).days != 7:
                continue
            prev, cur = g.loc[ks[j - 1]], g.loc[ks[j]]
            s, e = int(cur["s"]), int(cur["e"]) + 1
            levels.append((bit, +1, float(prev["H"]), s, e))
            levels.append((bit, -1, float(prev["L"]), s, e))
            if prev["k"] < (200 if key == "sess" else 1000):
                thin += 1
        diag[f"{'daily' if key == 'sess' else 'weekly'} levels built from a thin session/week"] = thin
    return levels, diag


def sweep_events(b, levels, min_pen, max_pen):
    """One row per swept bar and side: t, side, bits (which level types), stack (how many levels). A bar sweeping both sides is dropped."""
    h, l, c = b["h"], b["l"], b["c"]
    rows = []
    for bit, side, price, s, e in levels:
        if price <= 0:
            continue
        if side > 0:
            pen = (h[s:e] / price - 1.0) * 1e4
            hit = np.flatnonzero(pen >= min_pen)
            if hit.size == 0:
                continue
            f = s + int(hit[0])                       # first touch consumes the level, event or not
            if pen[hit[0]] <= max_pen and c[f] < price:
                rows.append((f, side, bit))
        else:
            pen = (price - l[s:e]) / price * 1e4
            hit = np.flatnonzero(pen >= min_pen)
            if hit.size == 0:
                continue
            f = s + int(hit[0])
            if pen[hit[0]] <= max_pen and c[f] > price:
                rows.append((f, side, bit))
    return _aggregate(rows)


def _aggregate(rows):
    if not rows:
        return pd.DataFrame({"t": np.array([], int), "side": np.array([], int), "bits": np.array([], int), "stack": np.array([], int), "dir": np.array([], int)})
    ev = pd.DataFrame(rows, columns=["t", "side", "bit"])
    g = ev.groupby(["t", "side"]).agg(bits=("bit", "sum"), stack=("bit", "size")).reset_index()
    g = g[g.groupby("t")["side"].transform("nunique") == 1].copy()
    g["dir"] = -g["side"]                              # fade: a swept high is a short, a swept low is a long
    return g.reset_index(drop=True)


def control_events(b, min_pen, max_pen):
    """Same sweep rule against the highest high / lowest low of the previous CONTROL_BARS bars, instead of named levels."""
    h, l, c, ts = b["h"], b["l"], b["c"], b["ts"].astype("int64")
    n = len(h)
    hs = pd.Series(h).rolling(CONTROL_BARS).max().shift(1).to_numpy()
    ls = pd.Series(l).rolling(CONTROL_BARS).min().shift(1).to_numpy()
    contiguous = np.zeros(n, bool)
    contiguous[CONTROL_BARS:] = (ts[CONTROL_BARS:] - ts[:-CONTROL_BARS]) == CONTROL_BARS * BAR_NS
    with np.errstate(invalid="ignore", divide="ignore"):
        pen_hi = (h / hs - 1.0) * 1e4
        pen_lo = (ls - l) / ls * 1e4
        ev_hi = contiguous & (pen_hi >= min_pen) & (pen_hi <= max_pen) & (c < hs)
        ev_lo = contiguous & (pen_lo >= min_pen) & (pen_lo <= max_pen) & (c > ls)
    both = ev_hi & ev_lo
    ev_hi, ev_lo = ev_hi & ~both, ev_lo & ~both
    rows = [(int(t), +1, 0) for t in np.flatnonzero(ev_hi)] + [(int(t), -1, 0) for t in np.flatnonzero(ev_lo)]
    if not rows:
        return _aggregate([])
    g = pd.DataFrame(rows, columns=["t", "side", "bits"]).sort_values("t").reset_index(drop=True)
    g["stack"] = 1
    g["dir"] = -g["side"]
    return g


# ---------------------------------------------------------------- trades

def eligible(b, hold):
    n = len(b["h"])
    ts = b["ts"].astype("int64")
    ok = np.zeros(n, bool)
    if n > hold:
        ok[: n - hold] = (ts[hold:] - ts[:-hold]) == hold * BAR_NS     # bars t .. t+hold consecutive
    inwin = (b["mod"] >= WINDOW_MIN[0]) & (b["mod"] <= WINDOW_MIN[1]) & (b["wd"] < 5)
    return ok & inwin


def form_trades(events, elig, hold):
    """Keep eligible events in time order, one position at a time: a trade holds through bar t+hold, and an event up to that bar is ignored."""
    if len(events) == 0:
        return events.copy()
    e = events[elig[events["t"].to_numpy()]].sort_values("t")
    keep, last = np.zeros(len(e), bool), -10 ** 12
    for k, t in enumerate(e["t"].to_numpy()):
        if t > last + hold:
            keep[k], last = True, t
    return e[keep].reset_index(drop=True)


def returns(b, tr, hold):
    t = tr["t"].to_numpy()
    entry, exit_ = b["o"][t + 1], b["c"][t + hold]
    d = tr["dir"].to_numpy()
    gross_usd = d * (exit_ - entry)
    return gross_usd, gross_usd / entry * 1e4, COST_USD / entry * 1e4


# ---------------------------------------------------------------- statistics

def day_ids(b, t):
    return b["udate"][t].astype("int64") // 86_400_000_000_000


def boot_ci(day, x, rng, n_boot):
    u, inv = np.unique(day, return_inverse=True)
    s, c = np.bincount(inv, weights=x), np.bincount(inv).astype(float)
    idx = rng.integers(0, len(u), size=(n_boot, len(u)))
    m = s[idx].sum(1) / c[idx].sum(1)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def boot_diff_ci(day1, x1, day2, x2, rng, n_boot):
    days = np.union1d(day1, day2)
    k = len(days)
    pos1, pos2 = np.searchsorted(days, day1), np.searchsorted(days, day2)
    s1, c1 = np.bincount(pos1, weights=x1, minlength=k), np.bincount(pos1, minlength=k).astype(float)
    s2, c2 = np.bincount(pos2, weights=x2, minlength=k), np.bincount(pos2, minlength=k).astype(float)
    idx = rng.integers(0, k, size=(n_boot, k))
    with np.errstate(invalid="ignore", divide="ignore"):
        d = s2[idx].sum(1) / c2[idx].sum(1) - s1[idx].sum(1) / c1[idx].sum(1)
    d = d[np.isfinite(d)]
    return (float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))) if len(d) else (float("nan"), float("nan"))


def placebo_share(b, tr, elig, hold, lo, hi, rng, n_shifts):
    """Share of circular time-shifts of the observed (time, direction) pairs whose mean gross return is at least the observed one."""
    t0, d0 = tr["t"].to_numpy(), tr["dir"].to_numpy()
    entry = np.full(len(b["o"]), np.nan)
    entry[:-1] = b["o"][1:]
    exit_ = np.full(len(b["o"]), np.nan)
    exit_[: len(exit_) - hold] = b["c"][hold:]
    mv = (exit_ - entry) / entry * 1e4
    observed = float(np.mean(d0 * mv[t0]))
    span = hi - lo
    shifts = rng.integers(MIN_SHIFT, span - MIN_SHIFT + 1, size=n_shifts)
    means = []
    for s in shifts:
        t = lo + (t0 - lo + s) % span
        d = d0
        ok = elig[t] & (t + hold < hi)
        t, d = t[ok], d[ok]
        order = np.argsort(t)
        t, d = t[order], d[order]
        keep, last = np.zeros(len(t), bool), -10 ** 12
        for k, tt in enumerate(t):
            if tt > last + hold:
                keep[k], last = True, tt
        if keep.any():
            means.append(float(np.mean(d[keep] * mv[t[keep]])))
    means = np.array(means)
    return observed, float(np.mean(means >= observed)) if len(means) else float("nan"), len(means)


def summarise(b, tr, hold, label, rng, n_boot, quiet=False):
    if len(tr) == 0:
        if not quiet:
            print(f"  {label:<34} no trades")
        return None
    t = tr["t"].to_numpy()
    usd, bps, cost = returns(b, tr, hold)
    day = day_ids(b, t)
    ci = boot_ci(day, bps, rng, n_boot) if len(np.unique(day)) > 1 else (float("nan"), float("nan"))
    r = dict(n=len(tr), days=len(np.unique(day)), gross=float(bps.mean()), ci=ci, net=float((bps - cost).mean()),
             net2=float((bps - 2 * cost).mean()), usd=float(usd.mean()), cost_bps=float(cost.mean()))
    if not quiet:
        print(f"  {label:<34} n={r['n']:>5} days={r['days']:>4}  gross {r['gross']:+7.2f} bps [{ci[0]:+6.2f},{ci[1]:+6.2f}]  "
              f"net {r['net']:+7.2f}  net@2x {r['net2']:+7.2f}  (${r['usd']:+.2f}/oz, cost {r['cost_bps']:.2f} bps)")
    return r


# ---------------------------------------------------------------- the run

def trades_for(b, levels, min_pen=MIN_PEN_BPS, max_pen=MAX_PEN_BPS, hold=HOLD):
    return form_trades(sweep_events(b, levels, min_pen, max_pen), eligible(b, hold), hold)


def in_range(tr, lo, hi):
    return tr[(tr["t"] >= lo) & (tr["t"] < hi)].reset_index(drop=True)


def run(b, count_only=False, n_boot=N_BOOT, n_shifts=N_SHIFTS, floor_trades=FLOOR_TRADES, floor_days=FLOOR_DAYS):
    rng = np.random.default_rng(SEED)
    n = len(b["h"])
    lo, hi, rhi = idx_at(b, PRIMARY_START), idx_at(b, PRIMARY_END_EXCL), idx_at(b, REPLICATION_END_EXCL)
    print(f"bars {n}  first {b['ts'][0]}  last {b['ts'][-1]}")
    levels, diag = build_levels(b)
    for k, v in diag.items():
        print(f"  diagnostic: {k}: {v}")
    events = sweep_events(b, levels, MIN_PEN_BPS, MAX_PEN_BPS)
    elig = eligible(b, HOLD)
    trades = form_trades(events, elig, HOLD)
    prim, rep = in_range(trades, lo, hi), in_range(trades, hi, rhi)
    pdays = len(np.unique(day_ids(b, prim["t"].to_numpy()))) if len(prim) else 0
    rdays = len(np.unique(day_ids(b, rep["t"].to_numpy()))) if len(rep) else 0

    print("\n== Stage 1: counts (no returns are read) ==")
    print(f"  levels built: A {sum(1 for x in levels if x[0] == 1)}, D {sum(1 for x in levels if x[0] == 2)}, W {sum(1 for x in levels if x[0] == 4)}")
    print(f"  sweep events (any time): {len(events)};  in window with consecutive bars: {int(elig[events['t'].to_numpy()].sum()) if len(events) else 0}")
    print(f"  primary trades {len(prim)} on {pdays} days;  replication trades {len(rep)} on {rdays} days")
    if len(prim):
        by = prim.assign(type=prim["bits"].map(lambda x: BIT_NAME.get(int(x), "mixed")))
        print("  primary trades by type:", {k: int(v) for k, v in by["type"].value_counts().items()},
              " by stack:", {int(k): int(v) for k, v in prim["stack"].value_counts().sort_index().items()})
        print("  primary trades by year:", {int(k): int(v) for k, v in pd.Series(b["year"][prim["t"].to_numpy()]).value_counts().sort_index().items()})
    floor_ok = len(prim) >= floor_trades and pdays >= floor_days
    print(f"  floor ({floor_trades} trades on {floor_days} days): {'MET' if floor_ok else 'NOT MET -> UNDERPOWERED, no outcome is reported'}")
    if count_only or not floor_ok:
        return {"floor": floor_ok}

    print("\n== Stage 2: primary test (2020-01-01 .. 2025-10-31) ==")
    pr = summarise(b, prim, HOLD, "all events", rng, n_boot)
    observed, p_placebo, n_used = placebo_share(b, prim, elig, HOLD, lo, hi, rng, n_shifts)
    print(f"  placebo: observed mean {observed:+.2f} bps; share of {n_used} shifts at or above it = {p_placebo:.4f}")
    be_usd, be_bps = pr["usd"], pr["gross"]
    print(f"  break-even cost: ${be_usd:+.2f} per ounce = {be_bps:+.2f} bps  (assumed cost ${COST_USD:.2f}, about {pr['cost_bps']:.2f} bps on average)")
    rr = summarise(b, rep, HOLD, "replication 2025-11..2026-10", rng, n_boot)

    conds = {
        "gross mean > 0": pr["gross"] > 0,
        "95% interval excludes zero": pr["ci"][0] > 0,
        "placebo share < 0.05": p_placebo < 0.05,
        f"mean after ${COST_USD:.2f} cost > 0": pr["net"] > 0,
        "floor met": floor_ok,
        "replication gross mean > 0": rr is not None and rr["gross"] > 0,
    }
    print("\n== Pass conditions ==")
    for k, v in conds.items():
        print(f"  [{'x' if v else ' '}] {k}")
    print(f"  VERDICT: {'PASS' if all(conds.values()) else 'FAIL'}   (a pass justifies only a stop/target pre-registration and a forward paper test)")

    print("\n== Checks that cannot rescue a failure (primary window) ==")
    ctl = in_range(form_trades(control_events(b, MIN_PEN_BPS, MAX_PEN_BPS), elig, HOLD), lo, hi)
    summarise(b, ctl, HOLD, "control: trailing 6h extremes", rng, n_boot)
    single, stacked = prim[prim["stack"] == 1].reset_index(drop=True), prim[prim["stack"] >= 2].reset_index(drop=True)
    summarise(b, single, HOLD, "stack 1", rng, n_boot)
    summarise(b, stacked, HOLD, "stack >= 2", rng, n_boot)
    if len(single) and len(stacked):
        g1, g2 = returns(b, single, HOLD)[1], returns(b, stacked, HOLD)[1]
        ci = boot_diff_ci(day_ids(b, single["t"].to_numpy()), g1, day_ids(b, stacked["t"].to_numpy()), g2, rng, n_boot)
        print(f"  {'stack >= 2 minus stack 1':<34} {g2.mean() - g1.mean():+7.2f} bps  [{ci[0]:+6.2f},{ci[1]:+6.2f}]")
    typed = prim.assign(type=prim["bits"].map(lambda x: BIT_NAME.get(int(x), "mixed")))
    for name in ("A", "D", "W", "mixed"):
        summarise(b, typed[typed["type"] == name].reset_index(drop=True), HOLD, f"type {name} only" if name != "mixed" else "type mixed (stack >= 2)", rng, n_boot)
    mirror = prim.assign(dir=-prim["dir"])
    summarise(b, mirror, HOLD, "continuation (same events, reversed)", rng, n_boot)

    print("  -- halves and years")
    for lab, a, z in (("2020-2022", "2020-01-01", "2023-01-01"), ("2023-2025-10", "2023-01-01", PRIMARY_END_EXCL)):
        summarise(b, in_range(prim, idx_at(b, a), idx_at(b, z)), HOLD, lab, rng, n_boot)
    yrs = b["year"][trades["t"].to_numpy()]
    for y in sorted(set(yrs.tolist())):
        summarise(b, trades[yrs == y].reset_index(drop=True), HOLD, f"year {y}", rng, n_boot)

    print("  -- sensitivity")
    for mp in (2.0, 5.0):
        summarise(b, in_range(trades_for(b, levels, min_pen=mp), lo, hi), HOLD, f"min penetration {mp:g} bps", rng, n_boot)
    for hd in (6, 24):
        summarise(b, in_range(trades_for(b, levels, hold=hd), lo, hi), hd, f"hold {hd} bars", rng, n_boot)
    for name, sel in (("short only", prim["dir"] == -1), ("long only", prim["dir"] == 1)):
        summarise(b, prim[sel].reset_index(drop=True), HOLD, name, rng, n_boot)
    mod = b["mod"][prim["t"].to_numpy()]
    for name, sel in (("03:30-07:00 UTC", (mod >= 210) & (mod < 420)), ("07:00-12:00 UTC", (mod >= 420) & (mod < 720)), ("12:00-15:30 UTC", mod >= 720)):
        summarise(b, prim[sel].reset_index(drop=True), HOLD, name, rng, n_boot)
    off = b["off"][prim["t"].to_numpy()]
    summarise(b, prim[off == -4].reset_index(drop=True), HOLD, "US summer time", rng, n_boot)
    summarise(b, prim[off == -5].reset_index(drop=True), HOLD, "US winter time", rng, n_boot)
    return {"floor": True, "verdict": all(conds.values())}


# ---------------------------------------------------------------- self-test on synthetic data

def _mini(h, l, c):
    return {"h": np.array(h, float), "l": np.array(l, float), "c": np.array(c, float)}


def naive_events(b, min_pen, max_pen):
    """A deliberately different, bar-by-bar reading of the same rules, used only to cross-check build_levels and sweep_events."""
    n = len(b["h"])
    h, l, c = b["h"], b["l"], b["c"]
    a_hi, a_lo, s_hi, s_lo, w_hi, w_lo = {}, {}, {}, {}, {}, {}
    for i in range(n):
        u, s, w = b["udate"][i], b["sess"][i], b["week"][i]
        if b["mod"][i] < 360:
            a_hi[u], a_lo[u] = max(a_hi.get(u, -1e18), h[i]), min(a_lo.get(u, 1e18), l[i])
        s_hi[s], s_lo[s] = max(s_hi.get(s, -1e18), h[i]), min(s_lo.get(s, 1e18), l[i])
        w_hi[w], w_lo[w] = max(w_hi.get(w, -1e18), h[i]), min(w_lo.get(w, 1e18), l[i])
    sessions = sorted(s_hi)
    prev_session = {sessions[k]: sessions[k - 1] for k in range(1, len(sessions))}
    consumed, rows = set(), []
    for i in range(n):
        u, s, w = b["udate"][i], b["sess"][i], b["week"][i]
        live = []
        if b["mod"][i] >= 360 and u in a_hi:
            live += [(1, +1, a_hi[u], ("A", u, +1)), (1, -1, a_lo[u], ("A", u, -1))]
        if s in prev_session:
            p = prev_session[s]
            live += [(2, +1, s_hi[p], ("D", s, +1)), (2, -1, s_lo[p], ("D", s, -1))]
        pw = w - np.timedelta64(7, "D")
        if pw in w_hi:
            live += [(4, +1, w_hi[pw], ("W", w, +1)), (4, -1, w_lo[pw], ("W", w, -1))]
        for bit, side, price, key in live:
            if key in consumed:
                continue
            pen = (h[i] / price - 1.0) * 1e4 if side > 0 else (price - l[i]) / price * 1e4
            if pen >= min_pen:
                consumed.add(key)
                if pen <= max_pen and (c[i] < price if side > 0 else c[i] > price):
                    rows.append((i, side, bit))
    return _aggregate(rows)


def selftest():
    # a high level swept: 2 bps does not touch; 4 bps with a close back inside is the event; later touches do nothing
    ev = sweep_events(_mini([100.02, 100.04, 100.20], [99.9] * 3, [99.95, 99.99, 99.95]), [(1, +1, 100.0, 0, 3)], 3, 50)
    assert list(ev["t"]) == [1] and list(ev["dir"]) == [-1], ev
    # closing beyond the level is a breakout: consumed, no event, and no event later either
    ev = sweep_events(_mini([100.04, 100.04], [99.9] * 2, [100.03, 99.99]), [(1, +1, 100.0, 0, 2)], 3, 50)
    assert len(ev) == 0, ev
    # 60 bps beyond is too far: consumed, no event
    ev = sweep_events(_mini([100.60, 100.04], [99.9] * 2, [99.9, 99.99]), [(1, +1, 100.0, 0, 2)], 3, 50)
    assert len(ev) == 0, ev
    # a low level swept is a long
    ev = sweep_events(_mini([100.1], [99.96], [100.01]), [(2, -1, 100.0, 0, 1)], 3, 50)
    assert list(ev["dir"]) == [1] and list(ev["bits"]) == [2], ev
    # two levels swept by one bar make a stack of 2 and one trade
    ev = sweep_events(_mini([100.05], [99.0], [99.9]), [(1, +1, 100.0, 0, 1), (2, +1, 100.01, 0, 1)], 3, 50)
    assert list(ev["stack"]) == [2] and list(ev["bits"]) == [3] and len(ev) == 1, ev
    # a bar that sweeps a high level and a low level is dropped as ambiguous
    ev = sweep_events(_mini([100.05], [98.95], [99.5]), [(1, +1, 100.0, 0, 1), (1, -1, 99.0, 0, 1)], 3, 50)
    assert len(ev) == 0, ev
    # one position at a time: the event on the last held bar (22) is ignored, the next (23) is taken
    e = pd.DataFrame({"t": [10, 15, 22, 23], "side": 1, "bits": 1, "stack": 1, "dir": -1})
    assert list(form_trades(e, np.ones(40, bool), 12)["t"]) == [10, 23]
    # events outside the window or without consecutive bars are not candidates and do not block
    elig = np.ones(40, bool)
    elig[10] = False
    assert list(form_trades(e, elig, 12)["t"]) == [15], form_trades(e, elig, 12)
    # return arithmetic: short from 100 to 99 is +100 bps gross; $0.60 on a $100 entry is 60 bps
    bb = {"o": np.array([0, 100.0] + [0] * 14), "c": np.array([0.0] * 12 + [99.0] + [0.0] * 3)}   # entry: open of bar 1; exit: close of bar 12
    tr = pd.DataFrame({"t": [0], "dir": [-1]})
    usd, bps, cost = returns(bb, tr, 12)
    assert abs(bps[0] - 100) < 1e-9 and abs(usd[0] - 1.0) < 1e-9 and abs(cost[0] - 60) < 1e-9, (usd, bps, cost)
    # eligibility: a gap inside the held bars removes the event
    ts = (np.arange(30) * BAR_NS + np.datetime64("2024-01-03T10:00", "ns").astype("int64")).astype("datetime64[ns]")
    bg = {"h": np.zeros(30), "ts": ts.copy(), "mod": np.full(30, 600), "wd": np.zeros(30, int)}
    assert eligible(bg, 12)[:18].all() and not eligible(bg, 12)[18:].any()
    bg["ts"][8:] += np.timedelta64(5, "m")
    assert not eligible(bg, 12)[:8].any() and eligible(bg, 12)[8]
    print("unit checks passed")

    # end to end on synthetic random-walk bars: nothing here is market data
    rng = np.random.default_rng(7)
    all_ts = pd.date_range("2023-01-01 23:00", "2026-10-28 23:55", freq="5min", tz="UTC")
    keep = ~(((all_ts.weekday == 5)) | ((all_ts.weekday == 6) & (all_ts.hour < 23)) | ((all_ts.weekday == 4) & (all_ts.hour >= 22)) | (all_ts.hour == 21))
    tsx = all_ts[keep]
    n = len(tsx)
    r = rng.normal(0, 6.6e-4, n)
    close = 1900 * np.exp(np.cumsum(r))
    open_ = np.r_[close[0], close[:-1]]
    spread = np.abs(rng.normal(0, 3e-4, (2, n)))
    high, low = np.maximum(open_, close) * (1 + spread[0]), np.minimum(open_, close) * (1 - spread[1])
    df = pd.DataFrame({"open_time": tsx, "open": open_, "high": high, "low": low, "close": close})
    b = prepare(df)
    for mp in (3.0, 2.0):
        fast = sweep_events(b, build_levels(b)[0], mp, MAX_PEN_BPS).sort_values(["t", "side"]).reset_index(drop=True)
        slow = naive_events(b, mp, MAX_PEN_BPS).sort_values(["t", "side"]).reset_index(drop=True)
        pd.testing.assert_frame_equal(fast, slow, check_dtype=False)
        assert len(fast) > 100, "the cross-check needs events to mean anything"
    print("level construction and sweep events match an independent bar-by-bar reading")
    out = run(b, count_only=True)
    assert not out["floor"], "the real floor must not be met by this much synthetic data (events are sparse); the check below lowers it only to reach the outcome stage"
    out = run(b, n_boot=300, n_shifts=60, floor_trades=50, floor_days=30)
    assert out["floor"]
    lo, hi = idx_at(b, PRIMARY_START), idx_at(b, PRIMARY_END_EXCL)
    levels, _ = build_levels(b)
    tr = in_range(trades_for(b, levels), lo, hi)
    assert (np.diff(tr["t"].to_numpy()) > HOLD).all(), "trades overlap"
    assert (b["mod"][tr["t"].to_numpy()] >= WINDOW_MIN[0]).all() and (b["mod"][tr["t"].to_numpy()] <= WINDOW_MIN[1]).all() and (b["wd"][tr["t"].to_numpy()] < 5).all()
    print("end-to-end synthetic run passed")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--selftest":
        selftest()
    elif len(sys.argv) >= 2:
        run(prepare(load_bars(sys.argv[1])), count_only=len(sys.argv) >= 3 and sys.argv[2] == "count-only")
    else:
        print(__doc__)
