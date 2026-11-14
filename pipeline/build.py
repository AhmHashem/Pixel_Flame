"""Build the harmonized burning-activity dataset consumed by the web app.

Steps per country:
  1. Clean   - keep vegetation fires (type 0) with adequate confidence; remember
               static heat sources (type 1/2) to mask the NRT feed later.
  2. Outages - find days when VIIRS S-NPP saw (almost) nothing while NOAA-20 or MODIS
               kept detecting fires, summed over all configured countries.
  3. Grid    - aggregate detections to GRID_DEG cells x 52 weeks/year.
  4. Harmonize
      a. Terra-only years (2000-2002) -> Terra+Aqua scale, month-specific ratio
         fitted on 2003-2011.
      b. MODIS (Terra+Aqua) -> VIIRS S-NPP scale, month-specific ratio fitted on
         the 2012-2020 overlap (before Terra/Aqua orbit drift).
      c. NOAA-20 -> S-NPP, month-specific ratio fitted on 2023-2025.
      d. S-NPP outage days are filled with NOAA-20 (or MODIS before NOAA-20 data)
         converted to the S-NPP scale.
      Ratios are shrunk toward the all-year ratio when a month has few detections,
      and weeks touched by an outage are left out of every fit.
  5. Validate - refit on 2012-2017, predict VIIRS 2018-2020 from MODIS alone.
  6. Export  - one JSON per country, per-year binary hotspot files for the CSV
               export, and one JSON for the live NRT hotspots.

Usage: python pipeline/build.py [Country ...]   (default: all in config.COUNTRIES)
"""
import json
import re
import sys

import numpy as np
import pandas as pd

from config import (API_META, API_YEAR, AQUA_FIT_YEARS, COUNTRIES, FIRST_YEAR, GRID_DEG,
                    HOTSPOT_DIR, MASK_DEG, MODIS_MIN_CONF, MODIS_YEARS, NOAA20_FIT_YEARS,
                    NOAA20_YEARS, NRT_DIR, OUT_DIR, OVERLAP_FIT_YEARS, RAW_DIR,
                    SHRINK_K, VALIDATION_TEST, VALIDATION_TRAIN, VIIRS_KEEP_CONF,
                    VIIRS_YEARS, WEEKS)

LAST_YEAR = max(MODIS_YEARS)
N_WEEKS = (LAST_YEAR - FIRST_YEAR + 1) * WEEKS
COLS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence",
        "frp", "daynight", "type"]
SAT_CODE = {"terra": 0, "aqua": 1, "snpp": 2, "noaa20": 3}

# Month (1-12) of each week-of-year, taken at the week's middle day
WEEK_MONTH = np.array([(pd.Timestamp(2001, 1, 1) + pd.Timedelta(days=w * 7 + 3)).month
                       for w in range(WEEKS)])


def week_index(dates: pd.Series) -> np.ndarray:
    """Global week index: (year - FIRST_YEAR) * 52 + week-of-year (0..51)."""
    d = pd.to_datetime(dates)
    woy = np.minimum((d.dt.dayofyear.to_numpy() - 1) // 7, WEEKS - 1)
    return (d.dt.year.to_numpy() - FIRST_YEAR) * WEEKS + woy


def week_end(w: int) -> pd.Timestamp:
    y, k = FIRST_YEAR + w // WEEKS, w % WEEKS
    return pd.Timestamp(y, 12, 31) if k == WEEKS - 1 else pd.Timestamp(y, 1, 1) + pd.Timedelta(days=7 * k + 6)


def record_end() -> tuple[int, pd.Timestamp, dict | None]:
    """Last week with complete data. Without API data the record ends with the last archive year."""
    end, meta = pd.Timestamp(API_YEAR - 1, 12, 31), None
    if API_META.exists():
        meta = json.loads(API_META.read_text())
        end = pd.Timestamp(meta["end"])
    w = int(week_index(pd.Series([end]))[0])
    if week_end(w) > end:
        w -= 1
    return w, week_end(w), meta


def load(sensor: str, years, country: str) -> pd.DataFrame:
    """Archive and API files share the FIRMS columns; near-real-time rows have no `type`."""
    frames = []
    for y in years:
        f = RAW_DIR / f"{sensor}_{y}_{country}.csv"
        if f.exists():
            df = pd.read_csv(f, usecols=lambda c: c in COLS, dtype={"confidence": str})
            for c in COLS:
                if c not in df:
                    df[c] = np.nan
            df["type"] = pd.to_numeric(df["type"], errors="coerce")
            frames.append(df[COLS])
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=COLS)


