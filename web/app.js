/* Burning Calendar web app: map, area of interest, period, calendar, baselines, outlook, exports. */
'use strict';
const FA = window.FireAnalysis;
const W = FA.W;
const DAY = 864e5;
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_WEEKS = FA.MONTH_WEEKS;
const SENSORS = { snpp: 'VIIRS S-NPP', noaa20: 'VIIRS NOAA-20', noaa21: 'VIIRS NOAA-21', modis: 'MODIS Aqua/Terra' };
const ARCHIVE_SATS = ['Terra', 'Aqua', 'S-NPP', 'NOAA-20'];
const AGE_BINS = [[0, 24, '< 24 h'], [24, 48, '24–48 h'], [48, 96, '2–4 days'], [96, Infinity, '4–7 days']];
const ANOM_LABELS = { '-2': 'Far below normal (<10%)', '-1': 'Below normal', '0': 'Normal (25–75%)', '1': 'Above normal', '2': 'Far above normal (>90%)' };

const S = {
  idx: null, nrt: null, ds: null, cells: [], sel: [], selKeys: new Set(), aoi: null, aoiLabel: '',
  H: null, F: null, B: null, M: null, MB: null, year: null, range: null, fillWeeks: new Set(),
  calMode: 'count', calGrain: 'week', sensors: new Set(Object.keys(SENSORS)), drawing: false, busy: false,
};
const charts = {};
const hsCache = new Map();

// ---------- helpers ----------
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const cssList = n => cssVar(n).split(',').map(s => s.trim());
const fmt = v => v == null || isNaN(v) ? '–' : v === 0 ? '0' : v >= 100 ? Math.round(v).toLocaleString('en') : v >= 10 ? v.toFixed(0) : v.toFixed(1);
const pctTxt = p => `${Math.round(p * 100)}th percentile`;
const signPct = v => { const r = Math.round(v); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + '%'; };
const weekStart = (y, k) => new Date(Date.UTC(y, 0, 1 + 7 * k));
const fmtDate = (d, year = true) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const weekLabel = k => fmtDate(weekStart(2001, k), false);
const monthTicks = Array.from({ length: W }, (_, k) => {
  const d = weekStart(2001, k), prev = weekStart(2001, k - 1);
  return k === 0 || d.getUTCMonth() !== prev.getUTCMonth() ? MONTHS[d.getUTCMonth()] : '';
});
const yearOf = w => S.ds.firstYear + Math.floor(w / W);
const lastYear = () => S.ds.firstYear + Math.floor((S.ds.nWeeks - 1) / W);
const nYearsRec = () => Math.ceil(S.ds.nWeeks / W);
const estimated = w => w < S.ds.viirsStart;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const parseDay = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
};
const weekStartMs = w => Date.UTC(yearOf(w), 0, 1 + 7 * (w % W));
const weekEndMs = w => (w % W === W - 1 ? Date.UTC(yearOf(w), 11, 31) : weekStartMs(w) + 6 * DAY);
function dayToWeek(ms) {
  const y = new Date(ms).getUTCFullYear(), doy = Math.floor((ms - Date.UTC(y, 0, 1)) / DAY);
  return (y - S.ds.firstYear) * W + Math.min(Math.floor(doy / 7), W - 1);
}
const MODIS_START = Date.UTC(2000, 10, 1);                    // first FIRMS MODIS day
const recordStart = () => Math.max(weekStartMs(S.ds.firstWeek), MODIS_START);
const recordEnd = () => weekEndMs(S.ds.nWeeks - 1);          // end of the last complete week
const partialYear = y => y === lastYear() && S.ds.nWeeks % W !== 0;
const yearName = y => `${y}${y < 2012 ? ' *' : ''}${partialYear(y) ? ` (to ${fmtDate(new Date(recordEnd()), false)})` : ''}`;
/* First week that comes from near-real-time processing (current year, after standard processing ends). */
function nrtStartWeek() {
  const api = S.idx && S.idx.api, sp = api && api.spEnd && api.spEnd.VIIRS_SNPP;
  return sp ? dayToWeek(parseDay(sp) + DAY) : Infinity;
}
const status = t => { $('#dl-status').textContent = t; };

const ICONS = {
  normal: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="var(--good)"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="#fff" stroke-width="2" fill="none"/></svg>',
  elevated: '<svg viewBox="0 0 20 20"><path d="M10 2l8.5 15h-17z" fill="var(--warning)"/><path d="M10 8v4.5M10 14.5v.5" stroke="#0b0b0b" stroke-width="2"/></svg>',
  high: '<svg viewBox="0 0 20 20"><path d="M10 2l8.5 15h-17z" fill="var(--serious)"/><path d="M10 8v4.5M10 14.5v.5" stroke="#0b0b0b" stroke-width="2"/></svg>',
  extreme: '<svg viewBox="0 0 20 20"><path d="M6 1.5h8l4.5 4.5v8L14 18.5H6L1.5 14V6z" fill="var(--critical)"/><path d="M10 5.5v5.5M10 13.5v.5" stroke="#fff" stroke-width="2"/></svg>',
  unknown: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="var(--muted)"/><path d="M7.5 7.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4M10 14.2v.6" stroke="#fff" stroke-width="2" fill="none"/></svg>',
};
const LEVEL_TEXT = { normal: 'Normal', elevated: 'Elevated', high: 'High', extreme: 'Extreme' };

function baseChart() {
  const text2 = cssVar('--text-2'), grid = cssVar('--grid'), axis = cssVar('--axis');
  return {
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: text2 },
    axisCommon: {
      axisLine: { lineStyle: { color: axis } }, axisTick: { show: false },
      axisLabel: { color: cssVar('--muted') }, splitLine: { lineStyle: { color: grid } },
    },
    tooltip: {
      backgroundColor: cssVar('--surface'), borderColor: cssVar('--border'),
      textStyle: { color: cssVar('--text'), fontSize: 12 }, extraCssText: 'box-shadow:0 2px 8px rgba(0,0,0,.15);',
    },
    legend: { textStyle: { color: text2 }, icon: 'roundRect', itemWidth: 12, itemHeight: 8, top: 0, left: 0, right: 32 },
  };
}

/* PNG export button for a chart (top right). */
function toolbox(name) {
  return {
    right: 0, top: 0, itemSize: 14,
    iconStyle: { borderColor: cssVar('--muted') }, emphasis: { iconStyle: { borderColor: cssVar('--text') } },
    feature: { saveAsImage: { title: 'Save PNG', name: fileBase(name), pixelRatio: 2, backgroundColor: cssVar('--surface') } },
  };
}

function chart(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), null, { renderer: 'canvas' });
  return charts[id];
}

