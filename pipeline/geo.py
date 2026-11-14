"""Country boundaries for clipping FIRMS area-API results (Natural Earth 1:10m admin-0)."""
import json
from functools import lru_cache

import numpy as np
from matplotlib.path import Path as MplPath

from config import BOUNDARY_FILE, COUNTRY_ISO3


@lru_cache(maxsize=None)
def _paths(key: str) -> tuple:
    """Outer rings of the country's (multi)polygon as matplotlib paths, plus the bbox."""
    iso = COUNTRY_ISO3[key]
    gj = json.loads(BOUNDARY_FILE.read_text(encoding="utf-8"))
    feat = next(f for f in gj["features"] if f["properties"].get("ADM0_A3") == iso)
    geom = feat["geometry"]
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    rings = [np.asarray(p[0], dtype=float) for p in polys]       # [lon, lat] exterior rings
    allpts = np.vstack(rings)
    bbox = (allpts[:, 0].min(), allpts[:, 1].min(), allpts[:, 0].max(), allpts[:, 1].max())
    return tuple(MplPath(r) for r in rings), bbox


def bbox(key: str, pad: float = 0.1) -> tuple:
    """(west, south, east, north) of the country, padded."""
    w, s, e, n = _paths(key)[1]
    return round(w - pad, 3), round(s - pad, 3), round(e + pad, 3), round(n + pad, 3)


def inside(key: str, lat, lon) -> np.ndarray:
    pts = np.column_stack([np.asarray(lon, float), np.asarray(lat, float)])
    out = np.zeros(len(pts), bool)
    for p in _paths(key)[0]:
        out |= p.contains_points(pts)
    return out
