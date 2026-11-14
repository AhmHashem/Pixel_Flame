# Pixel Flame: NASA Space Apps 2026 project page

Copy each section into the matching field of the Space Apps project form (My Team → Project → Edit).
Everything is in English. Items in **[square brackets]** need your action before you paste.

---

## Project Name

Pixel Flame

**Challenge:** Harmonization of MODIS and VIIRS Hot Spots

---

## High-Level Project Summary

Pixel Flame answers one question for any area of interest: *is this fire season normal?* Satellites have
mapped active fires for 26 years, but the record is split between NASA's MODIS (1 km pixels, since 2000)
and VIIRS (375 m pixels, since 2012) sensors, which count the same fires very differently.

We harmonized NASA FIRMS hotspots from MODIS (Terra, Aqua) and VIIRS (S-NPP, NOAA-20, NOAA-21) into one
consistent weekly record, from November 2000 to the last complete week. On years the model never saw,
MODIS predicts the real VIIRS counts with a weekly correlation of 0.99 for Sudan and Nigeria. The record
also stays continuous through sensor outages, including the loss of S-NPP data in November 2026.

On top of this record we built a free web app. Users pick a country, draw an area or enter coordinates,
and choose any period. They then get:

- a burning-activity calendar and comparisons with the historical normal
- an early-warning level and the number of separate fires
- similar past years, the season shift and a countdown to the season
- an 8-week outlook
- CSV and PNG downloads, and a one-page situation report

It is built for emergency responders, firefighters, land managers and scientists.

---

## Link to Project Demo

https://github.com/AhmHashem/Pixel_Flame/blob/main/submission/Pixel_Flame_Demo_Slides.pdf

**[This link works for judges only once the repository is public. If it stays private, upload the PDF to
Google Drive instead (Share → "Anyone with the link" → Viewer) and paste that link here.]**

---

## Link to Final Project

**[These links work only after the repository is made public and GitHub Pages is switched on.]**

- Live web app: https://ahmhashem.github.io/Pixel_Flame/
- Source code and documentation: https://github.com/AhmHashem/Pixel_Flame

---

## Detailed Project Description

### What it does

Pixel Flame turns 26 years of NASA satellite fire detections into a **burning-activity calendar** for any
area of interest. For a country, a drawn shape or a latitude/longitude with a radius, and for any period,
it shows:

- **The burning calendar:** weeks or months × years, as hotspot counts or as anomalies against the
  historical normal, in colour-blind-safe colours.
- **Early warning:** the last 7 days compared with the same week in every year since 2000, on a
  Normal / Elevated / High / Extreme scale. It also counts **separate fires**: hotspots within about
  1 km are merged, because a hotspot count is not a fire count.
- **When fire season comes:** the critical period (the weeks that hold 80% of typical burning) and a
  **countdown**, for example "Season usually starts around 3 Dec: in 19 days".
- **Is the season changing?** A comparison of 2001–2010 with 2016–2025: season centre, peak, start,
  length and yearly activity. A shift is called "clear" only when it is larger than year-to-year
  variation.
- **Similar past years:** for example "Sudan's 2026 so far looks most like 2004, then 2002 and 2008",
  with what happened in the rest of those years. These are described as historical analogs, not a
  forecast.
- **An 8-week outlook** with uncertainty ranges taken from the area's own backtests.
- **Downloads:** every individual hotspot in the area and period, weekly and monthly analytics, live
  hotspots (CSV), and any chart (PNG).
- **A one-page situation report** to print or save as PDF. It can cover the current view, any country,
  or all countries (an overview page plus one page each).

**Example from 14 Nov 2026:** Nigeria shows **High**, with 7,000 hotspots in the last 7 days against a
typical 3,155 (96th percentile), 19 days before its usual fire season starts.

### How it works: harmonizing MODIS and VIIRS