function fileBase(what) {
  const ds = S.ds, r = S.range;
  const area = S.aoi ? '_area' : '';
  const period = r ? `_${isoDay(r.d0)}_${isoDay(r.d1)}` : '';
  return `burning_calendar_${ds.name}${area}_${what}${period}`.replace(/[^\w.-]+/g, '_');
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- map ----------
let map, tiles, labels, cellLayer, hotLayer, drawn;

function initMap() {
  map = L.map('map', { preferCanvas: true, minZoom: 3 }).setView([15, 20], 4);
  const labelPane = map.createPane('labels');      // place names above the grid cells, below hotspots
  labelPane.style.zIndex = 420;
  labelPane.style.pointerEvents = 'none';
  setTiles();
  map.createPane('hot').style.zIndex = 450;
  cellLayer = L.layerGroup().addTo(map);
  hotLayer = new HotLayer().addTo(map);
  drawn = new L.FeatureGroup().addTo(map);
  map.addControl(new L.Control.Draw({
    draw: { polyline: false, circle: false, marker: false, circlemarker: false,
      polygon: { allowIntersection: false, showArea: false }, rectangle: { showArea: false } },
  }));
  map.on(L.Draw.Event.DRAWSTART, () => { S.drawing = true; });
  map.on(L.Draw.Event.DRAWSTOP, () => { setTimeout(() => { S.drawing = false; }, 50); });
  map.on(L.Draw.Event.CREATED, e => {
    drawn.clearLayers();
    drawn.addLayer(e.layer);
    setAoi(e.layer.getLatLngs()[0].map(p => [p.lat, p.lng]), 'Drawn area');
  });
  map.on('click', e => {
    if (S.drawing || hotLayer.pick(e)) return;
    $('#pt-lat').value = e.latlng.lat.toFixed(4);
    $('#pt-lon').value = e.latlng.lng.toFixed(4);
  });
}

/* Esri light/dark grey canvas: quiet basemaps that let the fire layers stand out, with place labels on
   their own layer above the grid cells. They need no API key and no Referer, so they also work on hosted
   dev domains such as GitHub Codespaces, where tile.openstreetmap.org blocks requests (and CARTO now
   requires a key). */
const ESRI_CANVAS = name => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${name}/MapServer/tile/{z}/{y}/{x}`;
function setTiles() {
  if (tiles) tiles.remove();
  if (labels) labels.remove();
  const tone = matchMedia('(prefers-color-scheme: dark)').matches ? 'Dark' : 'Light';
  const opts = { maxZoom: 16, referrerPolicy: 'strict-origin-when-cross-origin' };
  tiles = L.tileLayer(ESRI_CANVAS(`World_${tone}_Gray_Base`), {
    ...opts, attribution: 'Basemap © Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS user community',
  }).addTo(map);
  labels = L.tileLayer(ESRI_CANVAS(`World_${tone}_Gray_Reference`), { ...opts, pane: 'labels' }).addTo(map);
}

/* Fast canvas layer for ~200k live hotspots, coloured by time since detection. */
const HotLayer = L.Layer.extend({
  onAdd(m) {
    this._c = L.DomUtil.create('canvas', 'leaflet-zoom-hide');
    m.getPane('hot').appendChild(this._c);
    m.on('moveend resize', this.redraw, this);
    m.on('zoomstart', this._hide, this);
    this.redraw();
  },
  onRemove(m) {
    this._c.remove();
    m.off('moveend resize', this.redraw, this);
    m.off('zoomstart', this._hide, this);
  },
  _hide() { this._c.style.visibility = 'hidden'; },
  redraw() {
    const m = this._map, c = this._c, size = m.getSize(), dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
    c.width = size.x * dpr; c.height = size.y * dpr;
    c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
    c.style.visibility = 'visible';
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    this._pts = [];
    const n = S.nrt;
    if (!n) return;
    const b = m.getBounds().pad(0.05), z = m.getZoom(), r = z >= 9 ? 4 : z >= 7 ? 3 : z >= 5 ? 2 : 1.5;
    const colors = cssList('--age');
    // oldest first so the newest detections sit on top
    for (let bin = AGE_BINS.length - 1; bin >= 0; bin--) {
      ctx.fillStyle = colors[bin];
      ctx.beginPath();
      for (let i = 0; i < n.lat.length; i++) {
        if (n.bin[i] !== bin || !S.sensors.has(n.s[i])) continue;
        const lat = n.lat[i], lon = n.lon[i];
        if (lat < b.getSouth() || lat > b.getNorth() || lon < b.getWest() || lon > b.getEast()) continue;
        const p = m.latLngToContainerPoint([lat, lon]);
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
        this._pts.push([p.x, p.y, i]);
      }
      ctx.fill();
    }
  },
  /* Opens a popup for the nearest hotspot; returns false when nothing is close. */
  pick(e) {
    let best = null, bd = 12 * 12;
    for (const [x, y, i] of this._pts || []) {
      const d = (x - e.containerPoint.x) ** 2 + (y - e.containerPoint.y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best == null) return false;
    const n = S.nrt, lat = n.lat[best], lon = n.lon[best];
    const t = new Date(n.t[best] * 60000), ageH = (n.tMax - n.t[best]) / 60;
    L.popup().setLatLng([lat, lon]).setContent(`
      <strong>${SENSORS[n.s[best]]}</strong> · ${n.dn[best] === 'D' ? 'day' : 'night'} pass<br>
      Detected ${t.toISOString().slice(0, 16).replace('T', ' ')} UTC (${ageH < 48 ? Math.round(ageH) + ' h' : (ageH / 24).toFixed(1) + ' days'} before latest data)<br>
      Fire radiative power: ${n.frp[best]} MW<br>
      ${lat.toFixed(4)}, ${lon.toFixed(4)}<br>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" rel="noopener">Directions to this hotspot</a>
      <div class="note">A hotspot is the centre of a ${n.s[best] === 'modis' ? '1 km' : '375 m'} satellite pixel, not an exact fire location. Check official sources before travelling.</div>`)
      .openOn(this._map);
    return true;
  },
});

function drawCells() {
  cellLayer.clearLayers();
  if (!$('#show-cells').checked) { $('#cell-legend').innerHTML = ''; return; }
  const g = S.ds.grid, ramp = cssList('--heat');
  const vals = S.cells.map(c => c.mean).filter(v => v > 0).sort((a, b) => a - b);
  const cuts = [0.3, 0.5, 0.7, 0.85, 0.95, 0.99].map(q => FA.quantile(vals, q));
  const colorOf = v => { const i = cuts.findIndex(c => v <= c); return ramp[i === -1 ? ramp.length - 1 : i]; };
  for (const c of S.cells) {
    if (c.mean <= 0) continue;
    L.rectangle([[c.ci * g, c.cj * g], [(c.ci + 1) * g, (c.cj + 1) * g]], {
      stroke: false, fillColor: colorOf(c.mean), fillOpacity: 0.55, interactive: false,
    }).addTo(cellLayer);
  }
  $('#cell-legend').innerHTML = 'Historical detections / year per 0.25° cell: ' +
    ramp.map((col, i) => `<span><span class="swatch sq" style="background:${col}"></span>${i === 0 ? '≤ ' + fmt(cuts[0]) : i === ramp.length - 1 ? '> ' + fmt(cuts[i - 1]) : fmt(cuts[i - 1]) + '–' + fmt(cuts[i])}</span>`).join('');
}

function drawAgeLegend() {
  const colors = cssList('--age');
  $('#age-legend').innerHTML = `Time since detection (data ${S.idx.nrt.start} → ${S.idx.nrt.end}, ${S.idx.nrt.region}): ` +
    AGE_BINS.map((b, i) => `<span><span class="swatch" style="background:${colors[i]}"></span>${b[2]}</span>`).join('') +
    ' · click a hotspot for details and directions';
}

function circlePolygon(lat, lon, km, n = 72) {
  const dLat = km / 111.32, dLon = km / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [lat + dLat * Math.sin(a), lon + dLon * Math.cos(a)];
  });
}

async function gotoPoint(e) {
  e.preventDefault();
  const fields = [['#pt-lat', -90, 90], ['#pt-lon', -180, 180], ['#pt-rad', 1, 1000]];
  let bad = false;
  const [lat, lon, km] = fields.map(([id, lo, hi]) => {
    const el = $(id), x = parseFloat(el.value), ok = isFinite(x) && x >= lo && x <= hi;
    el.classList.toggle('invalid', !ok);
    bad = bad || !ok;
    return x;
  });
  if (bad) {
    $('#aoi-text').textContent = 'Enter a latitude (−90 to 90), a longitude (−180 to 180) and a radius of 1–1000 km.';
    return;
  }
  const near = c => lat >= c.bbox[0] - 0.5 && lat <= c.bbox[2] + 0.5 && lon >= c.bbox[1] - 0.5 && lon <= c.bbox[3] + 0.5;
  const current = S.idx.countries.find(c => c.name === S.ds.name);
  if (!near(current)) {
    const other = S.idx.countries.find(near);
    if (!other) {
      map.setView([lat, lon], 7);
      $('#aoi-text').textContent = `That point is outside the countries in this demo (${S.idx.countries.map(c => c.name).join(', ')}).`;
      return;
    }
    $('#country').value = other.file;
    await loadCountry(other.file);
  }
  const poly = circlePolygon(lat, lon, km);
  drawn.clearLayers();
  L.polygon(poly, { color: cssVar('--series-1'), weight: 2, fillOpacity: 0.08, interactive: false }).addTo(drawn);
  L.circleMarker([lat, lon], { radius: 4, color: cssVar('--series-1'), fillOpacity: 1, interactive: false }).addTo(drawn);
  map.fitBounds(L.latLngBounds(poly).pad(0.25));
  setAoi(poly, `${+km.toFixed(1)} km around ${lat.toFixed(3)}, ${lon.toFixed(3)}`);
}

// ---------- data ----------
async function getJSON(f) {
  const r = await fetch('data/' + f);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  return r.json();
}

function prepNrt(n) {
  n.tMax = n.t.reduce((a, b) => Math.max(a, b), -Infinity);
  n.tMin = n.t.reduce((a, b) => Math.min(a, b), Infinity);
  n.bin = Uint8Array.from(n.t, t => { const a = (n.tMax - t) / 60; return AGE_BINS.findIndex(b => a >= b[0] && a < b[1]); });
  n.cellKey = n.lat.map((lat, i) => Math.floor(lat / 0.25) + ',' + Math.floor(n.lon[i] / 0.25));
  const mid = new Date((n.tMin + n.tMax) / 2 * 60000);
  const doy = Math.floor((mid - Date.UTC(mid.getUTCFullYear(), 0, 1)) / DAY);
  n.k = Math.min(Math.floor(doy / 7), W - 1);
  n.days = (n.tMax - n.tMin) / 1440;
  // per-sensor coverage, to notice a satellite that has stopped delivering data
  n.per = {};
  for (let i = 0; i < n.s.length; i++) {
    const p = n.per[n.s[i]] || (n.per[n.s[i]] = { count: 0, tMin: Infinity, tMax: -Infinity });
    p.count++;
    if (n.t[i] < p.tMin) p.tMin = n.t[i];
    if (n.t[i] > p.tMax) p.tMax = n.t[i];
  }
  for (const p of Object.values(n.per)) p.days = (p.tMax - p.tMin) / 1440;
  return n;
}

/* The harmonized scale is VIIRS S-NPP. If S-NPP is missing from the live files, fall back to
   NOAA-20 (same instrument), converted with this country's NOAA-20 -> S-NPP calibration. */
function liveSource() {
  const n = S.nrt, cal = S.ds.noaa20, month = FA.WEEK_MONTH[n.k];
  const ok = c => n.per[c] && n.per[c].count > 0 && n.per[c].days >= 0.75 * n.days;
  if (ok('snpp')) return { code: 'snpp', factor: 1, days: n.per.snpp.days, label: SENSORS.snpp, converted: false };
  for (const code of ['noaa20', 'noaa21']) {
    if (ok(code)) {
      return { code, factor: cal ? cal.ratio[month] : 1, days: n.per[code].days, label: SENSORS[code],
        converted: true, month, approx: code === 'noaa21' || !cal };
    }
  }
  return null;
}

async function loadCountry(file) {
  document.body.style.cursor = 'progress';
  const ds = await getJSON(file);
  S.ds = ds;
  hsCache.clear();
  const nYears = (ds.nWeeks - ds.firstWeek) / W;
  S.cells = ds.cells.map(([ci, cj, dw, n, frp]) => {
    let w = 0;
    const weeks = dw.map(d => (w += d));
    return { ci, cj, key: ci + ',' + cj, lat: (ci + 0.5) * ds.grid, lon: (cj + 0.5) * ds.grid,
      weeks, n, frp, mean: n.reduce((a, b) => a + b, 0) / nYears };
  });
  S.fillWeeks = new Set();
  for (const [a, b] of (ds.outages && ds.outages.snpp_runs) || []) {
    for (let t = parseDay(a); t <= parseDay(b); t += DAY) S.fillWeeks.add(dayToWeek(t));
  }
  drawn.clearLayers();
  map.fitBounds([[ds.bbox[0], ds.bbox[1]], [ds.bbox[2], ds.bbox[3]]]);
  drawCells();
  $('#year-select').innerHTML = '';
  for (let y = lastYear(); y >= ds.firstYear + 1; y--) $('#year-select').add(new Option(yearName(y), y));
  S.year = lastYear();
  const lo = recordStart(), hi = recordEnd();
  $('#date-from').min = $('#date-to').min = isoDay(lo);
  $('#date-from').max = $('#date-to').max = isoDay(hi);
  $('#subtitle').textContent = `Harmonized MODIS + VIIRS active-fire record, ${fmtDate(new Date(lo))} – ${fmtDate(new Date(hi))}, ` +
    `with live hotspots (${S.idx.nrt.start} → ${S.idx.nrt.end})`;
  setRange(S.range ? S.range.d0 : lo, S.range ? S.range.d1 : hi, false);
  setAoi(null);
  renderMethod();
  document.body.style.cursor = '';
}

function setAoi(poly, label = 'Custom area') {
  S.aoi = poly;
  S.aoiLabel = poly ? label : '';
  const g = S.ds.grid;
  let sel = poly ? S.cells.filter(c => FA.pointInPolygon(c.lat, c.lon, poly)) : S.cells, note = '';
  if (poly && !sel.length) {
    // smaller than a grid cell: use the cell around the area's centre
    const [clat, clon] = poly.reduce(([a, b], [y, x]) => [a + y / poly.length, b + x / poly.length], [0, 0]);
    const key = Math.floor(clat / g) + ',' + Math.floor(clon / g);
    sel = S.cells.filter(c => c.key === key);
    if (sel.length) note = ' The area is smaller than one 0.25° grid cell, so the statistics use the cell around its centre; the hotspot CSV uses the exact area.';
  }
  S.sel = sel;
  S.selKeys = new Set(sel.map(c => c.key));
  $('#reset-aoi').hidden = !poly;
  $('#aoi-text').textContent = poly
    ? `${label}: ${sel.length} grid cell${sel.length === 1 ? '' : 's'} with fire history in ${S.ds.name}.${note}`
    : `Area: all of ${S.ds.name} (${S.cells.length} grid cells). Enter a point above or draw a shape on the map to focus on a smaller area.`;
  analyze();
}

/* Clamp, order and store the period; weeks are the 52-per-year grid used by the analysis. */
function setRange(d0, d1, render = true) {
  if (isNaN(d0) || isNaN(d1)) return;
  const lo = recordStart(), hi = recordEnd();
  if (d0 > d1) [d0, d1] = [d1, d0];
  d0 = Math.min(Math.max(d0, lo), hi);
  d1 = Math.min(Math.max(d1, lo), hi);
  S.range = { d0, d1, w0: dayToWeek(d0), w1: dayToWeek(d1) };
  $('#date-from').value = isoDay(d0);
  $('#date-to').value = isoDay(d1);
  const presets = presetRanges();
  $$('#range-presets button').forEach(b => {
    const p = presets[b.dataset.preset];
    b.classList.toggle('active', p[0] === d0 && p[1] === d1);
  });
  if (render && S.B) renderPeriod();
}

/* Rolling windows that end with the latest complete week. */
function presetRanges() {
  const lo = recordStart(), hi = recordEnd(), d = new Date(hi);
  const back = years => Date.UTC(d.getUTCFullYear() - years, d.getUTCMonth(), d.getUTCDate() + 1);
  return { all: [lo, hi], viirs: [Date.UTC(2012, 0, 1), hi], last5: [back(5), hi], last1: [back(1), hi] };
}

// ---------- analysis ----------
function analyze() {
  const ds = S.ds, H = new Float64Array(ds.nWeeks), F = new Float64Array(ds.nWeeks);
  for (const c of S.sel) c.weeks.forEach((w, i) => { H[w] += c.n[i]; F[w] += c.frp[i]; });
  S.H = H; S.F = F;
  const empty = !S.sel.length || H.every(v => v === 0);
  if (empty) {
    S.B = null;
    for (const id of ['warning-card', 'season-card', 'trend-card']) $('#' + id).innerHTML = '<div class="empty">No fire history in this area.</div>';
    for (const id of ['calendar', 'baseline', 'forecast', 'annual']) chart(id).clear();
    $('#anomalies').innerHTML = '';
    $('#period-tiles').innerHTML = '<div class="empty">No fire history in this area.</div>';
    return;
  }
  S.B = FA.baseline(H, ds.firstWeek);
  S.M = FA.monthly(H, ds.firstWeek);
  S.MB = FA.monthlyBaseline(S.M);
  S.season = FA.criticalPeriod(S.B.mean);
  S.totals = FA.annualTotals(H, ds.firstWeek, ds.firstYear);
  S.model = FA.fitForecast(H, S.B, ds.firstWeek);
  // Current conditions from the live feed, on the same S-NPP scale as the harmonized record
  const n = S.nrt, src = liveSource(), inArea = [], last24 = [];
  let count = 0;
  for (let i = 0; i < n.lat.length; i++) {
    if (!S.selKeys.has(n.cellKey[i])) continue;
    inArea.push(i);
    if (n.tMax - n.t[i] <= 1440) last24.push(i);
    if (src && n.s[i] === src.code) count++;
  }
  const value = src ? count * src.factor * 7 / Math.max(src.days, 1) : null;
  S.now = { k: n.k, raw: count, all: inArea.length, src, value, warn: value == null ? null : FA.warningLevel(value, S.B, n.k),
    hot24: last24.length, fires24: FA.fireClusters(n.lat, n.lon, last24), fires7: FA.fireClusters(n.lat, n.lon, inArea) };
  S.fc = FA.forecast(S.model, S.B, n.k, value == null ? S.B.p50[n.k] : value);
  renderAll();
}

function renderAll() {
  renderWarning(); renderSeason(); renderTrend();
  renderPeriod(); renderBaseline(); renderForecast();
}

function renderPeriod() {
  renderPeriodTiles(); renderCalendar(); renderAnomalies(); renderAnnual();
}

/* Complete calendar months that lie entirely inside the period. */
function monthsInRange() {
  const out = [], { w0, w1 } = S.range;
  for (let yi = 0; yi < nYearsRec(); yi++) {
    for (let m = 0; m < 12; m++) {
      const ks = MONTH_WEEKS[m], a = yi * W + ks[0], b = yi * W + ks[ks.length - 1], v = S.M[yi * 12 + m];
      if (a >= w0 && b <= w1 && !isNaN(v)) out.push({ yi, y: S.ds.firstYear + yi, m, v, est: b < S.ds.viirsStart });
    }
  }
  return out;
}

/* Per-year totals of the weeks inside the period. */
function yearsInRange() {
  const out = [], { w0, w1 } = S.range;
  for (let yi = 0; yi < nYearsRec(); yi++) {
    const a = Math.max(w0, yi * W, S.ds.firstWeek), b = Math.min(w1, yi * W + W - 1);
    if (a > b) continue;
    let total = 0;
    for (let w = a; w <= b; w++) total += S.H[w];
    out.push({ year: S.ds.firstYear + yi, total, partial: a > yi * W || b < yi * W + W - 1 });
  }
  return out;
}

// ---------- cards ----------
function firesNow(now) {
  const n = v => v.toLocaleString('en');
  return `<div class="fires-now"><strong>${n(now.fires24)}</strong> separate fire${now.fires24 === 1 ? '' : 's'} in the last 24 h
    (${n(now.hot24)} hotspots) · <strong>${n(now.fires7)}</strong> over 7 days (${n(now.all)} hotspots)</div>`;
}

function renderWarning() {
  const { now, B, fc } = S;
  if (!now.src) {
    $('#warning-card').innerHTML = `
      <div class="stat-label">Early warning · last 7 days</div>
      <div class="status">${ICONS.unknown}<span>No live data</span></div>
      <div class="stat-note">The current FIRMS files hold no VIIRS detections, so this week cannot be compared with history.</div>
      ${firesNow(now)}`;
    return;
  }
  const lvl = now.warn.level, src = now.src, cal = S.ds.noaa20;
  const next4 = fc.weeks.slice(0, 4), pMax = Math.max(...next4.map(w => w.pAbove));
  const conv = !src.converted ? '' : `<div class="note warn-text">VIIRS S-NPP has no usable data in the current 7-day files, so ${src.label} is used,
    converted to the S-NPP scale (×${src.factor.toFixed(2)} for ${MONTHS[src.month]}${cal ? `, fitted on ${cal.years[0]}–${cal.years[1]}, weekly r = ${cal.r_weekly.toFixed(2)}` : ''})${src.code === 'noaa21' ? ' using the NOAA-20 ratio, as both carry the same instrument' : ''}.</div>`;
  $('#warning-card').innerHTML = `
    <div class="stat-label">Early warning · last 7 days</div>
    <div class="status">${ICONS[lvl]}<span>${LEVEL_TEXT[lvl]}</span></div>
    <div class="stat-note">${fmt(now.value)} detections (S-NPP scale) vs. typical ${fmt(B.p50[now.k])} for the week of ${weekLabel(now.k)}
      (${pctTxt(now.warn.pct)}).</div>
    ${firesNow(now)}
    <div class="note">Chance of above-normal activity in the next 4 weeks: up to ${Math.round(pMax * 100)}%.</div>${conv}`;
}

function renderSeason() {
  const s = S.season;
  if (!s) { $('#season-card').innerHTML = '<div class="empty">No clear fire season.</div>'; return; }
  const end = (s.start + s.length - 1) % W;
  $('#season-card').innerHTML = `
    <div class="stat-label">Critical period</div>
    <div class="stat-value">${weekLabel(s.start)} – ${fmtDate(new Date(weekEndMs(end)), false)}</div>
    <div class="stat-note">${s.length} weeks hold ${Math.round(s.share * 100)}% of typical yearly burning. Peak around ${weekLabel(s.peak)}.</div>`;
}

function renderTrend() {
  const all = FA.trend(S.totals), obs = FA.trend(S.totals.filter(t => t.year >= 2012));
  const last = S.totals[S.totals.length - 1];
  $('#trend-card').innerHTML = `
    <div class="stat-label">Long-term trend</div>
    <div class="stat-value">${signPct(all.pctPerDecade)} per decade</div>
    <div class="stat-note">${S.totals[0].year}–${last.year}, Theil–Sen. VIIRS years alone (2012–${last.year}): ${signPct(obs.pctPerDecade)} per decade.
      ${last.year}: ${fmt(last.total)} detections.</div>`;
}

function renderPeriodTiles() {
  const { H, B } = S, { w0, w1 } = S.range;
  let total = 0, normal = 0, above = 0, weeks = 0;
  for (let w = Math.max(w0, S.ds.firstWeek); w <= w1; w++) {
    const k = w % W;
    total += H[w]; normal += B.mean[k]; weeks++;
    if (H[w] > B.p90[k] && H[w] >= 3) above++;
  }
  const months = monthsInRange(), years = yearsInRange(), full = years.filter(y => !y.partial);
  const maxBy = (list, f) => list.reduce((a, b) => (a == null || f(b) > f(a) ? b : a), null);
  const bm = maxBy(months, m => m.v), by = maxBy(full.length ? full : years, y => y.total);
  const tr = full.length >= 5 ? FA.trend(full) : null;
  const diff = normal > 0 ? (total / normal - 1) * 100 : 0;
  const tile = (label, value, note) => `<div class="tile"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`;
  $('#period-tiles').innerHTML =
    tile('Hotspots detected', fmt(total), `${weeks} weeks · ${fmt(total / Math.max(weeks / W, 1 / W))} per year (S-NPP scale)`) +
    tile('Vs. average year', signPct(diff), `the same weeks in an average year: ${fmt(normal)}`) +
    tile('Busiest month', bm ? `${MONTHS[bm.m]} ${bm.y}` : '–', bm ? `${fmt(bm.v)} detections${bm.est ? ' (est. from MODIS)' : ''}` : 'no complete month in period') +
    tile('Busiest year', by ? String(by.year) : '–', by ? `${fmt(by.total)} detections${by.partial ? ' (partial year)' : ''}` : '') +
    tile('Unusual weeks', String(above), `above the 90th percentile for their time of year`) +
    tile('Trend in period', tr ? `${signPct(tr.pctPerDecade)}/decade` : '–', tr ? `${full[0].year}–${full[full.length - 1].year}, Theil–Sen` : 'needs at least 5 full years');
}

// ---------- charts ----------
function countPieces(values) {
  const ramp = cssList('--heat'), nonzero = values.filter(v => v > 0).sort((a, b) => a - b);
  const raw = [0.15, 0.3, 0.5, 0.7, 0.85, 0.95].map(q => FA.quantile(nonzero, q));
  const cuts = [...new Set(raw.map(v => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10)))].filter(v => v > 0);
  const pieces = [{ value: 0, label: '0', color: cssVar('--zero') }];
  let lo = 0;
  cuts.forEach((c, i) => { pieces.push({ gt: lo, lte: c, label: `${fmt(lo)}–${fmt(c)}`, color: ramp[i] }); lo = c; });
  pieces.push({ gt: lo, label: `> ${fmt(lo)}`, color: ramp[Math.min(cuts.length, ramp.length - 1)] });
  return pieces;
}

function renderCalendar() {
  const ds = S.ds, H = S.H, B = S.B, base = baseChart(), { w0, w1 } = S.range;
  const monthly = S.calGrain === 'month', y0 = yearOf(Math.max(w0, ds.firstWeek)), y1 = yearOf(w1);
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  const data = [];
  let scaleValues;   // colour classes come from the whole record so they stay put when the period changes
  if (!monthly) {
    for (let w = Math.max(w0, ds.firstWeek); w <= w1; w++) {
      const k = w % W, pct = FA.percentileOf(B.samples[k], H[w]);
      data.push([k, yearOf(w) - y0, S.calMode === 'count' ? H[w] : FA.anomalyClass(pct), pct, w]);
    }
    scaleValues = Array.from(H.subarray(ds.firstWeek));
  } else {
    for (const c of monthsInRange()) {
      const pct = FA.percentileOf(S.MB.samples[c.m], c.v);
      data.push([c.m, c.y - y0, S.calMode === 'count' ? c.v : FA.anomalyClass(pct), pct, c.yi * 12 + c.m, c.est]);
    }
    scaleValues = Array.from(S.M).filter(v => !isNaN(v));
  }
  const pieces = S.calMode === 'count' ? countPieces(scaleValues)
    : [-2, -1, 0, 1, 2].map((v, i) => ({ value: v, label: ANOM_LABELS[v], color: cssList('--div')[i] }));
  const unit = monthly ? 'Monthly' : 'Weekly';
  $('#cal-sub').textContent = `${unit} fire detections on the VIIRS S-NPP scale, ${years[0]}–${years[years.length - 1]}. ` +
    `Years marked * are reconstructed from MODIS. Click a cell to compare that year below.`;
  const el = $('#calendar');
  el.style.height = Math.max(240, years.length * (monthly ? 22 : 17) + (S.calMode === 'count' ? 92 : 116)) + 'px';
  const c = chart('calendar');
  c.resize();
  c.setOption({
    textStyle: base.textStyle,
    toolbox: toolbox(monthly ? 'calendar_monthly' : 'calendar_weekly'),
    tooltip: { ...base.tooltip, formatter: p => {
      const [k, yi, , pct, idx, est] = p.data, y = years[yi];
      if (monthly) {
        return `<strong>${MONTHS[k]} ${y}</strong><br>${fmt(S.M[idx])} detections${est ? ' (estimated from MODIS)' : ''}<br>
          Typical ${MONTHS[k]}: ${fmt(S.MB.p50[k])} · ${pctTxt(pct)}`;
      }
      const fill = (S.fillWeeks.has(idx) ? '<br><span class="muted">Includes S-NPP outage days filled from NOAA-20/MODIS</span>' : '') +
        (idx >= nrtStartWeek() ? '<br><span class="muted">Near-real-time data (standard processing not yet published)</span>' : '');
      return `<strong>Week of ${fmtDate(weekStart(y, k))}</strong><br>${fmt(H[idx])} detections${estimated(idx) ? ' (estimated from MODIS)' : ''}<br>
        Typical: ${fmt(B.p50[k])} · ${pctTxt(pct)}${fill}`;
    } },
    grid: { left: 48, right: 8, top: 26, bottom: S.calMode === 'count' ? 56 : 80 },
    xAxis: monthly
      ? { type: 'category', data: MONTHS, ...base.axisCommon, splitLine: { show: false } }
      : { type: 'category', data: monthTicks.map((_, k) => k), ...base.axisCommon, splitLine: { show: false },
        axisLabel: { ...base.axisCommon.axisLabel, interval: 0, formatter: (v, i) => monthTicks[i] } },
    yAxis: { type: 'category', data: years.map(y => y + (y < 2012 ? '*' : '')), inverse: true, ...base.axisCommon, splitLine: { show: false } },
    visualMap: { type: 'piecewise', dimension: 2, pieces, orient: 'horizontal', left: 'center', bottom: 0,
      itemWidth: 12, itemHeight: 10, itemGap: 8, textStyle: { color: cssVar('--text-2'), fontSize: 11 }, selectedMode: false },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: cssVar('--surface'), borderWidth: 1 },
      emphasis: { itemStyle: { borderColor: cssVar('--text'), borderWidth: 1.5 } }, progressive: 0 }],
  }, true);
  c.off('click');
  c.on('click', p => { S.year = years[p.data[1]]; renderBaseline(); });
}

function renderBaseline() {
  const ds = S.ds, B = S.B, H = S.H, base = baseChart(), y = S.year, yi = y - ds.firstYear;
  $('#year-label').textContent = y + (y < 2012 ? ' (estimated from MODIS)' : partialYear(y) ? ` (to ${fmtDate(new Date(recordEnd()), false)})` : '');
  $('#year-select').value = y;
  const band = cssVar('--band'), s = S.season, live = S.now.value != null;
  const yearData = B.p50.map((_, k) => { const w = yi * W + k; return w >= ds.firstWeek && w < ds.nWeeks ? H[w] : null; });
  const nowData = B.p50.map((_, k) => (live && k === S.now.k ? S.now.value : null));
  const areas = [];
  if (s) {
    const end = s.start + s.length - 1;
    if (end < W) areas.push([{ xAxis: s.start }, { xAxis: end }]);
    else { areas.push([{ xAxis: s.start }, { xAxis: W - 1 }]); areas.push([{ xAxis: 0 }, { xAxis: end - W }]); }
  }
  chart('baseline').setOption({
    textStyle: base.textStyle,
    toolbox: toolbox(`typical_year_vs_${y}`),
    legend: { ...base.legend, data: ['Typical range (10–90%)', 'Middle 50%', 'Median', String(y), ...(live ? ['Last 7 days (live)'] : [])] },
    tooltip: { ...base.tooltip, trigger: 'axis', formatter: ps => {
      const k = ps[0].dataIndex, w = yi * W + k;
      let t = `<strong>Week of ${weekLabel(k)}</strong><br>Median ${fmt(B.p50[k])} · middle 50% ${fmt(B.p25[k])}–${fmt(B.p75[k])} · 10–90% ${fmt(B.p10[k])}–${fmt(B.p90[k])}`;
      if (yearData[k] != null) t += `<br>${y}: ${fmt(yearData[k])} (${pctTxt(FA.percentileOf(B.samples[k], H[w]))})`;
      if (live && k === S.now.k) t += `<br>Last 7 days: ${fmt(S.now.value)}`;
      return t;
    } },
    grid: { left: 48, right: 12, top: 40, bottom: 28 },
    xAxis: { type: 'category', boundaryGap: false, data: monthTicks.map((_, k) => k), ...base.axisCommon, splitLine: { show: false },
      axisLabel: { ...base.axisCommon.axisLabel, interval: 0, formatter: (v, i) => monthTicks[i] } },
    yAxis: { type: 'value', ...base.axisCommon },
    series: [
      { name: 'Typical range (10–90%)', type: 'line', stack: 'r1', data: B.p10, lineStyle: { opacity: 0 }, symbol: 'none', silent: true, legendHoverLink: false, itemStyle: { color: band } },
      { name: 'Typical range (10–90%)', type: 'line', stack: 'r1', data: B.p90.map((v, k) => v - B.p10[k]), lineStyle: { opacity: 0 }, symbol: 'none',
        areaStyle: { color: band, opacity: 0.12 }, itemStyle: { color: band } },
      { name: 'Middle 50%', type: 'line', stack: 'r2', data: B.p25, lineStyle: { opacity: 0 }, symbol: 'none', silent: true, itemStyle: { color: band } },
      { name: 'Middle 50%', type: 'line', stack: 'r2', data: B.p75.map((v, k) => v - B.p25[k]), lineStyle: { opacity: 0 }, symbol: 'none',
        areaStyle: { color: band, opacity: 0.22 }, itemStyle: { color: band } },
      { name: 'Median', type: 'line', data: B.p50, symbol: 'none', lineStyle: { width: 2, color: band }, itemStyle: { color: band },
        markArea: { silent: true, itemStyle: { color: cssVar('--series-2'), opacity: 0.08 }, data: areas } },
      { name: String(y), type: 'line', data: yearData, symbol: 'none', lineStyle: { width: 2, color: cssVar('--series-1') }, itemStyle: { color: cssVar('--series-1') } },
      ...(live ? [{ name: 'Last 7 days (live)', type: 'scatter', data: nowData, symbolSize: 10,
        itemStyle: { color: cssVar('--series-2'), borderColor: cssVar('--surface'), borderWidth: 2 },
        label: { show: true, position: 'top', formatter: 'Now', color: cssVar('--text') } }] : []),
    ],
  }, true);
}

function renderForecast() {
  const fc = S.fc, base = baseChart(), m = S.model, now = S.now, live = now.value != null;
  const year = new Date(S.nrt.tMax * 60000).getUTCFullYear();
  const start = live ? now.value : S.B.p50[now.k];
  const labels = [live ? 'Now' : 'This week', ...fc.weeks.map(w => weekLabel(w.k))];
  const p10 = [start, ...fc.weeks.map(w => w.p10)], p90 = [start, ...fc.weeks.map(w => w.p90)];
  const orange = cssVar('--series-2');
  $('#forecast-sub').textContent = live
    ? `Expected weekly detections after ${fmtDate(new Date(S.nrt.tMax * 60000))}, starting from this week's live count.`
    : `No live VIIRS data, so this shows the seasonal expectation after ${fmtDate(new Date(S.nrt.tMax * 60000))}.`;
  chart('forecast').setOption({
    textStyle: base.textStyle,
    toolbox: toolbox('outlook_8_weeks'),
    legend: { ...base.legend, data: ['Forecast (median)', 'Likely range (80%)', 'Typical for the season'] },
    tooltip: { ...base.tooltip, trigger: 'axis', formatter: ps => {
      const i = ps[0].dataIndex;
      if (i === 0) return live ? `<strong>Last 7 days</strong><br>${fmt(now.value)} detections` : `<strong>This week</strong><br>Typical ${fmt(start)}`;
      const w = fc.weeks[i - 1];
      return `<strong>Week of ${weekLabel(w.k)} ${year}</strong><br>Forecast ${fmt(w.p50)} (80% range ${fmt(w.p10)}–${fmt(w.p90)})<br>
        Typical ${fmt(w.typical)} · chance above normal ${Math.round(w.pAbove * 100)}%`;
    } },
    grid: { left: 48, right: 12, top: 40, bottom: 28 },
    xAxis: { type: 'category', boundaryGap: false, data: labels, ...base.axisCommon, splitLine: { show: false } },
    yAxis: { type: 'value', ...base.axisCommon },
    series: [
      { name: 'Likely range (80%)', type: 'line', stack: 'f', data: p10, lineStyle: { opacity: 0 }, symbol: 'none', silent: true, itemStyle: { color: orange } },
      { name: 'Likely range (80%)', type: 'line', stack: 'f', data: p90.map((v, i) => v - p10[i]), lineStyle: { opacity: 0 }, symbol: 'none',
        areaStyle: { color: orange, opacity: 0.2 }, itemStyle: { color: orange } },
      { name: 'Typical for the season', type: 'line', data: [S.B.p50[now.k], ...fc.weeks.map(w => w.typical)], symbol: 'none',
        lineStyle: { width: 2, color: cssVar('--band') }, itemStyle: { color: cssVar('--band') } },
      { name: 'Forecast (median)', type: 'line', data: [start, ...fc.weeks.map(w => w.p50)], symbol: 'circle', symbolSize: 8,
        lineStyle: { width: 2, color: orange }, itemStyle: { color: orange, borderColor: cssVar('--surface'), borderWidth: 2 } },
    ],
  }, true);
  const skill = Math.round(m.skill * 100);
  $('#forecast-note').textContent = `Model: this area's seasonal cycle plus an autoregressive anomaly term (persistence φ = ${m.phi.toFixed(2)}), ` +
    `with uncertainty learned from every 1–8-week-ahead backtest over ${S.ds.firstYear}–${lastYear()}. ` +
    `Backtest error is ${Math.abs(skill)}% ${skill >= 0 ? 'lower' : 'higher'} than using the typical season alone. ` +
    `It forecasts overall activity, not individual fires.`;
}

