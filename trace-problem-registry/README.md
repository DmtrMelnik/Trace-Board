# Trace problem registry

Standalone **Python 3** (stdlib only) tool that reads Mapbox Co-pilot `*-analysis.md` reports and builds a local problem registry: markdown, CSV, JSON, and GeoJSON.

This repository does **not** decode `.pbf.gz` traces. The protobuf / gzip parser lives in the driverops trace-analysis CLI (`analyze_trace.mjs`). Run that first, then point this registry at the generated reports.

## Two-step workflow

### 1. Generate markdown reports from PBF traces (driverops repo)

From the driverops repository root, analyze traces with the existing CLI. Output is written next to each `.pbf.gz` as `<trace-name>-analysis.md`.

Example (local paths on this machine — replace with your checkout):

```bash
cd /Users/dzmitrymelnik/docs/driverops-driving-tracking-fresh
npm install   # first time only; needs the Node.js version declared by that repo

# Analyze every PBF in the real-trace folder (reports land beside each file)
npm run analyze-trace -- \
  scripts/trace-analysis/input-traces/real \
  --geojson
```

If traces sit in a folder that still needs a scan/split, use the driverops
`prepare-analysis` workflow documented in that repository. This registry does
not depend on the separate `search-destination-kit` copy.

### 2. Build the problem registry from `*-analysis.md`

```bash
cd /Users/dzmitrymelnik/docs/Trace-Board/trace-problem-registry

python3 build_problem_registry.py \
  --input-dir /Users/dzmitrymelnik/docs/driverops-driving-tracking-fresh/scripts/trace-analysis/input-traces/real \
  --output-dir ./output
```

`--input-dir` is scanned **recursively** for files named `*-analysis.md`. `--output-dir` is created if needed.

Optional: include informational rows (clean tunnels, slowdowns, completed routes, H1 transition/broad gaps, and similar):

```bash
python3 build_problem_registry.py \
  --input-dir /Users/dzmitrymelnik/docs/driverops-driving-tracking-fresh/scripts/trace-analysis/input-traces/real \
  --output-dir ./output \
  --include-info
```

The paths above are **examples from one local checkout**. They are not bundled with this repo.

## Outputs

| File | Contents |
|------|----------|
| `problems-report.md` | Run metadata, counts by Q / severity / category, then all findings grouped by Q with trace/report references and row metadata |
| `problems.csv` | Flattened common fields plus `metadata_json` |
| `problems.json` | Full finding records |
| `problems.geojson` | `FeatureCollection` of findings that have valid coordinates (`[lon, lat]`) |
| `run-summary.json` | Files scanned, parse errors, counts, include-info flag |

## Finding schema

Each record:

| Field | Notes |
|-------|--------|
| `problem_id` | Stable SHA-1 prefix of identifying fields |
| `q_code` | `Q1`, `Q2`, `Q3`, `Q4`, `Q5`, `Q_feedback`, `Q7`, `Q10`, `Q_EV`, `Q_lane`, `H1` |
| `category` | Coarse bucket (`route_changes`, `traffic`, …) |
| `problem_type` | Specific type or Q_lane RICO bucket (`G:lanes:wrong`, …) |
| `severity` | `high` / `medium` / `low` / `info` |
| `confidence` | Filled when the report gives a signal (Q_lane outcome); otherwise blank |
| `trace_file` | PBF name from the report Metadata table |
| `report_file` | Path of the `*-analysis.md` relative to `--input-dir` |
| `vehicle`, `user_id`, `project`, `platform`, `nav_native` | From Metadata |
| `timestamp_utc` | ISO-8601 `Z` when a row time exists |
| `lat`, `lon` | WGS84 when the row has coordinates; otherwise `null` |
| `summary` | One-line description |
| `metadata` | JSON object with Q-specific table cells and extra notes |

## What is parsed

Reports are expected to have a `## Metadata` field/value table and these sections (names as emitted by current `analyze_trace.mjs`):

- **Q1** Route Changes & Deviations — instability clusters, all table rows, flagged net ETA impact
- **Q2** Route Completion — incomplete/canceled routes, ETA too optimistic/pessimistic, poor-arrival (“driver stopped … from destination”)
- **Q3** Traffic — **actionable congestion** table (slowdown table only with `--include-info`)
- **Q4** GPS / Map-matched Divergence — worst-moment table plus teleport / raw-GPS fallback summaries
- **Q5** Search Destination — attempts with warnings or a selection; other attempts/selections with `--include-info`
- **Q_feedback** User Feedback — feedback event table
- **Q7** Tunnel Positioning — **degraded** rows only unless `--include-info`
- **Q10** Route Incidents — incident table, non-routable traversed note, closure table
- **Q_EV** EV Data — CS SOC mismatch and flagged prediction/arrival errors
- **Q_lane** Lane Guidance — RICO bucket subsections (`G:lanes:wrong`, `G:lanes:missing`, `G:active_mnvr:missing`, `G:active_mnvr:unneeded`, `G:banner:wrong`)
- **H1** Missing HD lanes — genuine gap rows; transition/broad coverage only with `--include-info`

**Q6, Q8, and Q9 do not exist** in current Co-pilot trace-analysis reports. This tool does not invent them.

Malformed tables and incomplete reports should not crash the run; failures are recorded in `run-summary.json` → `parse_errors`.

## Tests

No third-party packages. From this directory:

```bash
python3 -m unittest tests.test_registry -v
```

## Why PBF is out of scope here

`analyze_trace.mjs` depends on the nav-native-viz-based protobuf decoder in the driverops `scripts/trace-analysis/lib/` tree. This registry only consumes the markdown those scripts already wrote.