1. **Collect.** We use NASA FIRMS yearly country archives for 2000–2025 (MODIS C6.1, VIIRS S-NPP and
   NOAA-20). The current year comes from the FIRMS Area API, using standard processing where NASA has
   published it and near-real-time processing after that. The API's bounding-box results are clipped to
   Natural Earth country borders. A check against FIRMS's own country files for 1–5 January 2025 gave an
   exact match, with zero extra and zero missing detections.
2. **Clean.** We keep vegetation fires only (FIRMS type 0), MODIS confidence ≥ 30, and VIIRS nominal or
   high confidence. Gas flares, industrial heat and volcanoes are masked, including in near-real-time
   data, which has no type flag.
3. **Fill sensor gaps.** We detected 69 days between 2012 and 2026 when S-NPP delivered no or almost no
   data while other satellites saw fires, for example 3–6 Nov 2024, which is peak season. These days are
   filled with NOAA-20 data converted to the S-NPP scale, or with MODIS before 2023. The live early
   warning switches to NOAA-20 automatically when S-NPP is missing, as it has been since 2 Nov 2026.
4. **Grid.** Detections go onto a 0.25° grid with 52 weeks per year, from 1 Nov 2000 to the last
   complete week.
5. **Calibrate.** All conversions use month-specific ratios fitted on the periods when two sensors
   overlap, shrunk toward the all-year ratio in sparse months, and with outage weeks excluded from every
   fit:
   - Terra-only years are scaled to Terra+Aqua (fitted on 2003–2011).
   - MODIS is converted to the VIIRS scale (fitted on 2012–2020, before the Terra/Aqua orbits drifted).
   - NOAA-20 is converted to S-NPP (fitted on 2023–2025).
6. **Validate.** We fit on 2012–2017 only, then predict VIIRS for 2018–2020 from MODIS alone:

   | Country | Weekly r | Log r | Bias | Grid-cell × month r | NOAA-20 → S-NPP weekly r |
   |---|---|---|---|---|---|
   | Sudan | 0.99 | 0.97 | +0% | 0.80 | 0.998 |
   | Nigeria | 0.99 | 0.98 | +3% | 0.86 | 0.998 |
   | Egypt | 0.57 | 0.54 | −36% | 0.17 | 0.96 |

   Egypt's burning is mostly small agricultural fires that MODIS rarely sees. Its pre-2012 years are
   therefore clearly flagged as low quality in the app, the report and the season-shift comparison. The
   exported hotspot CSV agrees with the calendar to within 0.74% (Sudan, 2019).
7. **Analyse in the browser.** For any area and period, the app computes the following:
   - weekly and monthly percentile baselines (monthly totals add up exactly to yearly totals)
   - anomalies above the 90th percentile
   - the Theil–Sen trend
   - fire clusters
   - similar years: log-scale monthly distance over the complete months of this year
   - the season shift: an activity-weighted circular mean week, so seasons that cross New Year work,
     tested against twice its standard error
   - the outlook: the seasonal cycle plus an AR(1) anomaly term, with ranges from the area's own 1–8-week
     backtests

The record covers about 9.9 million satellite fire detections for Sudan, Nigeria and Egypt.

### Benefits and who it is for

- **Emergency responders and early-warning teams** can see at a glance whether this week is abnormal,
  how many separate fires are burning, and what the next weeks usually bring. They can hand on a
  one-page report.
- **Firefighters** can click a live hotspot to see time since detection, fire radiative power and a
  directions link, and download live hotspots for their area.
- **Land managers** can see when the season starts, how far into it they are, and whether it is shifting
  or intensifying.
- **Scientists** get an open, validated and documented method, plus hotspot-level and weekly/monthly
  CSVs.

The app is a static website: nothing to install, free to host, and it works on a phone. It can also run
in GitHub Codespaces with one click.

### What we hope to achieve

We want to give anyone responsible for a landscape a trustworthy answer to "is this normal?", early
enough to act. Next steps:

- extend to every country, then globally
- send automatic alerts when an area turns High
- add burned area and fire-weather data
- work with partner agencies so the harmonized record can be updated continuously