function renderAnomalies() {
  const { w0, w1 } = S.range;
  const list = FA.anomalies(S.H, S.B, Math.max(S.ds.firstWeek, w0), S.ds.firstYear, 10, 3, w1);
  if (!list.length) { $('#anomalies').innerHTML = '<div class="empty">No weeks in this period exceed the 90th percentile.</div>'; return; }
  $('#anomalies').innerHTML = `<table><thead><tr><th>Week of</th><th class="num">Detections</th><th class="num">Typical</th>
    <th class="num">× typical</th><th class="num">Percentile</th><th>Source</th></tr></thead><tbody>` +
    list.map(a => `<tr><td>${fmtDate(weekStart(a.year, a.k))}</td><td class="num">${fmt(a.value)}</td><td class="num">${fmt(a.typical)}</td>
      <td class="num">${a.ratio.toFixed(1)}</td><td class="num">${Math.round(a.pct * 100)}</td>
      <td>${estimated(a.w) ? 'MODIS (est.)' : S.fillWeeks.has(a.w) ? 'VIIRS + gap fill' : 'VIIRS'}</td></tr>`).join('') + '</tbody></table>';
}

function renderAnnual() {
  const base = baseChart(), t = yearsInRange();
  const bar = { type: 'bar', stack: 'y', barMaxWidth: 18, itemStyle: { borderRadius: [4, 4, 0, 0] } };
  chart('annual').setOption({
    textStyle: base.textStyle,
    toolbox: toolbox('detections_per_year'),
    legend: { ...base.legend, data: ['Estimated from MODIS', 'Observed by VIIRS'] },
    tooltip: { ...base.tooltip, trigger: 'axis', formatter: ps => {
      const d = t[ps[0].dataIndex];
      return `<strong>${d.year}</strong><br>${fmt(d.total)} detections${d.partial ? '<br><span class="muted">Partial year: only weeks inside the period</span>' : ''}`;
    } },
    grid: { left: 56, right: 12, top: 40, bottom: 28 },
    xAxis: { type: 'category', data: t.map(d => d.year), ...base.axisCommon, splitLine: { show: false } },
    yAxis: { type: 'value', ...base.axisCommon },
    series: [
      { ...bar, name: 'Estimated from MODIS', data: t.map(d => (d.year < 2012 ? d.total : '-')), itemStyle: { ...bar.itemStyle, color: cssVar('--series-1-soft') } },
      { ...bar, name: 'Observed by VIIRS', data: t.map(d => (d.year >= 2012 ? d.total : '-')), itemStyle: { ...bar.itemStyle, color: cssVar('--series-1') } },
    ],
  }, true);
}

