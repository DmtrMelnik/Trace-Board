# Trace Board

Open the page in a browser. Nothing to install:

**https://dmtrmelnik.github.io/Trace-Board/problem-explorer/**

The page lists findings from Co-pilot trip logs on a map. Pick a row, the map moves to that place. Checkboxes and notes stay in your browser only. They are not saved on GitHub.

## Run the same page on your computer

```bash
git clone https://github.com/DmtrMelnik/Trace-Board.git
cd Trace-Board/problem-explorer
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/

Python 3 is enough. After the page is already open, a hard refresh is `Cmd+Shift+R`.

## What else is in this repo

[`problem-explorer/`](problem-explorer/) is the page above. How to refresh its data after new trip logs is in [`problem-explorer/README.md`](problem-explorer/README.md).

[`trace-problem-registry/`](trace-problem-registry/) turns `*-analysis.md` reports into the list the page shows. It does not upload traces.
