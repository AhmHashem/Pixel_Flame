/* Burning-calendar analytics. Pure functions over a weekly series H (52 weeks/year,
   index w = yearOffset * 52 + weekOfYear). Works in the browser and in Node. */
(function (root) {
  'use strict';
  const W = 52;
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Calendar month (0-11) of each week-of-year, taken at the week's middle day (as in the pipeline)
  const WEEK_MONTH = Array.from({ length: W }, (_, k) => new Date(Date.UTC(2001, 0, 1 + 7 * k + 3)).getUTCMonth());
  // Share of each week's days falling in each month: [[month, fraction], ...]. Week 51 runs to 31 Dec.
  const MONTH_START = MONTH_DAYS.reduce((a, d) => [...a, a[a.length - 1] + d], [0]);
  const MONTH_SPLIT = Array.from({ length: W }, (_, k) => {
    const a = 7 * k, b = k === W - 1 ? 364 : 7 * k + 6, out = [];
    for (let m = 0; m < 12; m++) {
      const lo = Math.max(a, MONTH_START[m]), hi = Math.min(b, MONTH_START[m + 1] - 1);
      if (hi >= lo) out.push([m, (hi - lo + 1) / (b - a + 1)]);
    }
    return out;
  });
  // Weeks that overlap each month
  const MONTH_WEEKS = MONTH_DAYS.map((_, m) => MONTH_SPLIT.map((s, k) => (s.some(([x]) => x === m) ? k : -1)).filter(k => k >= 0));

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }

  // Share of samples below v (ties count half)
  function percentileOf(sorted, v) {
    if (!sorted.length) return NaN;
    let below = 0, equal = 0;
    for (const s of sorted) { if (s < v) below++; else if (s === v) equal++; }
    return (below + equal / 2) / sorted.length;
  }

  /* Per week-of-year distribution from all valid years, pooling +/-1 week for stability. */
  function baseline(H, firstWeek) {
    const n = H.length, samples = [], stats = { p10: [], p25: [], p50: [], p75: [], p90: [], max: [], mean: [] };
    for (let k = 0; k < W; k++) {
      const s = [];
      for (let w = k; w < n; w += W) {
        for (let d = -1; d <= 1; d++) {
          const ww = w + d;
          if (ww >= firstWeek && ww < n) s.push(H[ww]);
        }
      }
      s.sort((a, b) => a - b);
      samples.push(s);
      for (const q of [10, 25, 50, 75, 90]) stats['p' + q].push(quantile(s, q / 100));
      stats.max.push(s.length ? s[s.length - 1] : 0);
      // unpooled mean for the seasonal cycle
      let sum = 0, cnt = 0;
      for (let w = k; w < n; w += W) if (w >= firstWeek) { sum += H[w]; cnt++; }
      stats.mean.push(cnt ? sum / cnt : 0);
    }
    return { samples, ...stats };
  }

  /* Critical period: shortest run of consecutive weeks (wrapping over New Year)
     holding `share` of the typical yearly activity. */
  function criticalPeriod(mean, share = 0.8) {
    const sm = mean.map((_, k) => (mean[(k + W - 1) % W] + mean[k] + mean[(k + 1) % W]) / 3);
    const total = sm.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let peak = 0;
    sm.forEach((v, k) => { if (v > sm[peak]) peak = k; });
    for (let len = 1; len <= W; len++) {
      let best = -1, bestStart = 0;
      for (let s = 0; s < W; s++) {
        let sum = 0;
        for (let i = 0; i < len; i++) sum += sm[(s + i) % W];
        if (sum > best) { best = sum; bestStart = s; }
      }
      if (best >= share * total) return { start: bestStart, length: len, peak, share: best / total };
    }
    return null;
  }

  /* Totals of complete years only (the first and the current year are partial). */
  function annualTotals(H, firstWeek, firstYear) {
    const out = [];
    for (let y = 0; (y + 1) * W <= H.length; y++) {
      if (y * W < firstWeek) continue;          // skip partial first year
      let s = 0;
      for (let k = 0; k < W; k++) s += H[y * W + k];
      out.push({ year: firstYear + y, total: s });
    }
    return out;
  }

  /* Theil-Sen slope, reported as % of mean per decade. */
  function trend(totals) {
    const slopes = [];
    for (let i = 0; i < totals.length; i++)
      for (let j = i + 1; j < totals.length; j++)
        slopes.push((totals[j].total - totals[i].total) / (totals[j].year - totals[i].year));
    slopes.sort((a, b) => a - b);
    const mean = totals.reduce((a, t) => a + t.total, 0) / totals.length;
    const slope = quantile(slopes, 0.5);
    return { slope, mean, pctPerDecade: mean > 0 ? (slope * 10 / mean) * 100 : 0 };
  }

  /* Weeks above the 90th percentile between fromWeek and toWeek, ranked by ratio to typical.
     The ratio uses a floor of 5% of the seasonal peak so off-season blips (typical ~0) do not dominate. */
  function anomalies(H, B, fromWeek, firstYear, top = 10, minCount = 3, toWeek = H.length - 1) {
    const floor = Math.max(1, 0.05 * Math.max(...B.p50)), out = [];
    for (let w = fromWeek; w <= Math.min(toWeek, H.length - 1); w++) {
      const k = w % W, v = H[w];
      if (v < Math.max(minCount, floor) || v <= B.p90[k]) continue;
      out.push({ w, year: firstYear + Math.floor(w / W), k, value: v, typical: B.p50[k],
        ratio: v / Math.max(B.p50[k], floor), pct: percentileOf(B.samples[k], v) });
    }
    out.sort((a, b) => b.ratio - a.ratio);
    return out.slice(0, top);
  }

  function anomalyClass(pct) {
    if (pct < 0.10) return -2;
    if (pct < 0.25) return -1;
    if (pct <= 0.75) return 0;
    if (pct <= 0.90) return 1;
    return 2;
  }

  /* Seasonal-anomaly forecast.
     a[w] = log1p(H[w]) - log1p(median[k]) follows an AR(1): a[t+h] = phi^h a[t] + e_h.
     The spread of e_h is taken empirically from the area's own history (backtest),
     which also yields the skill against climatology alone. */
  function fitForecast(H, B, firstWeek, horizons = 8) {
    const n = H.length, a = new Float64Array(n);
    for (let w = firstWeek; w < n; w++) a[w] = Math.log1p(H[w]) - Math.log1p(B.p50[w % W]);
    let num = 0, den = 0;
    for (let w = firstWeek; w < n - 1; w++) { num += a[w] * a[w + 1]; den += a[w] * a[w]; }
    const phi = den > 0 ? Math.max(0, Math.min(0.99, num / den)) : 0;
    const errs = [], mae = [], maeClim = [];
    for (let h = 1; h <= horizons; h++) {
      const e = [];
      let m = 0, mc = 0, c = 0;
      for (let w = firstWeek; w + h < n; w++) {
        const err = a[w + h] - Math.pow(phi, h) * a[w];
        e.push(err); m += Math.abs(err); mc += Math.abs(a[w + h]); c++;
      }
      e.sort((x, y) => x - y);
      errs.push(e); mae.push(m / c); maeClim.push(mc / c);
    }
    const skill = 1 - mae.reduce((x, y) => x + y, 0) / maeClim.reduce((x, y) => x + y, 0);
    return { phi, errs, mae, maeClim, skill };
  }

  function forecast(model, B, anchorK, anchorValue, horizons = 8) {
    const a0 = Math.log1p(anchorValue) - Math.log1p(B.p50[anchorK]);
    const out = [];
    for (let h = 1; h <= horizons; h++) {
      const k = (anchorK + h) % W, e = model.errs[h - 1], mu = Math.pow(model.phi, h) * a0;
      const base = Math.log1p(B.p50[k]);
      const at = q => Math.max(0, Math.expm1(base + mu + quantile(e, q)));
      const tau = Math.log1p(B.p75[k]) - base;
      const pAbove = e.filter(x => mu + x > tau).length / e.length;
      out.push({ h, k, p10: at(0.1), p50: at(0.5), p90: at(0.9), typical: B.p50[k], pAbove });
    }
    return { a0, weeks: out };
  }

  function warningLevel(value, B, k) {
    const pct = percentileOf(B.samples[k], value);
    let level = 'normal';
    if (value > B.max[k] && value >= 3) level = 'extreme';
    else if (pct > 0.9 && value >= 3) level = 'high';
    else if (pct > 0.75 && value >= 3) level = 'elevated';
    return { pct, level };
  }

  /* Calendar-month totals, indexed yearOffset * 12 + month. Each week is split over the months
     its days fall in, so monthly totals add up exactly to the yearly total. Months touched by a
     week outside the record (before it starts, or not yet observed) are NaN. */
  function monthly(H, firstWeek) {
    const nYears = Math.ceil(H.length / W), M = new Float64Array(nYears * 12);
    const ok = new Uint8Array(nYears * 12).fill(1);
    for (let y = 0; y < nYears; y++) {
      for (let k = 0; k < W; k++) {
        const w = y * W + k;
        for (const [m, f] of MONTH_SPLIT[k]) {
          if (w < firstWeek || w >= H.length) ok[y * 12 + m] = 0; else M[y * 12 + m] += H[w] * f;
        }
      }
    }
    for (let i = 0; i < M.length; i++) if (!ok[i]) M[i] = NaN;
    return M;
  }

  /* Per calendar month distribution across years. */
  function monthlyBaseline(M) {
    const samples = [], p50 = [], mean = [];
    for (let m = 0; m < 12; m++) {
      const s = [];
      for (let i = m; i < M.length; i += 12) if (!isNaN(M[i])) s.push(M[i]);
      s.sort((a, b) => a - b);
      samples.push(s);
      p50.push(quantile(s, 0.5));
      mean.push(s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0);
    }
    return { samples, p50, mean };
  }

  /* Number of separate fires among hotspots `idx`: detections in touching ~1 km cells are
     merged (union-find on a cellDeg grid with 8-neighbour links). */
  function fireClusters(lat, lon, idx, cellDeg = 0.01) {
    const parent = new Map(), cells = new Map();
    const find = a => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    for (const i of idx) {
      const key = Math.floor(lat[i] / cellDeg) + ':' + Math.floor(lon[i] / cellDeg);
      if (!cells.has(key)) { cells.set(key, [Math.floor(lat[i] / cellDeg), Math.floor(lon[i] / cellDeg)]); parent.set(key, key); }
    }
    for (const [key, [r, c]] of cells) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nb = (r + dr) + ':' + (c + dc);
        if ((dr || dc) && cells.has(nb)) { const a = find(key), b = find(nb); if (a !== b) parent.set(a, b); }
      }
    }
    let n = 0;
    for (const key of cells.keys()) if (find(key) === key) n++;
    return n;
  }

  function pointInPolygon(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  const api = { W, WEEK_MONTH, MONTH_DAYS, MONTH_SPLIT, MONTH_WEEKS, quantile, percentileOf, baseline, criticalPeriod,
    annualTotals, trend, anomalies, anomalyClass, fitForecast, forecast, warningLevel, monthly,
    monthlyBaseline, fireClusters, pointInPolygon };
  if (typeof module !== 'undefined') module.exports = api; else root.FireAnalysis = api;
})(this);