function renderMethod() {
  const ds = S.ds, v = ds.validation, base = baseChart(), mm = v.monthly_model, sr = v.single_ratio;
  const n20 = ds.noaa20, out = ds.outages;
  const quality = mm.r_log >= 0.8 ? 'high' : mm.r_log >= 0.6 ? 'moderate' : 'low';
  $('#method-sub').textContent = `${ds.name}: MODIS (1 km) is converted to the VIIRS 375 m scale with month-specific ratios fitted on the ${v.train[0]}–2020 overlap. ` +
    `Test: fit on ${v.train[0]}–${v.train[1]} only, then predict VIIRS for ${v.test[0]}–${v.test[1]} from MODIS alone.`;
  const tile = (label, value, note) => `<div class="tile"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`;
  $('#method-tiles').innerHTML =
    tile('Weekly correlation', mm.r_weekly.toFixed(2), `log scale ${mm.r_log.toFixed(2)}`) +
    tile('Total bias', (mm.bias_pct > 0 ? '+' : '') + mm.bias_pct.toFixed(0) + '%', `${v.test[0]}–${v.test[1]}`) +
    tile('Single-ratio baseline', sr.r_log.toFixed(2), 'log-scale correlation') +
    tile('Reconstruction quality', quality[0].toUpperCase() + quality.slice(1), `grid-cell × month r = ${v.cell_month_r_log.toFixed(2)}`) +
    (n20 ? tile('NOAA-20 → S-NPP', n20.r_weekly.toFixed(2), `weekly r, ×${n20.overall.toFixed(2)} overall, ${n20.years[0]}–${n20.years[1]}`) : '') +
    (out ? tile('S-NPP outage days', String(out.days), `filled with ${out.filled_noaa20.toLocaleString('en')} NOAA-20 + ${out.filled_modis.toLocaleString('en')} MODIS detections`) : '');
  const labels = v.weeks.map(w => fmtDate(weekStart(ds.firstYear + Math.floor(w / W), w % W)));
  chart('method').setOption({
    textStyle: base.textStyle,
    toolbox: { ...toolbox('harmonization_test'), feature: { saveAsImage: { title: 'Save PNG', name: `burning_calendar_${ds.name}_harmonization_test`, pixelRatio: 2, backgroundColor: cssVar('--surface') } } },
    legend: { ...base.legend, data: ['Observed by VIIRS', 'Predicted from MODIS'] },
    tooltip: { ...base.tooltip, trigger: 'axis' },
    grid: { left: 56, right: 12, top: 40, bottom: 28 },
    xAxis: { type: 'category', data: labels, ...base.axisCommon, splitLine: { show: false } },
    yAxis: { type: 'value', ...base.axisCommon },
    series: [
      { name: 'Observed by VIIRS', type: 'line', data: v.actual, symbol: 'none', lineStyle: { width: 2, color: cssVar('--series-1') }, itemStyle: { color: cssVar('--series-1') } },
      { name: 'Predicted from MODIS', type: 'line', data: v.predicted, symbol: 'none', lineStyle: { width: 2, color: cssVar('--series-2') }, itemStyle: { color: cssVar('--series-2') } },
    ],
  }, true);
  const r = ds.ratios;
  const recent = out ? out.snpp_runs.slice(-6).map(([a, b]) => (a === b ? a : `${a} → ${b.slice(5)}`)).join(', ') : '';
  $('#method-note').textContent = `Cleaning: vegetation fires only (FIRMS type 0), MODIS confidence ≥ 30, VIIRS nominal/high; static industrial sources are also masked from the live feed. ` +
    `Terra-only years (2000–2002) are first scaled to Terra+Aqua (×${Math.min(...r.terra_to_modis).toFixed(1)}–${Math.max(...r.terra_to_modis).toFixed(1)} by month). ` +
    `MODIS→VIIRS ratio by month: ${r.modis_to_viirs.map((x, i) => MONTHS[i] + ' ' + x.toFixed(1)).join(', ')}. ` +
    (out && out.days ? `Days when S-NPP delivered (almost) no data while other satellites saw fires are filled with NOAA-20 converted to the S-NPP scale, or with MODIS before 2023; weeks with such days are left out of every fit. Most recent: ${recent}.` : '');
}

