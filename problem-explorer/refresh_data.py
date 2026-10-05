#!/usr/bin/env python3
"""Rebuild problem-explorer/data/problems.js from the registry JSON snapshot."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_JSON = HERE.parent / "trace-problem-registry" / "output" / "problems.json"
DEFAULT_GEOJSON = HERE.parent / "trace-problem-registry" / "output" / "problems.geojson"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--geojson", type=Path, default=DEFAULT_GEOJSON)
    parser.add_argument("--out-dir", type=Path, default=HERE / "data")
    args = parser.parse_args()
    if not args.json.is_file():
        raise SystemExit(f"missing {args.json} — run the registry first")
    data = json.loads(args.json.read_text(encoding="utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    js = args.out_dir / "problems.js"
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    js.write_text("window.TRACE_PROBLEMS=" + payload + ";\n", encoding="utf-8")
    print(f"wrote {js} ({js.stat().st_size} bytes, {len(data)} findings)")
    if args.geojson.is_file():
        dest = args.out_dir / "problems.geojson"
        shutil.copyfile(args.geojson, dest)
        print(f"copied {dest}")


if __name__ == "__main__":
    main()