def static_keys(df: pd.DataFrame) -> set:
    s = df[df["type"].isin([1, 2])]
    return set(zip(np.round(s.latitude / MASK_DEG).astype(int),
                   np.round(s.longitude / MASK_DEG).astype(int)))


def vegetation(df: pd.DataFrame, mask: set) -> np.ndarray:
    """FIRMS type 0. Rows without a type (near-real-time) count unless they sit on a known
    static heat source (gas flare, industry, volcano) seen in the archive."""
    t = df["type"]
    unknown = t.isna().to_numpy()
    static = np.zeros(len(df), bool)
    if unknown.any():
        sub = df[unknown]
        keys = zip(np.round(sub.latitude / MASK_DEG).astype(int), np.round(sub.longitude / MASK_DEG).astype(int))
        static[unknown] = np.fromiter((k in mask for k in keys), bool, count=len(sub))
    return (t == 0).to_numpy() | (unknown & ~static)


def clean_modis(df: pd.DataFrame, mask: set) -> pd.DataFrame:
    conf = pd.to_numeric(df["confidence"], errors="coerce")
    return df[vegetation(df, mask) & (conf >= MODIS_MIN_CONF).to_numpy()].copy()


def clean_viirs(df: pd.DataFrame, mask: set) -> pd.DataFrame:
    keep = df["confidence"].astype(str).str.lower().isin(VIIRS_KEEP_CONF).to_numpy()
    return df[vegetation(df, mask) & keep].copy()


def grid(df: pd.DataFrame, ratios=None, frp_ratios=None) -> pd.DataFrame:
    """Aggregate detections to (cell_i, cell_j, week) with count and FRP sum.
    The last week of each year spans 8-9 days, so it is scaled to a 7-day equivalent.
    Optional month-specific ratios convert another sensor to the S-NPP scale."""
    if df.empty:
        return pd.DataFrame({"ci": [], "cj": [], "w": [], "n": [], "frp": []}).astype(
            {"ci": int, "cj": int, "w": int})
    d = pd.to_datetime(df.acq_date)
    w = week_index(df.acq_date)
    last_len = 365 + d.dt.is_leap_year.to_numpy() - (WEEKS - 1) * 7
    wt = np.where(w % WEEKS == WEEKS - 1, 7 / last_len, 1.0)
    month = WEEK_MONTH[w % WEEKS] - 1
    wn = wt * (ratios[month] if ratios is not None else 1)
    wf = wt * (frp_ratios[month] if frp_ratios is not None else (ratios[month] if ratios is not None else 1))
    g = pd.DataFrame({
        "ci": np.floor(df.latitude / GRID_DEG).astype(int),
        "cj": np.floor(df.longitude / GRID_DEG).astype(int),
        "w": w,
        "n": wn,
        "frp": df.frp.fillna(0).to_numpy() * wf,
    })
    return g.groupby(["ci", "cj", "w"]).sum().reset_index()


def weekly_totals(g: pd.DataFrame, col: str) -> np.ndarray:
    out = np.zeros(N_WEEKS)
    s = g.groupby("w")[col].sum()
    out[s.index.to_numpy().astype(int)] = s.to_numpy()
    return out