// ---------- CSV ----------
function csv(rows) { return new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }); }

function weekSource(w) {
  const s = estimated(w) ? 'MODIS_harmonized' : S.fillWeeks.has(w) ? 'VIIRS_SNPP_gap_filled' : 'VIIRS_SNPP';
  return w >= nrtStartWeek() ? s + '_NRT' : s;
}

function downloadWeekly() {
  const ds = S.ds, H = S.H, F = S.F, B = S.B, { w0, w1 } = S.range;
  const rows = ['week_start,week_end,year,week_of_year,detections_viirs_scale,frp_mw_viirs_scale,source,typical_median,average_year,percentile'];
  for (let w = Math.max(w0, ds.firstWeek); w <= w1; w++) {
    const k = w % W;
    rows.push([isoDay(weekStartMs(w)), isoDay(weekEndMs(w)), yearOf(w), k + 1, H[w].toFixed(1), F[w].toFixed(0),
      weekSource(w), B.p50[k].toFixed(1), B.mean[k].toFixed(1), FA.percentileOf(B.samples[k], H[w]).toFixed(3)].join(','));
  }
  saveBlob(csv(rows), fileBase('weekly') + '.csv');
  status(`${rows.length - 1} weeks saved.`);
}

function downloadMonthly() {
  const rows = ['year,month,detections_viirs_scale,source,typical_median,average_year,percentile'];
  for (const c of monthsInRange()) {
    rows.push([c.y, c.m + 1, c.v.toFixed(1), c.est ? 'MODIS_harmonized' : 'VIIRS_SNPP', S.MB.p50[c.m].toFixed(1),
      S.MB.mean[c.m].toFixed(1), FA.percentileOf(S.MB.samples[c.m], c.v).toFixed(3)].join(','));
  }
  if (rows.length === 1) { status('No complete month in this period.'); return; }
  saveBlob(csv(rows), fileBase('monthly') + '.csv');
  status(`${rows.length - 1} months saved.`);
}

