# Submission package: NASA Space Apps Challenge 2026

**Team Pixel Flame:** Ahmed Hashem, Zainab Ali
**Challenge:** Harmonization of MODIS and VIIRS Hot Spots

| File | What it is |
|---|---|
| [Pixel_Flame_Demo_Slides.pdf](Pixel_Flame_Demo_Slides.pdf) | **Project demo:** 7 slides |
| [PROJECT_PAGE.md](PROJECT_PAGE.md) | Text for every field of the Space Apps project page, plus the final checklist |
| [images/](images/) | Screenshots of the app and the situation report |
| [deck/](deck/) | Source of the slides (HTML and the sensor chart) |

To rebuild the PDF after editing `deck/deck.html` (Chrome or Edge):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --no-pdf-header-footer `
  --print-to-pdf="$PWD\submission\Pixel_Flame_Demo_Slides.pdf" "file:///$PWD/submission/deck/deck.html"
```

The app itself is in [`web/`](../web/). See the main [README](../README.md) for how it works and how to
run it.
