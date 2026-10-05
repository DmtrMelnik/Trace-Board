# Trace Board

## Local trace problem registry

[`trace-problem-registry/`](trace-problem-registry/) collects findings from
Mapbox Co-pilot `*-analysis.md` reports into one local Markdown report plus
CSV, JSON, and GeoJSON outputs.

The tool is standalone, uses only Python's standard library, and does not
upload traces or findings.

## Problem explorer (browser)

[`problem-explorer/`](problem-explorer/) is a Mapbox Assembly dashboard for
`problems.csv` / JSON: clustered map, category tabs, filters, and local triage.
No build step — serve the folder (`python3 -m http.server`) and open it, or
share via GitHub Pages. See [`problem-explorer/README.md`](problem-explorer/README.md).