async function loadHotspotYear(y) {
  const key = S.ds.name + ':' + y;
  if (!hsCache.has(key)) {
    hsCache.set(key, (async () => {
      const r = await fetch('data/' + S.ds.hotspots.path.replace('{year}', y));
      if (!r.ok) throw new Error(`hotspots ${y}: HTTP ${r.status}`);
      const buf = await r.arrayBuffer(), n = new DataView(buf).getUint32(0, true);
      const u16 = i => new Uint16Array(buf, 4 + 2 * n * i, n);
      return { n, lat: u16(0), lon: u16(1), doy: u16(2), hhmm: u16(3), frp: u16(4),
        flags: new Uint8Array(buf, 4 + 10 * n, n), conf: new Uint8Array(buf, 4 + 11 * n, n) };
    })().catch(err => { hsCache.delete(key); throw err; }));
  }
  return hsCache.get(key);
}

/* All archived detections inside the area and period, as CSV text chunks. */
async function hotspotCsv(onProgress = () => {}) {
  const hs = S.ds.hotspots, { d0, d1 } = S.range, aoi = S.aoi;
  const y0 = new Date(d0).getUTCFullYear(), y1 = new Date(d1).getUTCFullYear();
  const years = hs.years.filter(([y]) => y >= y0 && y <= y1).map(([y]) => y);
  let box = null;
  if (aoi) {
    const la = aoi.map(p => p[0]), lo = aoi.map(p => p[1]);
    box = [Math.min(...la), Math.min(...lo), Math.max(...la), Math.max(...lo)];
  }
  const picked = [];
  let count = 0;
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    onProgress(`Loading ${y} (${i + 1} of ${years.length})…`);
    const t = await loadHotspotYear(y), jan1 = Date.UTC(y, 0, 1);
    const lo = Math.ceil((d0 - jan1) / DAY), hi = Math.floor((d1 - jan1) / DAY);
    const idx = [];
    for (let j = 0; j < t.n; j++) {
      const doy = t.doy[j];
      if (doy < lo || doy > hi) continue;
      if (aoi) {
        const lat = hs.lat0 + t.lat[j] * hs.step, lon = hs.lon0 + t.lon[j] * hs.step;
        if (lat < box[0] || lon < box[1] || lat > box[2] || lon > box[3] || !FA.pointInPolygon(lat, lon, aoi)) continue;
      }
      idx.push(j);
    }
    picked.push([y, t, idx]);
    count += idx.length;
    await new Promise(r => setTimeout(r));
  }
  return {
    count,
    build() {
      const parts = ['latitude,longitude,acq_date,acq_time_utc,satellite,instrument,confidence,frp_mw,daynight,counted_in_calendar\n'];
      for (const [y, t, idx] of picked) {
        const days = Array.from({ length: 366 }, (_, d) => isoDay(Date.UTC(y, 0, 1) + d * DAY));
        for (let a = 0; a < idx.length; a += 50000) {
          const rows = [];
          for (const j of idx.slice(a, a + 50000)) {
            const f = t.flags[j], sat = f & 3, viirs = sat >= 2;
            rows.push(`${(hs.lat0 + t.lat[j] * hs.step).toFixed(4)},${(hs.lon0 + t.lon[j] * hs.step).toFixed(4)},${days[t.doy[j]]},` +
              `${String(t.hhmm[j]).padStart(4, '0')},${ARCHIVE_SATS[sat]},${viirs ? 'VIIRS' : 'MODIS'},` +
              `${viirs ? (t.conf[j] === 2 ? 'high' : 'nominal') : t.conf[j]},${(t.frp[j] / 10).toFixed(1)},${f & 4 ? 'N' : 'D'},${f & 8 ? 1 : 0}`);
          }
          parts.push(rows.join('\n') + '\n');
        }
      }
      return parts;
    },
  };
}

