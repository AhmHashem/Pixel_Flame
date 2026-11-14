"""Download FIRMS data into data/.

  - yearly country archives (MODIS C6.1, VIIRS S-NPP, VIIRS NOAA-20) up to last year -> data/raw (cached)
  - the current year from the FIRMS area API (standard processing where published, near-real-time
    after it), clipped to the country border -> data/raw/<sensor>_<year>_<Country>.csv
  - live 7-day files for the NRT region -> data/ (always refreshed)

Usage: python pipeline/download.py [--nrt-only] [--no-api] [Country ...]
The API part needs a MAP_KEY in the FIRMS_MAP_KEY environment variable or in firms_map_key.txt.
"""
import datetime as dt
import gzip
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

from config import (API_AREA_URL, API_AVAIL_URL, API_DIR, API_MAX_DAYS, API_META,
                    API_SOURCES, API_YEAR, ARCHIVE_URL, BOUNDARY_FILE, BOUNDARY_URL,
                    COUNTRIES, MAP_KEY_FILE, MODIS_YEARS, NOAA20_YEARS, NRT_DIR,
                    NRT_REGION, NRT_URLS, RAW_DIR, VIIRS_YEARS)


def download(url: str, dest: Path, label: str = "") -> bool:
    tmp = dest.with_suffix(".part")
    try:
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        tmp.replace(dest)
        print(f"ok   {label or dest.name} ({dest.stat().st_size / 1e6:.1f} MB)", flush=True)
        return True
    except urllib.error.HTTPError as e:
        print(f"skip {label or dest.name}: HTTP {e.code}", flush=True)
        tmp.unlink(missing_ok=True)
        return False


def fetch_archive(sensor: str, year: int, country: str) -> None:
    dest = RAW_DIR / f"{sensor}_{year}_{country}.csv"
    if dest.exists() and dest.stat().st_size > 0:
        return
    download(ARCHIVE_URL.format(sensor=sensor, year=year, country=country), dest)


def fetch_nrt() -> None:
    for prefix, url in NRT_URLS.items():
        download(url.format(region=NRT_REGION), NRT_DIR / f"{prefix}_{NRT_REGION}_7d.csv")


# ---------------------------------------------------------------- FIRMS API
def map_key() -> str | None:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not key and MAP_KEY_FILE.exists():
        key = MAP_KEY_FILE.read_text().strip().splitlines()[0].strip()
    return key or None


def get_text(url: str, tries: int = 4) -> str:
    """GET with retries; never prints the URL (it contains the MAP_KEY)."""
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return r.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError) as e:
            code = getattr(e, "code", None)
            if code == 400 or i == tries - 1:
                raise RuntimeError(f"FIRMS API error {code or e}") from None
            time.sleep(5 * (i + 1))
    return ""


def availability(key: str) -> dict:
    df = pd.read_csv(io.StringIO(get_text(API_AVAIL_URL.format(key=key))))
    return {r.data_id: (dt.date.fromisoformat(r.min_date), dt.date.fromisoformat(r.max_date))
            for r in df.itertuples()}


def ensure_boundaries() -> None:
    if not BOUNDARY_FILE.exists():
        BOUNDARY_FILE.parent.mkdir(parents=True, exist_ok=True)
        download(BOUNDARY_URL, BOUNDARY_FILE)


def api_chunks(start: dt.date, end: dt.date, sp: tuple, nrt: tuple):
    """Yield (processing, first_day, n_days) windows of <= API_MAX_DAYS that never mix SP and NRT."""
    day = start
    while day <= end:
        if sp and sp[0] <= day <= sp[1]:
            proc, stop = "SP", min(sp[1], end)
        elif nrt and nrt[0] <= day <= nrt[1]:
            proc, stop = "NRT", min(nrt[1], end)
        else:
            day += dt.timedelta(days=1)
            continue
        n = min(API_MAX_DAYS, (stop - day).days + 1)
        yield proc, day, n
        day += dt.timedelta(days=n)