### Tools, languages and software

- **Languages:** Python (pandas, NumPy, matplotlib) for the data pipeline; JavaScript, HTML and CSS for
  the web app.
- **Map and charts:** Leaflet and Leaflet.draw for the map; Apache ECharts for the charts.
- **Quality checks:** headless Chrome for automated end-to-end browser tests (47 checks), and a
  colour-vision palette validator for accessible colours.
- **Code and hosting:** Git, GitHub, GitHub Pages and GitHub Codespaces.

### Limitations, stated openly

- Area statistics use 0.25° cells, so custom area edges are approximate to about 25 km. The hotspot CSV
  uses the exact area.
- Recent months use near-real-time data until NASA publishes standard processing.
- A hotspot is the centre of a satellite pixel, not a confirmed fire front. The outlook and similar years
  are statistical, not predictions of individual fires.

---

## Use of Super Intelligence (SI)

**We used AI to build the code.** Claude, Anthropic's AI assistant (through Claude Code in VS Code),
wrote the software under our direction:

- the Python data pipeline that downloads, cleans and harmonizes the data
- the JavaScript web app
- the automated browser tests

**Our team, Ahmed Hashem and Zainab Ali, did the following:**

- **Studied the challenge and NASA's data.** We read about the FIRMS active-fire products and the
  differences between MODIS and VIIRS, and worked through NASA's FIRMS tutorials (using the FIRMS API,
  ingesting the data, visualizing it, and subsetting it by a polygon or shapefile).
- **Planned the project.** We kept our own task tracker with goals and deadlines.
- **Made the list of features.** We decided what the app must do: multiple data sources, live hotspots,
  early warning, directions to fires, and an outlook. Later we reviewed a list of further ideas and
  chose the version 2 features: similar past years, the season shift and countdown, and the situation
  report covering one country or all countries.
- **Chose the demo countries:** Sudan, Nigeria and Egypt.
- **Downloaded the NASA data.** This included the FIRMS near-real-time fire files for Northern and
  Central Africa. We also requested our own FIRMS MAP_KEY so the 2026 data could be pulled from the
  FIRMS API.
- **Checked the local data files ourselves.**
- **Tested every feature on our own, one by one,** and reported what needed fixing. For example, while
  testing in GitHub Codespaces we found that the map background was blocked, which led to a change of
  basemap.
- **Set up and managed the project:** the GitHub repository, team access and Codespaces, the version 1
  and version 2 releases, and this submission.

All fire data shown in the app come directly from NASA FIRMS. No AI model generates, alters or predicts
the data at run time. The outlook and similar-years features are transparent statistical methods,
described in the project documentation.

---

## NASA Data

- **NASA FIRMS (Fire Information for Resource Management System):** https://firms.modaps.eosdis.nasa.gov/
  - **MODIS Collection 6.1 active fire detections (Terra and Aqua, 1 km), 2000–2025, from FIRMS yearly
    country archives.** These form the historical backbone of the record: Terra from Nov 2000, Aqua from
    Jul 2002.
  - **VIIRS 375 m active fire detections from S-NPP (VNP14IMG), 2012–2025, from FIRMS yearly country
    archives.** These form the reference scale of the harmonized record.
  - **VIIRS 375 m active fire detections from NOAA-20 (VJ114IMG), 2023–2025, from FIRMS yearly country
    archives.** We use them to calibrate NOAA-20 to S-NPP and to fill S-NPP outage days.
  - **FIRMS Area API (MAP_KEY), 2026:** https://firms.modaps.eosdis.nasa.gov/api/
    MODIS, VIIRS S-NPP and VIIRS NOAA-20 data for the current year, using standard processing where
    available and near-real-time processing after that. It also reports which periods each product
    covers.
  - **FIRMS near-real-time 7-day active fire files for Northern and Central Africa (VIIRS S-NPP, NOAA-20,
    NOAA-21 and MODIS):** https://firms.modaps.eosdis.nasa.gov/active_fire/
    These feed the live hotspot layer, the early warning and the separate-fire counts.