async function downloadHotspots() {
  if (S.busy) return;
  setBusy(true);
  try {
    const res = await hotspotCsv(status);
    if (!res.count) { status('No archived hotspots inside this area and period.'); return; }
    if (res.count > 1e6 && !confirm(`This export holds ${res.count.toLocaleString('en')} hotspots (about ${Math.round(res.count * 75 / 1e6)} MB). ` +
      'Narrow the area or period for a smaller file. Download anyway?')) { status('Cancelled.'); return; }
    status('Writing CSV…');
    await new Promise(r => setTimeout(r));
    saveBlob(new Blob(res.build(), { type: 'text/csv' }), fileBase('hotspots') + '.csv');
    status(`${res.count.toLocaleString('en')} hotspots saved.`);
  } catch (err) {
    console.error(err);
    status('Download failed: ' + err.message);
  } finally {
    setBusy(false);
  }
}

function liveCsvRows() {
  const n = S.nrt, aoi = S.aoi;
  const rows = ['latitude,longitude,acq_datetime_utc,satellite,frp_mw,daynight,hours_before_latest_data'];
  for (let i = 0; i < n.lat.length; i++) {
    const inside = aoi ? FA.pointInPolygon(n.lat[i], n.lon[i], aoi) : S.selKeys.has(n.cellKey[i]);
    if (!inside) continue;
    rows.push([n.lat[i].toFixed(4), n.lon[i].toFixed(4), new Date(n.t[i] * 60000).toISOString().slice(0, 16).replace('T', ' '),
      SENSORS[n.s[i]], n.frp[i], n.dn[i], ((n.tMax - n.t[i]) / 60).toFixed(1)].join(','));
  }
  return rows;
}

