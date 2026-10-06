# Trace Board

Trace Board is a map of places found in Co-pilot trip logs. Each row is one place: a GPS mismatch, a detour, a speed limit, a closure, a lane, and the other types the report already flagged. The page is for review. It does not contain the raw `.pbf.gz` logs.

Open it in a browser. Nothing to install:

**https://dmtrmelnik.github.io/Trace-Board/problem-explorer/**

Anyone with the link sees the same list. That list is a published snapshot. It changes only after a new snapshot is pushed to `main`.

## What you do on the page

1. Click a row in **Matching findings**. The map moves to that place, and the details open beside it.
2. **DD** opens the same place in Directions Debug.
3. Each finding gets one tag: **True Detection**, **False positive detection**, or **N/A**. Enter your name first. **Undo** clears the tag so it can be changed. Until then, another tag cannot be set. Counts for the current filter sit under the list.
4. Filters above the list narrow it by type, severity, and text.
5. **Trace finder** takes a `.pbf.gz` file name. **Find** shows that trip above the map. **open trace** limits the list to findings from that file.
6. For **gps_divergence**, the red line is the drive and the blue line is where the map matcher placed the car. The lines appear when that row is selected.

If the page looks stale, hard-refresh: `Cmd+Shift+R`. GitHub can keep the previous copy for about 10 minutes after an update.

## What a viewer does not need

A viewer does not need the trip logs, a local checkout, or Python. The findings, coordinates, summaries, and trace file names are already in the page.

## Run a copy on your computer

Use this only if you want the files locally. The public link above is the shared page.

Shared tags need this server. The public GitHub link shows the list, but it cannot store tags.

```bash
git clone https://github.com/DmtrMelnik/Trace-Board.git
cd Trace-Board/problem-explorer
python3 serve_board.py
```

Then open http://127.0.0.1:8765/

Everyone who reviews together opens that same address (on one network, the computer’s IP instead of 127.0.0.1). Tags are written to `data/reviews.json` on the machine that runs the server.

Leave the terminal open. `Ctrl+C` stops the page. Python 3 is enough.

## How the list is updated

The page reads `problem-explorer/data/problems.js`. Rebuilding that file and pushing it to `main` is what colleagues see on the link. A local refresh does not change the public page.

The usual order:

1. Trip reports (`*-analysis.md`) already exist, or new logs are analyzed first.
2. The registry turns those reports into one JSON file.
3. `refresh_data.py` writes `problem-explorer/data/problems.js`.
4. That file is committed and pushed to `main`.

Commands for steps 2 and 3 are in [`problem-explorer/README.md`](problem-explorer/README.md).

[`problem-explorer/`](problem-explorer/) is the page. [`trace-problem-registry/`](trace-problem-registry/) builds the list from the reports. It does not upload trip logs.