def year_mask(years) -> np.ndarray:
    w = np.arange(N_WEEKS)
    y = FIRST_YEAR + w // WEEKS
    return (y >= years[0]) & (y <= years[1])


def week_mask(dates) -> np.ndarray:
    m = np.zeros(N_WEEKS, bool)
    if len(dates):
        m[week_index(pd.Series(sorted(dates)))] = True
    return m


def monthly_ratio(num: np.ndarray, den: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Per-calendar-month ratio sum(num)/sum(den), shrunk toward the overall ratio."""
    overall = num[mask].sum() / max(den[mask].sum(), 1e-9)
    month = WEEK_MONTH[np.arange(N_WEEKS) % WEEKS]
    r = np.empty(12)
    for m in range(1, 13):
        sel = mask & (month == m)
        r[m - 1] = (num[sel].sum() + SHRINK_K * overall) / (den[sel].sum() + SHRINK_K)
    return r


def apply_monthly(values: np.ndarray, weeks: np.ndarray, ratios: np.ndarray) -> np.ndarray:
    return values * ratios[WEEK_MONTH[weeks % WEEKS] - 1]


def metrics(actual: np.ndarray, pred: np.ndarray) -> dict:
    la, lp = np.log1p(actual), np.log1p(pred)
    return {
        "r_weekly": round(float(np.corrcoef(actual, pred)[0, 1]), 3),
        "r_log": round(float(np.corrcoef(la, lp)[0, 1]), 3),
        "bias_pct": round(float((pred.sum() / actual.sum() - 1) * 100), 1),
        "mae_log": round(float(np.mean(np.abs(la - lp))), 3),
    }


def runs(dates) -> list:
    """Group sorted ISO dates into [first, last] runs of consecutive days."""
    out = []
    for d in sorted(pd.to_datetime(list(dates))):
        if out and (d - out[-1][1]).days == 1:
            out[-1][1] = d
        else:
            out.append([d, d])
    return [[a.strftime("%Y-%m-%d"), b.strftime("%Y-%m-%d")] for a, b in out]


# ---------------------------------------------------------------- outages
def daily_counts(sensor: str, years) -> pd.Series:
    """Raw detections per day, summed over all configured countries."""
    parts = []
    for key in COUNTRIES.values():
        for y in years:
            f = RAW_DIR / f"{sensor}_{y}_{key}.csv"
            if f.exists():
                parts.append(pd.read_csv(f, usecols=["acq_date"]).acq_date.value_counts())
    return pd.concat(parts).groupby(level=0).sum() if parts else pd.Series(dtype=float)


def detect_outages() -> dict:
    """A sensor is 'out' on a day when it reports nothing (or < 30% of what the
    reference sensor implies) while the reference clearly sees fires. Counts are
    pooled over all countries so small ones (Egypt) inherit the detection."""
    snpp = daily_counts("viirs-snpp", VIIRS_YEARS)
    n20 = daily_counts("viirs-jpss1", NOAA20_YEARS)
    modis = daily_counts("modis", VIIRS_YEARS)
    idx = pd.date_range(snpp.index.min(), f"{max(VIIRS_YEARS)}-12-31").strftime("%Y-%m-%d")
    s, n, m = (x.reindex(idx, fill_value=0).astype(float) for x in (snpp, n20, modis))
    has_n20 = (idx >= n20.index.min()) & (idx <= n20.index.max()) if len(n20) else np.zeros(len(idx), bool)

    def low(obs, exp):
        return ((obs == 0) & (exp >= 20)) | ((obs < 0.3 * exp) & (exp >= 50))

    both = has_n20 & (s > 0) & (n > 0)
    k_n = s[both].sum() / max(n[both].sum(), 1)
    k_m = s[m > 0].sum() / max(m[m > 0].sum(), 1)
    n20_out = has_n20 & low(n, s / k_n).to_numpy()
    use_n20 = has_n20 & ~n20_out
    snpp_out = np.where(use_n20, low(s, n * k_n), low(s, m * k_m))
    out = {
        "snpp": set(idx[snpp_out]),
        "noaa20": set(idx[n20_out]),
        "fill_noaa20": set(idx[snpp_out & use_n20]),
        "fill_modis": set(idx[snpp_out & ~use_n20]),
    }
    print(f"Outages: S-NPP {len(out['snpp'])} days ({len(out['fill_noaa20'])} filled from NOAA-20, "
          f"{len(out['fill_modis'])} from MODIS); NOAA-20 {len(out['noaa20'])} days")
    for a, b in runs(out["snpp"]):
        print(f"  S-NPP out {a}" + (f" -> {b}" if b != a else ""))
    return out


# ---------------------------------------------------------------- calibration
def calibrate_noaa20(snpp_tot: np.ndarray, n20: pd.DataFrame, bad_weeks: np.ndarray) -> dict | None:
    """Month-specific NOAA-20 -> S-NPP ratio on weekly totals over NOAA20_FIT_YEARS,
    leaving out weeks in which either sensor had an outage day."""
    if n20.empty:
        return None
    n20_tot = weekly_totals(grid(n20), "n")
    w = np.arange(N_WEEKS)
    w0 = int(week_index(pd.Series([n20.acq_date.min()]))[0]) + 1
    w1 = int(week_index(pd.Series([n20.acq_date.max()]))[0]) - 1
    span = year_mask(NOAA20_FIT_YEARS) & (w >= w0) & (w <= w1)
    fit = span & (snpp_tot > 0) & (n20_tot > 0) & ~bad_weeks
    if fit.sum() < 10:
        return None
    ratio = monthly_ratio(snpp_tot, n20_tot, fit)
    wf = np.where(fit)[0]
    return {
        "ratio": np.round(ratio, 3).tolist(),
        "overall": round(float(snpp_tot[fit].sum() / n20_tot[fit].sum()), 3),
        "years": list(NOAA20_FIT_YEARS),
        "weeks_used": int(fit.sum()),
        "weeks_excluded": int((span & bad_weeks).sum()),
        **metrics(snpp_tot[wf], apply_monthly(n20_tot[wf], wf, ratio)),
    }


# ---------------------------------------------------------------- export
def export_hotspots(key: str, parts: list) -> dict:
    """Write detections, one compact binary file per year, for the in-browser hotspot
    CSV export. `parts` is a list of (dataframe, satellite code, used-in-calendar mask).
    Little-endian layout:
        uint32 n | uint16 lat[n] | uint16 lon[n] | uint16 day_of_year0[n] |
        uint16 hhmm[n] | uint16 frp_x10[n] | uint8 flags[n] | uint8 conf[n]
    lat/lon are offsets from (lat0, lon0) in units of `step` degrees (< 30 m).
    flags: bits 0-1 satellite (0 Terra, 1 Aqua, 2 S-NPP, 3 NOAA-20), bit 2 night pass,
           bit 3 counted in the harmonized calendar.
    conf: MODIS 0-100; VIIRS 1 nominal, 2 high. FRP is capped at 6553.5 MW."""
    frames = []
    for df, sat, used in parts:
        if df.empty:
            continue
        is_modis = sat is None
        frames.append(pd.DataFrame({
            "latitude": df.latitude.to_numpy(), "longitude": df.longitude.to_numpy(),
            "date": pd.to_datetime(df.acq_date).to_numpy(),
            "hhmm": pd.to_numeric(df.acq_time, errors="coerce").fillna(0).to_numpy(),
            "frp": df.frp.fillna(0).to_numpy(),
            "sat": np.where(df.satellite.isin(["Aqua", "A"]), 1, 0) if is_modis else sat,
            "night": df.daynight.eq("N").to_numpy(),
            "used": used,
            "conf": (pd.to_numeric(df.confidence, errors="coerce").fillna(0).clip(0, 100).to_numpy() if is_modis
                     else np.where(df.confidence.astype(str).str.lower().str[0] == "h", 2, 1)),
        }))
    d = pd.concat(frames, ignore_index=True)
    lat0 = float(np.floor(d.latitude.min() * 100) / 100)
    lon0 = float(np.floor(d.longitude.min() * 100) / 100)
    span = max(d.latitude.max() - lat0, d.longitude.max() - lon0)
    step = float(np.ceil(span / 65000 * 1e6) / 1e6)
    HOTSPOT_DIR.mkdir(parents=True, exist_ok=True)
    for old in HOTSPOT_DIR.glob(f"{key}_*.bin"):
        old.unlink()
    years, total_bytes = [], 0
    for y, g in d.groupby(d.date.dt.year):
        g = g.sort_values(["date", "hhmm"])
        u16 = [np.round((g.latitude - lat0) / step), np.round((g.longitude - lon0) / step),
               g.date.dt.dayofyear - 1, g.hhmm, np.clip(np.round(g.frp * 10), 0, 65535)]
        flags = (g.sat.to_numpy().astype(np.uint8) | (g.night.to_numpy().astype(np.uint8) << 2)
                 | (g.used.to_numpy().astype(np.uint8) << 3))
        blob = b"".join([np.array([len(g)], "<u4").tobytes(),
                         *(np.asarray(a, dtype=np.float64).astype("<u2").tobytes() for a in u16),
                         flags.astype("u1").tobytes(), g.conf.to_numpy().astype("u1").tobytes()])
        (HOTSPOT_DIR / f"{key}_{y}.bin").write_bytes(blob)
        total_bytes += len(blob)
        years.append([int(y), int(len(g))])
    print(f"  hotspots: {len(d):,} detections in {len(years)} files ({total_bytes / 1e6:.1f} MB)")
    return {"lat0": lat0, "lon0": lon0, "step": step, "years": years,
            "path": f"hotspots/{key}_{{year}}.bin"}


# ---------------------------------------------------------------- country
def build_country(name: str, key: str, out: dict, last_week: int, last_date: pd.Timestamp) -> tuple[dict, set]:
    modis_raw = load("modis", MODIS_YEARS, key)
    viirs_raw = load("viirs-snpp", VIIRS_YEARS, key)
    n20_raw = load("viirs-jpss1", NOAA20_YEARS, key)
    mask = static_keys(modis_raw) | static_keys(viirs_raw) | static_keys(n20_raw)
    modis, viirs, n20 = clean_modis(modis_raw, mask), clean_viirs(viirs_raw, mask), clean_viirs(n20_raw, mask)
    print(f"{name}: MODIS {len(modis_raw):,} -> {len(modis):,}, "
          f"VIIRS {len(viirs_raw):,} -> {len(viirs):,}, NOAA-20 {len(n20_raw):,} -> {len(n20):,}, "
          f"static cells {len(mask):,}")

    snpp_bad = viirs.acq_date.isin(out["snpp"])
    viirs_ok = viirs[~snpp_bad]
    terra = grid(modis[modis.satellite.isin(["Terra", "T"])])
    aqua = grid(modis[modis.satellite.isin(["Aqua", "A"])])
    vg = grid(viirs_ok)

    tot = {k: weekly_totals(g, "n") for k, g in (("terra", terra), ("aqua", aqua), ("viirs", vg))}
    frp = {k: weekly_totals(g, "frp") for k, g in (("terra", terra), ("aqua", aqua), ("viirs", vg))}

    first_week = int(week_index(pd.Series([modis.acq_date.min()]))[0])
    viirs_start = int(week_index(pd.Series([viirs.acq_date.min()]))[0]) + 1  # first full week
    aqua_start = (2003 - FIRST_YEAR) * WEEKS
    outage_weeks = week_mask(out["snpp"])
    valid_v = (np.arange(N_WEEKS) >= viirs_start) & ~outage_weeks

    # a. Terra-only -> Terra+Aqua
    fit_a = year_mask(AQUA_FIT_YEARS)
    k_aqua = monthly_ratio(tot["terra"] + tot["aqua"], tot["terra"], fit_a)
    k_aqua_frp = monthly_ratio(frp["terra"] + frp["aqua"], frp["terra"], fit_a)

    # MODIS combined, cell level
    mod = pd.concat([terra, aqua]).groupby(["ci", "cj", "w"]).sum().reset_index()
    early = terra[terra.w < aqua_start].copy()
    early["n"] = apply_monthly(early.n.to_numpy(), early.w.to_numpy(), k_aqua)
    early["frp"] = apply_monthly(early.frp.to_numpy(), early.w.to_numpy(), k_aqua_frp)
    mod = pd.concat([early, mod[mod.w >= aqua_start]], ignore_index=True)
    mod_tot, mod_frp = weekly_totals(mod, "n"), weekly_totals(mod, "frp")

    # b. MODIS -> VIIRS
    fit_v = year_mask(OVERLAP_FIT_YEARS) & valid_v
    a_viirs = monthly_ratio(tot["viirs"], mod_tot, fit_v)
    a_viirs_frp = monthly_ratio(frp["viirs"], mod_frp, fit_v)

    # 5. Validation: train 2012-2017, test 2018-2020 on weekly country totals
    tr, te = year_mask(VALIDATION_TRAIN) & valid_v, year_mask(VALIDATION_TEST) & valid_v
    a_tr = monthly_ratio(tot["viirs"], mod_tot, tr)
    single = tot["viirs"][tr].sum() / mod_tot[tr].sum()
    w_te = np.where(te)[0]
    pred_te = apply_monthly(mod_tot[w_te], w_te, a_tr)
    # cell x month level check (sub-country AOIs)
    cm = mod[mod.w.isin(w_te)].assign(m=lambda d: WEEK_MONTH[d.w % WEEKS])
    cm["pred"] = apply_monthly(cm.n.to_numpy(), cm.w.to_numpy(), a_tr)
    cv = vg[vg.w.isin(w_te)].assign(m=lambda d: WEEK_MONTH[d.w % WEEKS])
    cell_month = (cm.assign(y=cm.w // WEEKS).groupby(["ci", "cj", "y", "m"]).pred.sum().to_frame()
                  .join(cv.assign(y=cv.w // WEEKS).groupby(["ci", "cj", "y", "m"]).n.sum(), how="outer")
                  .fillna(0))
    validation = {
        "train": list(VALIDATION_TRAIN), "test": list(VALIDATION_TEST),
        "monthly_model": metrics(tot["viirs"][w_te], pred_te),
        "single_ratio": metrics(tot["viirs"][w_te], mod_tot[w_te] * single),
        "cell_month_r_log": round(float(np.corrcoef(np.log1p(cell_month.n), np.log1p(cell_month.pred))[0, 1]), 3),
        "weeks": w_te.tolist(),
        "actual": np.round(tot["viirs"][w_te]).astype(int).tolist(),
        "predicted": np.round(pred_te, 1).tolist(),
    }

    # c. NOAA-20 -> S-NPP (weeks with an outage of either sensor are not used)
    noaa20 = calibrate_noaa20(tot["viirs"], n20, outage_weeks | week_mask(out["noaa20"]))
    if noaa20:
        print(f"  NOAA-20 -> S-NPP: x{noaa20['overall']} overall, r={noaa20['r_weekly']}, "
              f"{noaa20['weeks_used']} weeks ({noaa20['weeks_excluded']} outage weeks excluded)")
    k_n20 = np.array(noaa20["ratio"]) if noaa20 else np.full(12, 1.0)

    # d. Fill S-NPP outage days
    n20_fill = n20[n20.acq_date.isin(out["fill_noaa20"])]
    modis_fill = modis[modis.acq_date.isin(out["fill_modis"]) & (week_index(modis.acq_date) >= viirs_start)]
    if not noaa20:   # no NOAA-20 calibration for this country: fall back to MODIS on those days too
        modis_fill = modis[modis.acq_date.isin(out["snpp"]) & (week_index(modis.acq_date) >= viirs_start)]
        n20_fill = n20.iloc[0:0]
    fills = [grid(n20_fill, k_n20), grid(modis_fill, a_viirs, a_viirs_frp)]
    print(f"  outage fill: {len(n20_fill):,} NOAA-20 + {len(modis_fill):,} MODIS detections")

    # Harmonized cell-level record: converted MODIS before VIIRS, VIIRS S-NPP after
    pre = mod[mod.w < viirs_start].copy()
    pre["n"] = apply_monthly(pre.n.to_numpy(), pre.w.to_numpy(), a_viirs)
    pre["frp"] = apply_monthly(pre.frp.to_numpy(), pre.w.to_numpy(), a_viirs_frp)
    harm = pd.concat([pre, vg[vg.w >= viirs_start], *fills], ignore_index=True)
    harm = harm[harm.w <= last_week]          # the current year stops at the last complete week
    harm = harm.groupby(["ci", "cj", "w"]).sum().reset_index().sort_values(["ci", "cj", "w"])

    cells = []
    for (ci, cj), g in harm.groupby(["ci", "cj"], sort=False):
        w = g.w.to_numpy().astype(int)
        cells.append([int(ci), int(cj),
                      np.diff(w, prepend=0).tolist(),          # delta-encoded week index
                      np.round(g.n.to_numpy(), 1).tolist(),
                      np.round(g.frp.to_numpy()).astype(int).tolist()])

    series = {k: np.round(v[:last_week + 1], 1).tolist() for k, v in {
        "terra": tot["terra"], "aqua": tot["aqua"], "modis": mod_tot,
        "viirs": tot["viirs"], "harmonized": weekly_totals(harm, "n")}.items()}

    mw = week_index(modis.acq_date)
    hotspots = export_hotspots(key, [
        (modis, None, (mw < viirs_start) | modis.index.isin(modis_fill.index)),
        (viirs, SAT_CODE["snpp"], ~snpp_bad.to_numpy() & (week_index(viirs.acq_date) >= viirs_start)),
        (n20_fill, SAT_CODE["noaa20"], np.ones(len(n20_fill), bool)),
    ])

    lat, lon = viirs.latitude, viirs.longitude
    return {
        "name": name,
        "grid": GRID_DEG, "firstYear": FIRST_YEAR, "weeksPerYear": WEEKS, "nWeeks": last_week + 1,
        "lastDate": last_date.strftime("%Y-%m-%d"),
        "firstWeek": first_week, "viirsStart": viirs_start, "aquaStart": aqua_start,
        "bbox": [float(lat.min()), float(lon.min()), float(lat.max()), float(lon.max())],
        "ratios": {
            "terra_to_modis": np.round(k_aqua, 3).tolist(),
            "modis_to_viirs": np.round(a_viirs, 3).tolist(),
            "modis_to_viirs_frp": np.round(a_viirs_frp, 3).tolist(),
            "single_ratio_train": round(float(single), 3),
        },
        "noaa20": noaa20,
        "outages": {
            "snpp_runs": runs(out["snpp"]),
            "days": len(out["snpp"]),
            "filled_noaa20": int(len(n20_fill)),
            "filled_modis": int(len(modis_fill)),
        },
        "validation": validation,
        "hotspots": hotspots,
        "series": series,
        "cells": cells,
    }, mask


def build_nrt(mask: set) -> dict:
    """Live hotspots from the 7-day NRT CSVs, filtered and static-masked."""
    sensors = {"SUOMI_VIIRS": "snpp", "J1_VIIRS": "noaa20", "J2_VIIRS": "noaa21", "MODIS": "modis"}
    cols = {k: [] for k in ("s", "lat", "lon", "frp", "t", "dn")}
    region, dates, coverage = None, set(), {}
    for f in sorted(NRT_DIR.glob("*_7d.csv")):
        code = next((v for k, v in sensors.items() if f.name.startswith(k)), None)
        if code is None:
            continue
        region = region or re.sub(r"^.*?_C\d+(_\d+)?_|_7d$", "", f.stem).replace("_", " ")
        df = pd.read_csv(f, dtype={"confidence": str, "acq_time": str})
        if df.empty:   # a satellite can stop delivering (S-NPP in Nov 2026); the app then falls back
            coverage[code] = {"hotspots": 0, "days": []}
            print(f"NRT {code}: no data in {f.name}")
            continue
        if code == "modis":
            df = df[pd.to_numeric(df.confidence, errors="coerce") >= MODIS_MIN_CONF]
        else:
            df = df[df.confidence.astype(str).str.lower().isin(VIIRS_KEEP_CONF)]
        if df.empty:
            coverage[code] = {"hotspots": 0, "days": []}
            continue
        keys = zip(np.round(df.latitude / MASK_DEG).astype(int), np.round(df.longitude / MASK_DEG).astype(int))
        df = df.loc[np.fromiter((k not in mask for k in keys), bool, count=len(df))]
        dates |= set(df.acq_date)
        coverage[code] = {"hotspots": int(len(df)), "days": sorted(set(df.acq_date))}
        ts = pd.to_datetime(df.acq_date + " " + df.acq_time.str.zfill(4), format="%Y-%m-%d %H%M")
        cols["s"] += [code] * len(df)
        cols["lat"] += np.round(df.latitude, 4).tolist()
        cols["lon"] += np.round(df.longitude, 4).tolist()
        cols["frp"] += np.round(df.frp, 1).tolist()
        cols["t"] += ((ts - pd.Timestamp(0)) // pd.Timedelta(minutes=1)).tolist()   # minutes since epoch, UTC
        cols["dn"] += df.daynight.tolist()
        print(f"NRT {code}: {len(df):,} hotspots")
    d = sorted(dates)
    return {"region": region, "start": d[0], "end": d[-1], "coverage": coverage, **cols}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    last_week, last_date, meta = record_end()
    print(f"Record ends {last_date.date()} (week {last_week}); "
          + (f"{API_YEAR} from the FIRMS API to {meta['end']}" if meta else f"no {API_YEAR} API data"))
    out = detect_outages()
    mask, index = set(), []
    for name, key in COUNTRIES.items():
        if only and name not in only:
            continue
        data, m = build_country(name, key, out, last_week, last_date)
        mask |= m
        v = data["validation"]["monthly_model"]
        print(f"  validation {VALIDATION_TEST}: r={v['r_weekly']} r_log={v['r_log']} bias={v['bias_pct']}%")
        path = OUT_DIR / f"{key}.json"
        path.write_text(json.dumps(data, separators=(",", ":")))
        index.append({"name": name, "file": path.name, "bbox": data["bbox"],
                      "lastYear": int(last_date.year), "lastDate": data["lastDate"]})
        print(f"  wrote {path.name} ({path.stat().st_size / 1e6:.1f} MB, {len(data['cells']):,} cells)")
    nrt = build_nrt(mask)
    (OUT_DIR / "nrt.json").write_text(json.dumps(nrt, separators=(",", ":")))
    api = None
    if meta:
        api = {"year": meta["year"], "end": meta["end"], "boundary": meta["boundary"],
               "spEnd": {k: v["sp_end"] for k, v in meta["sources"].items()}}
    (OUT_DIR / "index.json").write_text(json.dumps(
        {"countries": index, "api": api,
         "nrt": {"file": "nrt.json", "start": nrt["start"], "end": nrt["end"], "region": nrt["region"]}},
        indent=1))
    print("done")


if __name__ == "__main__":
    main()