function downloadLive() {
  const rows = liveCsvRows();
  if (rows.length === 1) { status('No live hotspots inside this area.'); return; }
  saveBlob(csv(rows), `burning_calendar_${S.ds.name}${S.aoi ? '_area' : ''}_live_${S.idx.nrt.start}_${S.idx.nrt.end}.csv`);
  status(`${(rows.length - 1).toLocaleString('en')} live hotspots saved.`);
}

function setBusy(b) {
  S.busy = b;
  $$('.downloads button').forEach(x => { x.disabled = b; });
}

// ---------- init ----------
async function init() {
  const guide = $('#guide');
  try { if (localStorage.getItem('bc-guide') === 'closed') guide.open = false; } catch (e) { /* storage blocked */ }
  guide.addEventListener('toggle', () => { try { localStorage.setItem('bc-guide', guide.open ? 'open' : 'closed'); } catch (e) { /* ignore */ } });
  initMap();
  S.idx = await getJSON('index.json');
  S.idx.countries.forEach(c => $('#country').add(new Option(c.name, c.file)));
  S.nrt = prepNrt(await getJSON(S.idx.nrt.file));
  for (const code of Object.keys(SENSORS)) {
    const el = document.querySelector(`[data-count="${code}"]`), p = S.nrt.per[code];
    el.textContent = `(${p ? p.count.toLocaleString('en') : 'no data'})`;
  }
  drawAgeLegend();
  hotLayer.redraw();
  await loadCountry(S.idx.countries[0].file);
  const api = S.idx.api, recEnd = S.idx.countries[0].lastDate, liveYear = +S.idx.nrt.start.slice(0, 4);
  if (api) {
    const sp = api.spEnd || {};
    $('#footer').insertAdjacentHTML('beforeend', ` ${api.year} comes from the FIRMS API: standard processing to ${sp.VIIRS_SNPP} (VIIRS) and ${sp.MODIS} (MODIS), ` +
      `near-real-time processing after that, clipped to ${api.boundary} borders. The calendar runs to ${recEnd}, the last complete week.`);
  } else if (liveYear > S.idx.countries[0].lastYear) {
    $('#footer').insertAdjacentHTML('beforeend', ` The record ends on ${recEnd}; later detections need the FIRMS API (MAP_KEY) and are not included yet.`);
  }

  $('#country').onchange = e => loadCountry(e.target.value);
  $('#reset-aoi').onclick = () => { drawn.clearLayers(); setAoi(null); };
  $('#point-form').onsubmit = gotoPoint;
  $('#dl-weekly').onclick = downloadWeekly;
  $('#dl-monthly').onclick = downloadMonthly;
  $('#dl-hotspots').onclick = downloadHotspots;
  $('#dl-live').onclick = downloadLive;
  $('#show-cells').onchange = drawCells;
  $('#year-select').onchange = e => { S.year = +e.target.value; renderBaseline(); };
  const fromInputs = () => setRange(parseDay($('#date-from').value), parseDay($('#date-to').value));
  $('#date-from').onchange = fromInputs;
  $('#date-to').onchange = fromInputs;
  $$('#range-presets button').forEach(b => b.onclick = () => setRange(...presetRanges()[b.dataset.preset]));
  $$('[data-sensor]').forEach(cb => cb.onchange = () => {
    cb.checked ? S.sensors.add(cb.dataset.sensor) : S.sensors.delete(cb.dataset.sensor);
    hotLayer.redraw();
  });
  $$('#cal-mode button').forEach(b => b.onclick = () => {
    S.calMode = b.dataset.mode;
    $$('#cal-mode button').forEach(x => x.classList.toggle('active', x === b));
    if (S.B) renderCalendar();
  });
  $$('#cal-grain button').forEach(b => b.onclick = () => {
    S.calGrain = b.dataset.grain;
    $$('#cal-grain button').forEach(x => x.classList.toggle('active', x === b));
    if (S.B) renderCalendar();
  });
  window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    setTiles(); drawCells(); drawAgeLegend(); hotLayer.redraw(); if (S.B) renderAll(); renderMethod();
  });
}

init().catch(err => {
  console.error(err);
  document.querySelector('.panels').insertAdjacentHTML('afterbegin',
    `<div class="card empty">Could not load data (${err.message}). Run <code>python pipeline/build.py</code> and serve the <code>web</code> folder over HTTP.</div>`);
});
