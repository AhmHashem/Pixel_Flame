"""Shared settings for the fire-calendar pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"          # yearly FIRMS country archives (cached)
NRT_DIR = ROOT / "data"                  # 7-day NRT CSVs downloaded from FIRMS
OUT_DIR = ROOT / "web" / "data"          # JSON consumed by the web app
HOTSPOT_DIR = OUT_DIR / "hotspots"       # per-year binary hotspot files (CSV export)

# FIRMS archive file names use underscores for spaces
COUNTRIES = {
    "Sudan": "Sudan",
    "Nigeria": "Nigeria",
    "Egypt": "Egypt",
}
COUNTRY_ISO3 = {"Sudan": "SDN", "Nigeria": "NGA", "Egypt": "EGY"}   # keyed by FIRMS file key

# Yearly archives exist up to the previous year; the current year comes from the FIRMS API
API_YEAR = 2026
MODIS_YEARS = range(2000, API_YEAR + 1)  # Terra from Nov 2000, Aqua from Jul 2002
VIIRS_YEARS = range(2012, API_YEAR + 1)  # S-NPP from Jan 2012
NOAA20_YEARS = range(2023, API_YEAR + 1) # NOAA-20 overlap used to calibrate the live fallback

ARCHIVE_URL = "https://firms.modaps.eosdis.nasa.gov/data/country/{sensor}/{year}/{sensor}_{year}_{country}.csv"

# FIRMS API (needs a MAP_KEY: env FIRMS_MAP_KEY or firms_map_key.txt in the project root, never committed)
MAP_KEY_FILE = ROOT / "firms_map_key.txt"
API_AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{bbox}/{days}/{date}"
API_AVAIL_URL = "https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{key}/ALL"
API_SOURCES = {"modis": "MODIS", "viirs-snpp": "VIIRS_SNPP", "viirs-jpss1": "VIIRS_NOAA20"}
API_MAX_DAYS = 5
API_DIR = RAW_DIR / "api"                # cached API chunks (bbox, gzip)
API_META = RAW_DIR / f"api_{API_YEAR}_meta.json"

# Country boundaries used to clip area-API results (the API has no country endpoint any more)
BOUNDARY_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson"
BOUNDARY_FILE = ROOT / "data" / "boundaries" / "ne_10m_admin_0_countries.geojson"

# Live 7-day files (public, no MAP_KEY needed)
NRT_REGION = "Northern_and_Central_Africa"
NRT_URLS = {
    "SUOMI_VIIRS_C2": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_{region}_7d.csv",
    "J1_VIIRS_C2": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_{region}_7d.csv",
    "J2_VIIRS_C2": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_{region}_7d.csv",
    "MODIS_C6_1": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_{region}_7d.csv",
}

GRID_DEG = 0.25                          # analysis grid cell size
MASK_DEG = 0.01                          # static-source mask resolution (~1 km)

MODIS_MIN_CONF = 30                      # MODIS confidence is 0-100
VIIRS_KEEP_CONF = {"n", "h", "nominal", "high"}

# Harmonization windows
AQUA_FIT_YEARS = (2003, 2011)            # Terra-only -> Terra+Aqua scaling
OVERLAP_FIT_YEARS = (2012, 2020)         # MODIS -> VIIRS mapping (before orbit drift)
NOAA20_FIT_YEARS = (2023, 2025)          # NOAA-20 -> S-NPP mapping (live fallback)
VALIDATION_TRAIN = (2012, 2017)
VALIDATION_TEST = (2018, 2020)
SHRINK_K = 50.0                          # pseudo-count for month-ratio shrinkage

WEEKS = 52
FIRST_YEAR = 2000