---

## Space Agency Partner Data and Other References

**Space agency partner data:** none used.

**Other data and software:**

- Natural Earth 1:10m Admin 0 country borders (public domain), used to clip FIRMS API results:
  https://www.naturalearthdata.com/
- Esri World Light and Dark Gray Canvas basemaps (Esri, HERE, Garmin, © OpenStreetMap contributors, and
  the GIS user community)
- Leaflet (https://leafletjs.com/), Leaflet.draw, Apache ECharts (https://echarts.apache.org/), pandas,
  NumPy, matplotlib

**Scientific references:**

- Giglio, L., Schroeder, W., & Justice, C. O. (2016). The collection 6 MODIS active fire detection
  algorithm and fire products. *Remote Sensing of Environment*, 178, 31–41.
- Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. A. (2014). The New VIIRS 375 m active fire
  detection data product: Algorithm description and initial assessment. *Remote Sensing of Environment*,
  143, 85–96.
- Sen, P. K. (1968). Estimates of the regression coefficient based on Kendall's tau. *Journal of the
  American Statistical Association*, 63(324), 1379–1389.
- Fisher, N. I. (1993). *Statistical Analysis of Circular Data*. Cambridge University Press.

---

## Team

**Pixel Flame:** Ahmed Hashem, Zainab Ali (both registered at the same Local Event)
Challenge: Harmonization of MODIS and VIIRS Hot Spots
Contact (email only): ahmedhashem0101@gmail.com · sham200785@gmail.com

---

## Images to upload to the project page (optional, JPG/PNG/GIF up to 10 MB)

All are in `submission/images/`:

| File | Caption to use |
|---|---|
| `app_overview.png` | Pixel Flame: live hotspots, early warning and the critical period for Sudan |
| `card_calendar.png` | Burning calendar: weekly hotspots 2000–2026 on one harmonized scale |
| `card_similar_years.png` | Similar past years: 2026 so far compared with the closest years |
| `card_season_change.png` | Is the fire season changing? 2001–2010 vs 2016–2025 |
| `report_nigeria.png` | One-page situation report (Nigeria, 14 Nov 2026) |
| `report_overview.png` | All-countries overview page of the situation report |

---

## If you prefer a 30-second video instead of the slides (optional script)

| Time | On screen | Say (English, or another language with English subtitles) |
|---|---|---|
| 0:00 | Title slide | "We are Ahmed Hashem and Zainab Ali, team Pixel Flame." |
| 0:03 | Sensor chart (slide 2) | "Twenty-six years of NASA fire data are split between satellites that count the same fires differently." |
| 0:08 | App, Sudan calendar | "Pixel Flame harmonizes MODIS and VIIRS into one burning calendar for any area." |
| 0:13 | Draw an area → calendar → early-warning card | "Draw an area, pick a period, and see if this season is normal: early warning, separate fires, similar past years." |
| 0:21 | Situation report → Print | "Responders get a one-page report." |
| 0:25 | Overview page | "Is this fire season normal? Now anyone can answer, with NASA data." |

Keep it at **30 seconds or less**. Longer demos are not eligible for Global Judging.

---

## Final checklist before "Submit for Judging" (deadline: Sun 15 Nov 2026, 11:59 pm, local event time)

- [ ] Repository made public and GitHub Pages switched on; the live app link works.
- [ ] Demo PDF uploaded with a public link (Google Drive "Anyone with the link", or GitHub).
- [ ] Every link opens in a private/incognito window without logging in.
- [x] Both team members are confirmed at the **same Local Event**.
- [ ] All fields pasted; images uploaded; everything in English.
- [ ] No images or video of anyone under 18.
- [ ] Tick **Terms and Conditions** and **Confirm All Work is Original**, then click **Submit for Judging**.
- [ ] Confirmation banner seen. You can edit and resubmit until the deadline.