def fetch_api_year(countries: list) -> None:
    import geo   # needs matplotlib; only imported when the API part runs
    key = map_key()
    if not key:
        print(f"no MAP_KEY: skipping {API_YEAR} (set FIRMS_MAP_KEY or create {MAP_KEY_FILE.name})")
        return
    ensure_boundaries()
    API_DIR.mkdir(parents=True, exist_ok=True)
    avail = availability(key)
    today = dt.datetime.now(dt.timezone.utc).date()
    end = min(today - dt.timedelta(days=1), dt.date(API_YEAR, 12, 31))     # last complete UTC day
    start = dt.date(API_YEAR, 1, 1)
    meta = {"year": API_YEAR, "end": end.isoformat(), "boundary": "Natural Earth 1:10m admin-0",
            "fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "sources": {}}
    requests = 0
    for country in countries:
        box = ",".join(str(float(v)) for v in geo.bbox(country))
        for sensor, src in API_SOURCES.items():
            sp, nrt = avail.get(f"{src}_SP"), avail.get(f"{src}_NRT")
            meta["sources"][src] = {"sp_end": sp[1].isoformat() if sp else None,
                                    "nrt_end": nrt[1].isoformat() if nrt else None}
            frames = []
            for proc, day, n in api_chunks(start, end, sp, nrt):
                cache = API_DIR / f"{src}_{proc}_{country}_{day.isoformat()}_{n}.csv.gz"
                last = day + dt.timedelta(days=n - 1)
                fresh = proc == "SP" or last < end - dt.timedelta(days=2)
                if cache.exists() and fresh:
                    text = gzip.decompress(cache.read_bytes()).decode("utf-8")
                else:
                    text = get_text(API_AREA_URL.format(key=key, source=f"{src}_{proc}", bbox=box,
                                                        days=n, date=day.isoformat()))
                    requests += 1
                    if not text.startswith("latitude"):
                        raise RuntimeError(f"unexpected API response for {src}_{proc} {day}: {text[:80]!r}")
                    cache.write_bytes(gzip.compress(text.encode("utf-8")))
                df = pd.read_csv(io.StringIO(text), dtype={"confidence": str})
                if len(df):
                    frames.append(df.assign(processing=proc))
            df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
            if df.empty:
                print(f"api  {sensor}_{API_YEAR}_{country}: no detections")
                continue
            if "type" not in df:
                df["type"] = pd.NA
            n_box = len(df)
            df = df[geo.inside(country, df.latitude, df.longitude)]
            dest = RAW_DIR / f"{sensor}_{API_YEAR}_{country}.csv"
            df.to_csv(dest, index=False)
            print(f"api  {dest.name}: {len(df):,} of {n_box:,} bbox detections inside the border, "
                  f"{df.acq_date.min()} -> {df.acq_date.max()} "
                  f"(SP {int((df.processing == 'SP').sum()):,}, NRT {int((df.processing == 'NRT').sum()):,})",
                  flush=True)
    API_META.write_text(json.dumps(meta, indent=1))
    print(f"api  done: {requests} requests, data to {end}")


def main() -> None:
    args = sys.argv[1:]
    countries = [a for a in args if not a.startswith("--")] or list(COUNTRIES.values())
    if "--nrt-only" not in args:
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        for country in countries:
            for year in (y for y in MODIS_YEARS if y < API_YEAR):
                fetch_archive("modis", year, country)
            for year in (y for y in VIIRS_YEARS if y < API_YEAR):
                fetch_archive("viirs-snpp", year, country)
            for year in (y for y in NOAA20_YEARS if y < API_YEAR):
                fetch_archive("viirs-jpss1", year, country)
        if "--no-api" not in args:
            fetch_api_year(countries)
    fetch_nrt()


if __name__ == "__main__":
    main()
