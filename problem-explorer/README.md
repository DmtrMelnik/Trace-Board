# Trace Board

Local dashboard for the unified problem registry: map + filters + category tabs + triage.
English UI. Mapbox Assembly (light). No Mapbox token — OSM tiles via Leaflet.

This is **not a 3,000-row spreadsheet**. Findings are pins (clustered) and compact cards.
Click a card to zoom the map when the row has coordinates.

## Open it

Anyone can open the page already hosted on GitHub:

**https://dmtrmelnik.github.io/Trace-Board/problem-explorer/**

To run the same files on your computer, serve this folder. Browsers block `fetch` of local files, and the snapshot is `data/problems.js`:

```bash
cd /Users/dzmitrymelnik/docs/Trace-Board/problem-explorer
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/

Hard-refresh the tab (`Cmd+Shift+R`) after replacing `data/problems.js`. Triage labels stay in **this browser** (`localStorage`), not in the files.

## Refresh after new Co-pilot traces (do this yourself)

Three steps. **PBF source is only** `scripts/trace-analysis/input-traces/real/`. Do not point the registry at the parent `input-traces/` folder (that also has `simulated/`, `short/`, `stationary/`).

**1. Analyze the new `.pbf.gz` files** — **only** `scripts/trace-analysis/input-traces/real/` (not `simulated/`, `short/`, or `stationary/`):

```bash
cd /Users/dzmitrymelnik/docs/driverops-driving-tracking-fresh
npm run analyze-trace -- scripts/trace-analysis/input-traces/real --geojson
```

**2. Rebuild the problem registry from those markdown reports:**

```bash
cd /Users/dzmitrymelnik/docs/Trace-Board/trace-problem-registry
python3 build_problem_registry.py \
  --input-dir /Users/dzmitrymelnik/docs/driverops-driving-tracking-fresh/scripts/trace-analysis/input-traces/real \
  --output-dir ./output
```

**3. Copy the snapshot into the website and reload:**

```bash
cd /Users/dzmitrymelnik/docs/Trace-Board/problem-explorer
python3 refresh_data.py
# if the server is not running:
python3 -m http.server 8765
```

Then hard-refresh http://127.0.0.1:8765/

`geo_source` on the finding card tells you how the pin was placed:

| Value | Meaning |
|-------|---------|
| *(none)* / table cell | Coordinates were in the `*-analysis.md` row |
| `annotations.geojson` | Taken from the sibling viz pins |
| `report_centroid` | This row had no own point; pin is the average of other findings in the **same** trace |
| `annotations_centroid` | No table coords in that report; pin is the average of that trace’s annotation points |

## Load your own files

**Load file** accepts:

| File | What happens |
|------|----------------|
| `problems.js` / `problems.json` / `problems.csv` | Replaces the finding list |
| Registry `problems.geojson` | Replaces the list with **geocoded** rows only |
| Trace `*-annotations.geojson` | Extra overlay layer (pins from analyze_trace `--geojson`) |

You can drop several files at once (registry JSON + an annotations GeoJSON).

Refresh the bundled snapshot after a new registry run:

```bash
python3 refresh_data.py
```

(reads `../trace-problem-registry/output/problems.json` by default)

## How to use

1. KPI row: loaded count, with coordinates, high severity, unlabeled.
2. **By Q-code** chips and **Category** tabs (route_changes, gps_divergence, …).
3. Filters: search (`summary` / `problem_id`), `problem_type`, severity, sort, triage label, viewed, project, platform, VIN, user, date, coordinates-only.
4. Map: color = Q-code, size = severity, clusters on zoom out. Popup on pin click.
5. Matching findings: short cards (not a full table). Click → zoom + detail. Click **Trace** on the detail card to open a panel under the map with every finding from that PBF (map and list also focus on that trace). **Show all traces** clears it.
6. Triage on the detail card: viewed, label (`true_map_issue` / `nav_sdk` / `driver_behavior` / `noise` / `expected_incident`), notes. **Export triage** downloads CSV.

`problem_id` is still a registry hash, not a field inside the PBF. Use time + lat/lon from the detail card in nav-native-viz.
