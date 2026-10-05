#!/usr/bin/env python3
"""Standalone registry that turns Co-pilot *-analysis.md reports into findings."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

# Current Mapbox Co-pilot analyze_trace.mjs reports do not emit these questions.
UNSUPPORTED_Q_CODES = ("Q6", "Q8", "Q9")
UNSUPPORTED_Q_NOTE = (
    "Q6, Q8, and Q9 do not exist in current Mapbox Co-pilot trace-analysis reports "
    "and are not parsed."
)

Q_ORDER = (
    "Q1",
    "Q2",
    "Q3",
    "Q4",
    "Q5",
    "Q_feedback",
    "Q7",
    "Q10",
    "Q_EV",
    "Q_lane",
    "Q_oneway",
    "Q_map",
    "H1",
)

Q_TITLES = {
    "Q1": "Q1 — Route Changes & Deviations",
    "Q2": "Q2 — Route Completion",
    "Q3": "Q3 — Traffic",
    "Q4": "Q4 — GPS / Map-matched Divergence",
    "Q5": "Q5 — Search Destination",
    "Q_feedback": "Q_feedback — User Feedback",
    "Q7": "Q7 — Tunnel Positioning",
    "Q10": "Q10 — Route Incidents",
    "Q_EV": "Q_EV — EV Data",
    "Q_lane": "Q_lane — Lane Guidance & Maneuver Quality",
    "Q_oneway": "Q_oneway — Against OSM one-way",
    "Q_map": "Q_map — Map data signals",
    "H1": "H1 — Missing HD lanes",
}

Q_CATEGORIES = {
    "Q1": "route_changes",
    "Q2": "route_completion",
    "Q3": "traffic",
    "Q4": "gps_divergence",
    "Q5": "search_destination",
    "Q_feedback": "user_feedback",
    "Q7": "tunnel_positioning",
    "Q10": "route_incidents",
    "Q_EV": "ev",
    "Q_lane": "lane_guidance",
    "Q_oneway": "oneway",
    "Q_map": "map_data",
    "H1": "hd_lanes",
}

COMMON_FIELDS = (
    "problem_id",
    "q_code",
    "category",
    "problem_type",
    "severity",
    "confidence",
    "trace_file",
    "report_file",
    "vehicle",
    "user_id",
    "project",
    "platform",
    "nav_native",
    "timestamp_utc",
    "lat",
    "lon",
    "summary",
)

BLANK_TOKENS = {"", "—", "–", "-", "n/a", "na", "none", "null"}
SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2, "info": 3}
# GPS divergence within this distance of a tunnel portal on the same trace
# is treated as signal loss. A portal from another trace does not hide it.
TUNNEL_DIV_M = 300

SECTION_RE = re.compile(r"^##[ \t]+(.+?)\s*$", re.M)
RICO_HEADING_RE = re.compile(r"^###[ \t]+`([^`]+)`\s*—\s*(.+?)\s*$", re.M)
TIME_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*UTC|Z)?"
)
LATLON_PAIR_RE = re.compile(
    r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)"
)
def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def is_blank(value: Any) -> bool:
    if value is None:
        return True
    text = str(value).strip()
    if not text:
        return True
    cleaned = re.sub(r"[`*]", "", text).strip().lower()
    return cleaned in BLANK_TOKENS


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = text.replace("**", "")
    return text.strip()


def normalize_header(value: str) -> str:
    text = clean_cell(value).lower()
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def split_row(line: str) -> Optional[List[str]]:
    raw = line.rstrip("\n")
    stripped = raw.strip()
    if not stripped.startswith("|"):
        return None
    body = stripped[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [cell.strip() for cell in body.split("|")]


def is_separator_row(line: str) -> bool:
    cells = split_row(line)
    if not cells:
        return False
    if not any(cells):
        return False
    for cell in cells:
        token = cell.strip().replace(" ", "")
        if not token:
            continue
        if not re.fullmatch(r":?-{3,}:?", token):
            return False
    return True


def iter_markdown_tables(text: str) -> Iterable[Tuple[List[str], List[Dict[str, str]]]]:
    """Yield (normalized_headers, rows) for each GitHub-style markdown table."""
    lines = text.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        header_cells = split_row(lines[i])
        if header_cells is None or i + 1 >= n or not is_separator_row(lines[i + 1]):
            i += 1
            continue
        headers = [normalize_header(c) for c in header_cells]
        i += 2
        rows: List[Dict[str, str]] = []
        while i < n:
            row_cells = split_row(lines[i])
            if row_cells is None:
                break
            if is_separator_row(lines[i]):
                i += 1
                continue
            if len(row_cells) < len(headers):
                row_cells = row_cells + [""] * (len(headers) - len(row_cells))
            elif len(row_cells) > len(headers):
                extra = " | ".join(row_cells[len(headers) - 1 :])
                row_cells = row_cells[: len(headers) - 1] + [extra]
            mapped = {
                headers[idx]: clean_cell(row_cells[idx])
                for idx in range(len(headers))
            }
            if any(v for v in mapped.values()):
                rows.append(mapped)
            i += 1
        yield headers, rows


def table_has_headers(headers: Sequence[str], required: Sequence[str]) -> bool:
    have = set(headers)
    return all(normalize_header(name) in have for name in required)


def first_table(
    text: str, required: Sequence[str]
) -> Tuple[List[str], List[Dict[str, str]]]:
    for headers, rows in iter_markdown_tables(text):
        if table_has_headers(headers, required):
            return list(headers), rows
    return [], []


def all_tables(
    text: str, required: Sequence[str]
) -> List[Tuple[List[str], List[Dict[str, str]]]]:
    found = []
    for headers, rows in iter_markdown_tables(text):
        if table_has_headers(headers, required):
            found.append((list(headers), rows))
    return found


def rowget(row: Dict[str, str], *names: str) -> str:
    for name in names:
        key = normalize_header(name)
        if key in row:
            return row.get(key) or ""
    return ""


def to_iso_utc(text: str) -> str:
    if is_blank(text):
        return ""
    match = TIME_RE.search(text)
    if not match:
        return clean_cell(text)
    return f"{match.group(1)}T{match.group(2)}Z"


def valid_lat_lon(lat: Optional[float], lon: Optional[float]) -> bool:
    if lat is None or lon is None:
        return False
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return False
    return -90.0 <= lat_f <= 90.0 and -180.0 <= lon_f <= 180.0


def parse_float(text: str) -> Optional[float]:
    if is_blank(text):
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", str(text).replace(",", ""))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def parse_lat_lon_pair(text: str, order: str = "latlon") -> Tuple[Optional[float], Optional[float]]:
    if is_blank(text):
        return None, None
    match = LATLON_PAIR_RE.search(text)
    if not match:
        return None, None
    first = float(match.group(1))
    second = float(match.group(2))
    if order == "lonlat":
        lon, lat = first, second
    else:
        lat, lon = first, second
    if valid_lat_lon(lat, lon):
        return lat, lon
    if order == "latlon" and valid_lat_lon(second, first):
        return second, first
    return None, None


def parse_q3_location(text: str) -> Tuple[Optional[float], Optional[float]]:
    if is_blank(text):
        return None, None
    inner = text.strip().strip("()")
    first = inner.split(";")[0]
    return parse_lat_lon_pair(first, order="lonlat")


def parse_arrow_location(text: str) -> Tuple[Optional[float], Optional[float]]:
    if is_blank(text):
        return None, None
    start = text.split("→")[0].split("->")[0]
    return parse_lat_lon_pair(start, order="latlon")


def coords_from_text(text: str, order: str = "latlon") -> Tuple[Optional[float], Optional[float]]:
    """Parse a coordinate pair. Default is lat,lon (analyze_trace Location column)."""
    if is_blank(text):
        return None, None
    chunk = str(text).split(";")[0].split("→")[0].split("->")[0]
    match = LATLON_PAIR_RE.search(chunk)
    if not match:
        return None, None
    first = float(match.group(1))
    second = float(match.group(2))
    if abs(first) > 90 and abs(second) <= 90:
        lon, lat = first, second
    elif order == "lonlat":
        lon, lat = first, second
    else:
        lat, lon = first, second
    if valid_lat_lon(lat, lon):
        return lat, lon
    return None, None


def attach_coords_from_row_fields(finding: Dict[str, Any]) -> Dict[str, Any]:
    if valid_lat_lon(finding.get("lat"), finding.get("lon")):
        return finding
    meta = finding.get("metadata") or {}
    preferred = (
        ("location", "latlon"),
        ("location (start → end)", "latlon"),
        ("location (lon,lat)", "lonlat"),
        ("route coords", "lonlat"),
        ("coords", "latlon"),
    )
    for key, order in preferred:
        lat, lon = coords_from_text(str(meta.get(key) or ""), order=order)
        if valid_lat_lon(lat, lon):
            finding["lat"] = lat
            finding["lon"] = lon
            meta = dict(meta)
            meta["geo_source"] = f"metadata:{key}"
            finding["metadata"] = meta
            finding["problem_id"] = assign_problem_id(finding)
            return finding
    lat = parse_float(str(meta.get("lat") or ""))
    lon = parse_float(str(meta.get("lon") or ""))
    if valid_lat_lon(lat, lon):
        finding["lat"] = lat
        finding["lon"] = lon
        meta = dict(meta)
        meta["geo_source"] = "metadata:lat,lon"
        finding["metadata"] = meta
        finding["problem_id"] = assign_problem_id(finding)
        return finding
    for key, value in meta.items():
        if not isinstance(value, str):
            continue
        lat, lon = coords_from_text(value)
        if valid_lat_lon(lat, lon):
            finding["lat"] = lat
            finding["lon"] = lon
            meta = dict(meta)
            meta["geo_source"] = f"metadata:{key}"
            finding["metadata"] = meta
            finding["problem_id"] = assign_problem_id(finding)
            return finding
    summary = str(finding.get("summary") or "")
    match = LATLON_PAIR_RE.search(summary)
    if match and "." in match.group(1) and "." in match.group(2):
        lat, lon = coords_from_text(match.group(0))
        if valid_lat_lon(lat, lon):
            finding["lat"] = lat
            finding["lon"] = lon
            meta = dict(meta)
            meta["geo_source"] = "summary"
            finding["metadata"] = meta
            finding["problem_id"] = assign_problem_id(finding)
            return finding
    return finding


def annotation_geojson_paths(report_path: Path) -> List[Path]:
    stem = report_path.name.replace("-analysis.md", "")
    direct = report_path.with_name(stem + "-annotations.geojson")
    found: List[Path] = []
    if direct.is_file():
        found.append(direct)
    uuid_match = re.search(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        stem,
        re.I,
    )
    if uuid_match:
        for path in report_path.parent.glob(f"*{uuid_match.group(0)}*-annotations.geojson"):
            if path not in found:
                found.append(path)
    return found


def load_annotation_points(report_path: Path) -> List[Dict[str, Any]]:
    points: List[Dict[str, Any]] = []
    for path in annotation_geojson_paths(report_path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for feat in data.get("features") or []:
            geom = feat.get("geometry") or {}
            coords = geom.get("coordinates") or []
            geom_type = geom.get("type")
            if geom_type == "Point":
                pair = coords
            elif geom_type in ("LineString", "MultiPoint") and coords:
                pair = coords[0]
            elif geom_type == "Polygon" and coords and coords[0]:
                pair = coords[0][0]
            else:
                continue
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            lon, lat = pair[0], pair[1]
            if not valid_lat_lon(lat, lon):
                continue
            props = feat.get("properties") or {}
            points.append(
                {
                    "lat": float(lat),
                    "lon": float(lon),
                    "label": str(props.get("label") or ""),
                    "notes": str(props.get("notes") or ""),
                }
            )
    return points


def _label_matches_finding(label: str, finding: Dict[str, Any]) -> bool:
    q = finding.get("q_code") or ""
    ptype = finding.get("problem_type") or ""
    if label == "GPS divergence":
        return q == "Q4" and ptype == "gps_divergence"
    if label == "off-route":
        return q == "Q1" and ptype == "off_route"
    if label == "route-change":
        return q == "Q1" and ptype == "route_change"
    if label.startswith("tunnel degraded"):
        return q == "Q7"
    if label in {"FN-risk", "over-pred", "congestion"}:
        return q == "Q3" and ptype == "congestion_signal"
    if label in {"POI pin", "Routable point", "Directions dest"}:
        return q == "Q5"
    if q == "Q_lane" and (label == ptype or label.startswith(ptype)):
        return True
    if q == "H1" and "hd:missing" in label:
        return True
    if q == "Q10" and any(
        token in label.lower()
        for token in ("construction", "lane_restriction", "road_closure", "incident", "closure")
    ):
        return True
    if q == "Q_feedback" and label.lower() in {"info", "feedback", "user feedback"}:
        return True
    return False


def _peak_m_from_notes(notes: str) -> Optional[int]:
    match = re.search(r"peak:\s*(\d+)\s*m", notes or "", re.I)
    return int(match.group(1)) if match else None


def load_divergence_lines(report_path: Path) -> List[Dict[str, Any]]:
    """Short GPS (drive) and map-matched polylines emitted beside each Q4 pin."""
    lines: List[Dict[str, Any]] = []
    for path in annotation_geojson_paths(report_path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for feat in data.get("features") or []:
            geom = feat.get("geometry") or {}
            if geom.get("type") != "LineString":
                continue
            props = feat.get("properties") or {}
            label = str(props.get("label") or "")
            if label not in (
                "GPS divergence drive",
                "GPS divergence matched",
                "Missed road drive",
                "Missed road osm",
                "Detour drive",
                "Detour route",
            ):
                continue
            coords = [
                [float(pair[0]), float(pair[1])]
                for pair in (geom.get("coordinates") or [])
                if isinstance(pair, (list, tuple)) and len(pair) >= 2
                and valid_lat_lon(pair[1], pair[0])
            ]
            if len(coords) < 2:
                continue
            lines.append({
                "label": label,
                "notes": str(props.get("notes") or ""),
                "coordinates": coords,
            })
    return lines


def attach_divergence_lines(
    findings: List[Dict[str, Any]],
    lines: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not lines:
        return findings
    grouped: Dict[str, Dict[str, List[List[float]]]] = {}
    for line in lines:
        match = re.search(r"t:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)", line.get("notes") or "")
        if not match:
            continue
        kind = "div"
        if line["label"].startswith("Detour"):
            kind = "detour"
        elif line["label"].startswith("Missed"):
            kind = "missed"
        slot = grouped.setdefault(f"{match.group(1)}|{kind}", {})
        if line["label"] in ("GPS divergence drive", "Missed road drive", "Detour drive"):
            slot["gps_line"] = line["coordinates"]
        elif line["label"] == "GPS divergence matched":
            slot["matched_line"] = line["coordinates"]
        elif line["label"] == "Detour route":
            slot["route_line"] = line["coordinates"]
        else:
            slot["road_line"] = line["coordinates"]
    if not grouped:
        return findings
    for finding in findings:
        ts = finding.get("timestamp_utc") or ""
        if finding.get("problem_type") == "node_detour":
            slot = grouped.get(f"{ts}|detour")
        elif finding.get("problem_type") == "missed_road":
            slot = grouped.get(f"{ts}|missed")
        elif finding.get("problem_type") == "gps_divergence":
            slot = grouped.get(f"{ts}|div")
        else:
            continue
        if not slot:
            continue
        meta = dict(finding.get("metadata") or {})
        if slot.get("gps_line"):
            meta["gps_line"] = slot["gps_line"]
        if slot.get("matched_line"):
            meta["matched_line"] = slot["matched_line"]
        if slot.get("road_line"):
            meta["road_line"] = slot["road_line"]
        if slot.get("route_line"):
            meta["route_line"] = slot["route_line"]
        finding["metadata"] = meta
        finding["problem_id"] = assign_problem_id(finding)
    return findings


def enrich_from_annotations(
    findings: List[Dict[str, Any]], points: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    unused = list(points)
    for finding in findings:
        if valid_lat_lon(finding.get("lat"), finding.get("lon")):
            continue
        ts = (finding.get("timestamp_utc") or "")[:19].replace("T", " ")
        dist = parse_float(str((finding.get("metadata") or {}).get("worst dist") or ""))
        best_i = None
        best_score = -1
        for i, pt in enumerate(unused):
            if not _label_matches_finding(pt["label"], finding):
                continue
            score = 1
            if ts and ts in (pt["notes"] or ""):
                score += 5
            peak = _peak_m_from_notes(pt["notes"])
            if dist is not None and peak is not None and abs(peak - dist) <= 1:
                score += 4
            if score > best_score:
                best_score = score
                best_i = i
        if best_i is None:
            continue
        pt = unused.pop(best_i)
        finding["lat"] = pt["lat"]
        finding["lon"] = pt["lon"]
        meta = dict(finding.get("metadata") or {})
        meta["geo_source"] = "annotations.geojson"
        finding["metadata"] = meta
        finding["problem_id"] = assign_problem_id(finding)
    return findings


def fill_missing_coords_from_report(
    findings: List[Dict[str, Any]],
    extra_points: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Pin leftover rows to other points from the same trace (table centroid, else annotations)."""
    extra_points = extra_points or []
    by_report: Dict[str, List[Dict[str, Any]]] = {}
    for item in findings:
        by_report.setdefault(item.get("report_file") or "", []).append(item)
    extra_lat = extra_lon = None
    extra_ok = [pt for pt in extra_points if valid_lat_lon(pt.get("lat"), pt.get("lon"))]
    if extra_ok:
        extra_lat = sum(float(pt["lat"]) for pt in extra_ok) / len(extra_ok)
        extra_lon = sum(float(pt["lon"]) for pt in extra_ok) / len(extra_ok)
    for group in by_report.values():
        geocoded = [
            item
            for item in group
            if valid_lat_lon(item.get("lat"), item.get("lon"))
        ]
        source = "report_centroid"
        if geocoded:
            lat = sum(float(item["lat"]) for item in geocoded) / len(geocoded)
            lon = sum(float(item["lon"]) for item in geocoded) / len(geocoded)
        elif extra_lat is not None:
            lat, lon = extra_lat, extra_lon
            source = "annotations_centroid"
        else:
            continue
        for item in group:
            if valid_lat_lon(item.get("lat"), item.get("lon")):
                continue
            item["lat"] = lat
            item["lon"] = lon
            meta = dict(item.get("metadata") or {})
            meta["geo_source"] = source
            item["metadata"] = meta
            item["problem_id"] = assign_problem_id(item)
    return findings


def has_warning(text: str) -> bool:
    return "⚠️" in (text or "")


def contains_any(text: str, needles: Sequence[str]) -> bool:
    lowered = (text or "").lower()
    return any(n.lower() in lowered for n in needles)


def split_sections(text: str) -> "OrderedDict[str, str]":
    matches = list(SECTION_RE.finditer(text))
    sections: "OrderedDict[str, str]" = OrderedDict()
    for i, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        key = classify_section_title(title)
        if not key:
            continue
        body = text[start:end]
        if key in sections:
            sections[key] = sections[key] + "\n" + body
        else:
            sections[key] = body
    return sections


def classify_section_title(title: str) -> str:
    cleaned = title.strip()
    if re.match(r"^Metadata\b", cleaned, re.I):
        return "Metadata"
    if re.match(r"^H1\b", cleaned, re.I):
        return "H1"
    match = re.match(r"^(Q(?:_?[A-Za-z]+|\d+))\b", cleaned)
    if not match:
        return ""
    code = match.group(1)
    aliases = {
        "Qfeedback": "Q_feedback",
        "Q_Feedback": "Q_feedback",
        "QEV": "Q_EV",
        "Qlane": "Q_lane",
    }
    return aliases.get(code, code)


def parse_metadata_table(text: str) -> Dict[str, str]:
    meta = {
        "trace_file": "",
        "user_id": "",
        "session_id": "",
        "vehicle": "",
        "project": "",
        "platform": "",
        "nav_native": "",
    }
    headers, rows = first_table(text, ["field", "value"])
    if not rows:
        return meta
    field_map = {
        "file": "trace_file",
        "user id": "user_id",
        "userid": "user_id",
        "session id": "session_id",
        "vehicle": "vehicle",
        "project": "project",
        "platform": "platform",
        "nav native": "nav_native",
        "nav-native": "nav_native",
    }
    for row in rows:
        field = normalize_header(rowget(row, "field"))
        value = clean_cell(rowget(row, "value"))
        key = field_map.get(field)
        if key:
            meta[key] = "" if is_blank(value) else value
    return meta


def row_metadata(row: Dict[str, str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in row.items():
        if is_blank(value):
            continue
        out[key] = value
    return out


def assign_problem_id(finding: Dict[str, Any]) -> str:
    payload = {
        "report_file": finding.get("report_file") or "",
        "q_code": finding.get("q_code") or "",
        "problem_type": finding.get("problem_type") or "",
        "timestamp_utc": finding.get("timestamp_utc") or "",
        "summary": finding.get("summary") or "",
        "lat": finding.get("lat"),
        "lon": finding.get("lon"),
        "metadata": finding.get("metadata") or {},
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def make_finding(
    ctx: Dict[str, Any],
    q_code: str,
    problem_type: str,
    severity: str,
    summary: str,
    timestamp: str = "",
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    confidence: str = "",
    metadata: Optional[Dict[str, Any]] = None,
    informational: bool = False,
) -> Optional[Dict[str, Any]]:
    if informational and not ctx.get("include_info"):
        return None
    if severity == "info" and not ctx.get("include_info"):
        return None
    extra = dict(metadata or {})
    session_id = ctx.get("session_id") or ""
    if session_id and "session_id" not in extra:
        extra["session_id"] = session_id
    lat_v = lat if valid_lat_lon(lat, lon) else None
    lon_v = lon if valid_lat_lon(lat, lon) else None
    finding = {
        "q_code": q_code,
        "category": Q_CATEGORIES.get(q_code, q_code.lower()),
        "problem_type": problem_type,
        "severity": severity if severity in SEVERITY_RANK else "medium",
        "confidence": confidence or "",
        "trace_file": ctx.get("trace_file") or "",
        "report_file": ctx.get("report_file") or "",
        "vehicle": ctx.get("vehicle") or "",
        "user_id": ctx.get("user_id") or "",
        "project": ctx.get("project") or "",
        "platform": ctx.get("platform") or "",
        "nav_native": ctx.get("nav_native") or "",
        "timestamp_utc": to_iso_utc(timestamp) if timestamp else "",
        "lat": lat_v,
        "lon": lon_v,
        "summary": clean_cell(summary),
        "metadata": extra,
    }
    finding["problem_id"] = assign_problem_id(finding)
    return finding


def q1_severity(row_type: str, eta: str) -> str:
    lowered = (row_type or "").lower()
    if "no reroute" in lowered:
        return "medium"
    if "same route" in lowered or has_warning(eta) or "off-route" in lowered:
        return "medium"
    if has_warning(row_type):
        return "medium"
    return "low"


def parse_q1(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    recalc = re.search(
        r"Route recalculated\s+\*\*(\d+)\*\*\s+times\s+\((\d+)\s+distinct routes\)",
        body,
    )
    off_route = re.search(r"Off-route events:\s*(\d+)", body)
    shared = {
        "route_recalculated": int(recalc.group(1)) if recalc else None,
        "distinct_routes": int(recalc.group(2)) if recalc else None,
        "off_route_events": int(off_route.group(1)) if off_route else None,
    }
    shared = {k: v for k, v in shared.items() if v is not None}

    for match in re.finditer(
        r"Instability cluster:\s*(\d+)\s+changes near\s+(.+)", body
    ):
        ts = match.group(2).strip()
        meta = dict(shared)
        meta["cluster_changes"] = int(match.group(1))
        findings.append(
            make_finding(
                ctx,
                "Q1",
                "instability_cluster",
                "medium",
                f"Instability cluster: {match.group(1)} route changes near {ts}",
                timestamp=ts,
                metadata=meta,
            )
        )

    _, rows = first_table(body, ["type", "reason"])
    if not rows:
        _, rows = first_table(body, ["time (utc)", "type"])
    for row in rows:
        row_type = rowget(row, "type")
        eta = rowget(row, "eta impact")
        ts = rowget(row, "time (utc)", "time")
        reason = rowget(row, "reason")
        context = rowget(row, "context")
        loc = rowget(row, "location")
        lat, lon = coords_from_text(loc)
        ptype = "off_route" if "off-route" in row_type.lower() else "route_change"
        summary = f"Q1 {row_type}"
        if reason and not is_blank(reason):
            summary += f" ({reason})"
        if eta and not is_blank(eta):
            summary += f"; ETA impact {eta}"
        findings.append(
            make_finding(
                ctx,
                "Q1",
                ptype,
                q1_severity(row_type, eta),
                summary,
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata={**shared, **row_metadata(row), "context": context},
            )
        )

    net = re.search(
        r"Net ETA impact from all route changes:\s*([^\n*]+)", body
    )
    if net:
        impact = clean_cell(net.group(1))
        flagged = has_warning(impact)
        findings.append(
            make_finding(
                ctx,
                "Q1",
                "net_eta_impact",
                "medium" if flagged else "info",
                f"Net ETA impact from all route changes: {impact}",
                informational=not flagged,
                metadata={**shared, "net_eta_impact": impact},
            )
        )
    return [f for f in findings if f]


def parse_remaining_km(body: str) -> Optional[float]:
    match = re.search(
        r"Remaining distance at trace end:\s*([\d.]+)\s*km", body, re.I
    )
    if not match:
        return None
    return float(match.group(1))


def parse_q2(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    completed_match = re.search(
        r"\*\*Route completed:\s*([^*]+)\*\*", body
    )
    completed_raw = clean_cell(completed_match.group(1)) if completed_match else ""
    completed_yes = "YES" in completed_raw.upper() and "❌" not in completed_raw
    canceled = "canceled" in completed_raw.lower()
    remaining_km = parse_remaining_km(body)
    drive_end = ""
    end_match = re.search(r"Drive end:\s*(.+)", body)
    if end_match:
        drive_end = clean_cell(end_match.group(1))
    drive_start = ""
    start_match = re.search(r"Drive start:\s*(.+)", body)
    if start_match:
        drive_start = clean_cell(start_match.group(1))
    shared = {
        "route_completed": completed_raw,
        "remaining_km": remaining_km,
        "drive_start": drive_start,
        "drive_end": drive_end,
    }

    poor = re.search(r"Driver stopped\s+(.+?)\s+from destination", body)
    if poor:
        dist = clean_cell(poor.group(1))
        findings.append(
            make_finding(
                ctx,
                "Q2",
                "poor_arrival",
                "medium",
                f"Driver stopped {dist} from destination",
                timestamp=drive_end,
                metadata={**shared, "distance_from_destination": dist},
            )
        )

    eta_match = re.search(r"ETA delta[^:]*:\s*([^\n]+)", body)
    if eta_match and (has_warning(eta_match.group(1)) or contains_any(
        eta_match.group(1), ["too optimistic", "too pessimistic"]
    )):
        eta_text = clean_cell(eta_match.group(1))
        kind = "optimistic" if "optimistic" in eta_text.lower() else (
            "pessimistic" if "pessimistic" in eta_text.lower() else "eta_error"
        )
        findings.append(
            make_finding(
                ctx,
                "Q2",
                "eta_error",
                "medium",
                f"ETA error ({kind}): {eta_text}",
                timestamp=drive_end,
                metadata={**shared, "eta_delta": eta_text, "eta_kind": kind},
            )
        )

    if completed_yes:
        findings.append(
            make_finding(
                ctx,
                "Q2",
                "route_completed",
                "info",
                f"Route completed: {completed_raw or 'YES'}",
                timestamp=drive_end,
                informational=True,
                metadata=shared,
            )
        )
    else:
        remaining_actionable = remaining_km is not None and remaining_km > 0.05
        actionable = canceled or remaining_actionable or bool(poor)
        summary = f"Route not completed: {completed_raw or 'NO'}"
        if remaining_km is not None:
            summary += f" (remaining {remaining_km:.1f} km)"
        findings.append(
            make_finding(
                ctx,
                "Q2",
                "incomplete_route",
                "medium" if (canceled or remaining_actionable) else "low",
                summary,
                timestamp=drive_end,
                informational=not actionable,
                metadata={**shared, "canceled": canceled},
            )
        )
    return [f for f in findings if f]


def q3_signal_severity(signal: str) -> str:
    lowered = (signal or "").lower()
    if "stopped" in lowered:
        return "low"
    if "over-pred" in lowered or "fn-risk" in lowered:
        return "medium"
    if has_warning(signal):
        return "medium"
    return "low"


def parse_q3(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    _, slow_rows = first_table(body, ["start (utc)", "duration"])
    for row in slow_rows:
        ts = rowget(row, "start (utc)")
        duration = rowget(row, "duration")
        findings.append(
            make_finding(
                ctx,
                "Q3",
                "slowdown",
                "info",
                f"Slowdown at {ts or 'unknown time'} lasting {duration or 'unknown'}",
                timestamp=ts,
                informational=True,
                metadata=row_metadata(row),
            )
        )

    _, rows = first_table(
        body,
        ["signal", "worst moment (utc)", "location (lon,lat)"],
    )
    if not rows:
        _, rows = first_table(body, ["signal", "worst moment (utc)"])
    for row in rows:
        signal = rowget(row, "signal")
        ts = rowget(row, "worst moment (utc)")
        loc = rowget(row, "location (lon,lat)", "location")
        lat, lon = parse_q3_location(loc)
        duration = rowget(row, "duration")
        summary = f"Actionable congestion: {signal or 'signal'}"
        if duration:
            summary += f" ({duration})"
        findings.append(
            make_finding(
                ctx,
                "Q3",
                "congestion_signal",
                q3_signal_severity(signal),
                summary,
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata=row_metadata(row),
            )
        )
    return [f for f in findings if f]


def parse_bold_count(body: str, label: str) -> Optional[int]:
    pattern = re.compile(
        rf"\*\*{re.escape(label)}:\s*(?:⚠️\s*)?(\d+)",
        re.I,
    )
    match = pattern.search(body)
    if not match:
        return None
    return int(match.group(1))


def q4_div_severity(dist_m: Optional[float]) -> str:
    # GPS mismatch is a positioning symptom, not a map-data defect.
    if dist_m is None:
        return "low"
    if dist_m >= 15:
        return "medium"
    return "low"


def parse_q4(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    total = None
    total_match = re.search(
        r"Total divergence episodes[^:]*:\s*(\d+)", body
    )
    if total_match:
        total = int(total_match.group(1))

    _, rows = first_table(body, ["time (utc)", "worst dist"])
    for row in rows:
        ts = rowget(row, "time (utc)")
        dist_raw = rowget(row, "worst dist")
        dist_m = parse_float(dist_raw)
        duration = rowget(row, "duration")
        lat, lon = coords_from_text(rowget(row, "location"))
        summary = f"GPS / map-matched divergence {dist_raw or 'unknown'}"
        if duration and not is_blank(duration):
            summary += f" lasting {duration}"
        meta = row_metadata(row)
        if total is not None:
            meta["total_divergence_episodes"] = total
        findings.append(
            make_finding(
                ctx,
                "Q4",
                "gps_divergence",
                q4_div_severity(dist_m),
                summary,
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata=meta,
            )
        )

    fallback = parse_bold_count(body, "Navigator fallback to raw GPS")
    if fallback:
        findings.append(
            make_finding(
                ctx,
                "Q4",
                "navigator_fallback",
                "medium",
                f"Navigator fallback to raw GPS: {fallback}",
                metadata={"fallback_count": fallback},
            )
        )
    elif fallback == 0 and ctx.get("include_info"):
        findings.append(
            make_finding(
                ctx,
                "Q4",
                "navigator_fallback",
                "info",
                "Navigator fallback to raw GPS: 0",
                informational=True,
                metadata={"fallback_count": 0},
            )
        )

    teleports = parse_bold_count(body, "Map-matcher teleports")
    if teleports:
        findings.append(
            make_finding(
                ctx,
                "Q4",
                "map_matcher_teleport",
                "medium",
                f"Map-matcher teleports: {teleports}",
                metadata={"teleport_count": teleports},
            )
        )
    return [f for f in findings if f]


def parse_q5(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "No search activity found" in body and not ctx.get("include_info"):
        return []
    findings: List[Dict[str, Any]] = []
    _, attempt_rows = first_table(body, ["query", "results"])
    for row in attempt_rows:
        results = rowget(row, "results")
        selected = rowget(row, "selected")
        query = rowget(row, "query")
        ts = rowget(row, "time (utc)")
        flagged = has_warning(results) or contains_any(results, ["⚠️"])
        selected_hit = not is_blank(selected)
        informational = not flagged and not selected_hit
        summary = f"Search attempt {query or '(no query)'} → {results or 'n/a'} results"
        if selected_hit:
            summary += f"; selected {selected}"
        extra = row_metadata(row)
        extra["query"] = query or extra.get("query") or ""
        extra["results"] = results or extra.get("results") or ""
        extra["selected"] = selected if selected else "—"
        findings.append(
            make_finding(
                ctx,
                "Q5",
                "search_attempt",
                "medium" if flagged else ("low" if selected_hit else "info"),
                summary,
                timestamp=ts,
                informational=informational,
                metadata=extra,
            )
        )

    _, sel_rows = first_table(body, ["name", "dist to trip end"])
    for row in sel_rows:
        dist = rowget(row, "dist to trip end")
        name = rowget(row, "name")
        flagged = has_warning(dist)
        findings.append(
            make_finding(
                ctx,
                "Q5",
                "search_selection",
                "medium" if flagged else "info",
                f"Selected destination {name or 'unknown'} ({dist or 'distance n/a'})",
                informational=not flagged,
                metadata=row_metadata(row),
            )
        )
    return [f for f in findings if f]


def parse_q_feedback(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "No feedback events found" in body:
        return []
    findings: List[Dict[str, Any]] = []
    _, rows = first_table(body, ["type", "description"])
    if not rows:
        _, rows = first_table(body, ["time (utc)", "type"])
    for row in rows:
        ts = rowget(row, "time (utc)")
        ftype = rowget(row, "type")
        desc = rowget(row, "description")
        lat = parse_float(rowget(row, "lat"))
        lon = parse_float(rowget(row, "lon"))
        summary = f"User feedback ({ftype or 'unknown'})"
        if desc and not is_blank(desc):
            summary += f": {desc}"
        findings.append(
            make_finding(
                ctx,
                "Q_feedback",
                "user_feedback",
                "medium",
                summary,
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata=row_metadata(row),
            )
        )
    return [f for f in findings if f]


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def tunnel_anchors_from_body(body: str) -> List[Tuple[float, float]]:
    """Every tunnel portal in the Q7 table, including clean sections that are not findings."""
    if not body or "No tunnel sections detected" in body:
        return []
    _, rows = first_table(body, ["degraded?", "start (utc)"])
    if not rows:
        _, rows = first_table(body, ["start (utc)", "duration"])
    anchors: List[Tuple[float, float]] = []
    for row in rows:
        lat, lon = coords_from_text(rowget(row, "location"))
        if valid_lat_lon(lat, lon):
            anchors.append((float(lat), float(lon)))
    return anchors


def drop_divergence_near_tunnels(
    findings: Sequence[Dict[str, Any]],
    anchors: Sequence[Tuple[float, float]],
) -> List[Dict[str, Any]]:
    """Drop GPS divergence only against tunnel portals from the same trace."""
    if not anchors:
        return list(findings)
    kept: List[Dict[str, Any]] = []
    for item in findings:
        if item.get("problem_type") != "gps_divergence":
            kept.append(item)
            continue
        lat, lon = item.get("lat"), item.get("lon")
        if not valid_lat_lon(lat, lon):
            kept.append(item)
            continue
        if any(
            haversine_m(float(lat), float(lon), tlat, tlon) <= TUNNEL_DIV_M
            for tlat, tlon in anchors
        ):
            continue
        kept.append(item)
    return kept


def parse_q7(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "No tunnel sections detected" in body:
        return []
    findings: List[Dict[str, Any]] = []
    _, rows = first_table(body, ["degraded?", "start (utc)"])
    if not rows:
        _, rows = first_table(body, ["start (utc)", "duration"])
    for row in rows:
        degraded_raw = rowget(row, "degraded?")
        degraded = has_warning(degraded_raw) or bool(
            re.search(r"\byes\b", degraded_raw, re.I)
        )
        ts = rowget(row, "start (utc)")
        worst_at = rowget(row, "worst at (utc)")
        div = rowget(row, "worst divergence")
        duration = rowget(row, "duration")
        lat, lon = coords_from_text(rowget(row, "location"))
        if degraded:
            summary = f"Degraded tunnel positioning ({duration or 'duration n/a'})"
            if div and not is_blank(div):
                summary += f"; worst divergence {div}"
            findings.append(
                make_finding(
                    ctx,
                    "Q7",
                    "tunnel_degraded",
                    "medium",
                    summary,
                    timestamp=worst_at or ts,
                    lat=lat,
                    lon=lon,
                    metadata=row_metadata(row),
                )
            )
        else:
            summary = f"Clean tunnel section ({duration or 'duration n/a'})"
            findings.append(
                make_finding(
                    ctx,
                    "Q7",
                    "tunnel_section",
                    "info",
                    summary,
                    timestamp=ts,
                    lat=lat,
                    lon=lon,
                    informational=True,
                    metadata=row_metadata(row),
                )
            )
    return [f for f in findings if f]


def q10_incident_severity(row: Dict[str, str]) -> str:
    # Incidents, lane restrictions, and closures are map data.
    return "high"


def parse_q10(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    _, inc_rows = first_table(
        body, ["first seen (utc)", "type", "driver passed?"]
    )
    if not inc_rows:
        _, inc_rows = first_table(body, ["type", "location"])
    for row in inc_rows:
        ts = rowget(row, "first seen (utc)")
        itype = rowget(row, "type") or "incident"
        road = rowget(row, "road")
        loc = rowget(row, "location")
        lat, lon = parse_arrow_location(loc)
        passed = rowget(row, "driver passed?")
        deviation = rowget(row, "deviation?")
        summary = f"Route incident: {itype}"
        if road and not is_blank(road):
            summary += f" on {road}"
        if passed and not is_blank(passed):
            summary += f" (passed: {passed})"
        if deviation and not is_blank(deviation) and deviation not in {"✅ None"}:
            summary += f"; {deviation}"
        findings.append(
            make_finding(
                ctx,
                "Q10",
                "route_incident",
                q10_incident_severity(row),
                summary,
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata=row_metadata(row),
            )
        )

    for match in re.finditer(
        r"Non-routable incident traversed[^\n]*", body
    ):
        findings.append(
            make_finding(
                ctx,
                "Q10",
                "non_routable_incident",
                "high",
                clean_cell(match.group(0)),
                metadata={"note": clean_cell(match.group(0))},
            )
        )

    _, cl_rows = first_table(
        body, ["route set (utc)", "driver traversed?"]
    )
    if not cl_rows:
        _, cl_rows = first_table(body, ["geometry indices", "location"])
    for row in cl_rows:
        ts = rowget(row, "route set (utc)")
        loc = rowget(row, "location")
        lat, lon = parse_arrow_location(loc)
        traversed = rowget(row, "driver traversed?")
        note = rowget(row, "note")
        summary = "Route planned through closed road segment"
        if traversed:
            summary += f" (traversed: {traversed})"
        if note and not is_blank(note):
            summary += f"; {note}"
        findings.append(
            make_finding(
                ctx,
                "Q10",
                "road_closure",
                "high",
                summary,
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata=row_metadata(row),
            )
        )
    return [f for f in findings if f]


def parse_q_ev(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "No EV data detected" in body:
        return []
    findings: List[Dict[str, Any]] = []
    _, cs_rows = first_table(body, ["cs", "actual soc"])
    for row in cs_rows:
        actual = rowget(row, "actual soc")
        name = rowget(row, "cs")
        flagged = has_warning(actual)
        findings.append(
            make_finding(
                ctx,
                "Q_EV",
                "charging_soc_mismatch",
                "medium" if flagged else "info",
                f"CS SOC comparison for {name or 'waypoint'}: {actual or 'n/a'}",
                informational=not flagged,
                metadata=row_metadata(row),
            )
        )

    mean = re.search(r"Mean prediction error:\s*([^\n]+)", body)
    if mean:
        text = clean_cell(mean.group(1))
        flagged = has_warning(mean.group(0))
        findings.append(
            make_finding(
                ctx,
                "Q_EV",
                "soc_prediction_error",
                "medium" if flagged else "info",
                f"Mean SOC prediction error: {text}",
                informational=not flagged,
                metadata={"mean_prediction_error": text},
            )
        )

    arrival = re.search(r"Arrival prediction error[^\n]*", body)
    if arrival and "N/A" not in arrival.group(0):
        text = clean_cell(arrival.group(0))
        flagged = has_warning(text)
        findings.append(
            make_finding(
                ctx,
                "Q_EV",
                "soc_arrival_error",
                "medium" if flagged else "info",
                text,
                informational=not flagged,
                metadata={"arrival_prediction_error": text},
            )
        )
    return [f for f in findings if f]


def rico_confidence(outcome: str, b3: str) -> str:
    blob = f"{outcome} {b3}".lower()
    if "likely impactful" in blob:
        return "high"
    if "ambiguous" in blob:
        return "low"
    if "survived" in blob:
        return "medium"
    return ""


def rico_severity(outcome: str) -> str:
    lowered = (outcome or "").lower()
    if "likely impactful" in lowered:
        return "high"
    if "context-only" in lowered:
        return "info"
    if "survived" in lowered:
        return "low"
    return "medium"


def parse_q_lane(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    matches = list(RICO_HEADING_RE.finditer(body))
    for i, match in enumerate(matches):
        bucket = match.group(1).strip()
        bucket_name = match.group(2).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        section = body[start:end]
        tables = all_tables(section, ["detector", "outcome", "step"])
        if not tables:
            tables = all_tables(section, ["time (utc)", "detector", "location"])
        for _, rows in tables:
            for row in rows:
                ts = rowget(row, "time (utc)")
                loc = rowget(row, "location")
                lat, lon = coords_from_text(loc)
                if not valid_lat_lon(lat, lon):
                    lat, lon = parse_lat_lon_pair(loc, order="latlon")
                detector = rowget(row, "detector")
                outcome = rowget(row, "outcome")
                detail = rowget(row, "detail")
                maneuver = rowget(row, "maneuver")
                summary = f"{bucket} ({bucket_name})"
                if detector:
                    summary += f" detector {detector}"
                if maneuver and not is_blank(maneuver):
                    summary += f" @ {maneuver}"
                if detail and not is_blank(detail):
                    summary += f": {detail}"
                sev = rico_severity(outcome)
                if sev != "info":
                    sev = "high"
                findings.append(
                    make_finding(
                        ctx,
                        "Q_lane",
                        bucket,
                        sev,
                        summary,
                        timestamp=ts,
                        lat=lat,
                        lon=lon,
                        confidence=rico_confidence(outcome, rowget(row, "b3 lane")),
                        informational=sev == "info",
                        metadata={
                            **row_metadata(row),
                            "rico_bucket": bucket,
                            "rico_name": bucket_name,
                        },
                    )
                )
    return [f for f in findings if f]


def parse_h1(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "no on-road HD-lane gaps detected" in body or "section skipped" in body:
        return []
    findings: List[Dict[str, Any]] = []
    _, rows = first_table(body, ["location (start → end)", "type"])
    if not rows:
        _, rows = first_table(body, ["time (utc)", "distance", "type"])
    for row in rows:
        type_cell = rowget(row, "type")
        genuine = "genuine" in type_cell.lower()
        ts = rowget(row, "time (utc)")
        loc = rowget(row, "location (start → end)", "location")
        lat, lon = parse_arrow_location(loc)
        dist = rowget(row, "distance")
        maneuver = rowget(row, "maneuver?")
        outcome = rowget(row, "outcome")
        summary = f"Missing HD lanes ({type_cell or 'section'})"
        if dist:
            summary += f", {dist}"
        if maneuver and not is_blank(maneuver):
            summary += f"; maneuver {maneuver}"
        sev = "high" if genuine else "info"
        findings.append(
            make_finding(
                ctx,
                "H1",
                "missing_hd_lanes",
                sev,
                summary,
                timestamp=ts,
                lat=lat,
                lon=lon,
                informational=not genuine,
                metadata={**row_metadata(row), "hd_gap_type": type_cell},
            )
        )
    return [f for f in findings if f]


def parse_q_oneway(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "check skipped" in body or "No sustained drive against" in body:
        return []
    _, rows = first_table(body, ["time (utc)", "gps bearing"])
    findings: List[Dict[str, Any]] = []
    for row in rows:
        ts = rowget(row, "time (utc)")
        lat, lon = coords_from_text(rowget(row, "location"))
        gps_b = rowget(row, "gps bearing")
        legal_b = rowget(row, "legal bearing")
        dist = rowget(row, "distance")
        way = rowget(row, "osm way")
        findings.append(
            make_finding(
                ctx,
                "Q_oneway",
                "oneway_against",
                "high",
                f"Against OSM one-way: GPS {gps_b} vs legal {legal_b} for {dist}",
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata={
                    "gps_bearing": gps_b,
                    "legal_bearing": legal_b,
                    "distance": dist,
                    "osm_way": way,
                },
            )
        )
    return [f for f in findings if f]


def parse_q_map(body: str, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "No extra map-data signals" in body:
        return []
    _, rows = first_table(body, ["time (utc)", "type", "what to look at"])
    findings: List[Dict[str, Any]] = []
    for row in rows:
        kind = rowget(row, "type")
        if not kind:
            continue
        ts = rowget(row, "time (utc)")
        lat, lon = coords_from_text(rowget(row, "location"))
        look = rowget(row, "what to look at")
        findings.append(
            make_finding(
                ctx,
                "Q_map",
                kind,
                "high",
                look or kind,
                timestamp=ts,
                lat=lat,
                lon=lon,
                metadata={"signal": kind},
            )
        )
    return [f for f in findings if f]


SECTION_PARSERS: List[Tuple[str, Callable[[str, Dict[str, Any]], List[Dict[str, Any]]]]] = [
    ("Q1", parse_q1),
    ("Q2", parse_q2),
    ("Q3", parse_q3),
    ("Q4", parse_q4),
    ("Q5", parse_q5),
    ("Q_feedback", parse_q_feedback),
    ("Q7", parse_q7),
    ("Q10", parse_q10),
    ("Q_EV", parse_q_ev),
    ("Q_lane", parse_q_lane),
    ("Q_oneway", parse_q_oneway),
    ("Q_map", parse_q_map),
    ("H1", parse_h1),
]


def find_report_files(input_dir: Path) -> List[Path]:
    files = [
        path
        for path in input_dir.rglob("*-analysis.md")
        if path.is_file()
    ]
    return sorted(files)


def parse_report(
    path: Path,
    input_dir: Path,
    include_info: bool,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]], List[Tuple[float, float]]]:
    errors: List[Dict[str, str]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        return [], [{"file": str(path), "error": f"read failed: {exc}"}], []

    try:
        rel = str(path.relative_to(input_dir))
    except ValueError:
        rel = path.name

    sections = split_sections(text)
    metadata_body = sections.get("Metadata", "")
    meta = parse_metadata_table(metadata_body or text)
    if not metadata_body or not any(meta.get(k) for k in ("trace_file", "user_id", "vehicle")):
        errors.append(
            {
                "file": rel,
                "error": "missing or incomplete Metadata table",
            }
        )

    ctx = {
        **meta,
        "report_file": rel,
        "include_info": include_info,
    }
    findings: List[Dict[str, Any]] = []
    for q_code, parser in SECTION_PARSERS:
        body = sections.get(q_code)
        if not body:
            continue
        try:
            findings.extend(parser(body, ctx))
        except Exception as exc:
            errors.append(
                {
                    "file": rel,
                    "section": q_code,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    findings = [attach_coords_from_row_fields(item) for item in findings]
    points = load_annotation_points(path)
    findings = enrich_from_annotations(findings, points)
    findings = fill_missing_coords_from_report(findings, points)
    findings = attach_divergence_lines(findings, load_divergence_lines(path))
    anchors = tunnel_anchors_from_body(sections.get("Q7") or "")
    findings = drop_divergence_near_tunnels(findings, anchors)
    return findings, errors, anchors


def sort_findings(findings: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    order = {code: i for i, code in enumerate(Q_ORDER)}

    def key(item: Dict[str, Any]) -> Tuple:
        return (
            order.get(item.get("q_code") or "", 99),
            item.get("report_file") or "",
            item.get("timestamp_utc") or "",
            item.get("problem_type") or "",
            item.get("summary") or "",
        )

    return sorted(findings, key=key)


def count_by(findings: Sequence[Dict[str, Any]], field: str) -> Dict[str, int]:
    counter: Counter[str] = Counter()
    for item in findings:
        counter[str(item.get(field) or "")] += 1
    if field == "q_code":
        ordered = OrderedDict()
        for code in Q_ORDER:
            if code in counter:
                ordered[code] = counter[code]
        for code, n in sorted(counter.items()):
            if code not in ordered:
                ordered[code] = n
        return dict(ordered)
    if field == "severity":
        ordered = OrderedDict()
        for sev in ("high", "medium", "low", "info"):
            if sev in counter:
                ordered[sev] = counter[sev]
        return dict(ordered)
    return dict(sorted(counter.items(), key=lambda kv: (-kv[1], kv[0])))


def write_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def write_csv(path: Path, findings: Sequence[Dict[str, Any]]) -> None:
    fieldnames = list(COMMON_FIELDS) + ["metadata_json"]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for item in findings:
            row = {}
            for field in COMMON_FIELDS:
                value = item.get(field)
                if value is None:
                    row[field] = ""
                else:
                    row[field] = value
            row["metadata_json"] = json.dumps(
                item.get("metadata") or {},
                ensure_ascii=False,
                sort_keys=True,
                default=str,
            )
            writer.writerow(row)


def finding_to_feature(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    lat = item.get("lat")
    lon = item.get("lon")
    if not valid_lat_lon(lat, lon):
        return None
    props = {field: item.get(field) for field in COMMON_FIELDS}
    props["metadata"] = item.get("metadata") or {}
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [float(lon), float(lat)],
        },
        "properties": props,
    }


def write_geojson(path: Path, findings: Sequence[Dict[str, Any]]) -> int:
    features = []
    for item in findings:
        feat = finding_to_feature(item)
        if feat:
            features.append(feat)
    write_json(
        path,
        {"type": "FeatureCollection", "features": features},
    )
    return len(features)


def format_count_table(title: str, counts: Dict[str, int]) -> List[str]:
    lines = [f"### {title}", "", "| Key | Count |", "|-----|-------|"]
    if not counts:
        lines.append("| _(none)_ | 0 |")
    else:
        for key, value in counts.items():
            lines.append(f"| `{key}` | {value} |")
    lines.append("")
    return lines


def useful_metadata(item: Dict[str, Any]) -> Dict[str, Any]:
    skip = {
        "session_id",
    }
    useful = {}
    for key, value in (item.get("metadata") or {}).items():
        if key in skip or value in (None, "", [], {}):
            continue
        useful[key] = value
    return useful


def write_markdown_report(
    path: Path,
    summary: Dict[str, Any],
    findings: Sequence[Dict[str, Any]],
) -> None:
    lines = [
        "# Trace Problem Registry",
        "",
        "## Run metadata",
        "",
        f"- Started: `{summary.get('started_at')}`",
        f"- Finished: `{summary.get('finished_at')}`",
        f"- Input dir: `{summary.get('input_dir')}`",
        f"- Output dir: `{summary.get('output_dir')}`",
        f"- Include informational rows: `{summary.get('include_info')}`",
        f"- Files scanned: **{summary.get('files_scanned', 0)}**",
        f"- Files parsed: **{summary.get('files_parsed', 0)}**",
        f"- Files with errors: **{summary.get('files_with_errors', 0)}**",
        f"- Findings: **{summary.get('findings_count', 0)}**",
        f"- GeoJSON features: **{summary.get('geojson_features', 0)}**",
        "",
        "## Unsupported questions",
        "",
        UNSUPPORTED_Q_NOTE,
        "",
        "## Counts",
        "",
    ]
    lines.extend(format_count_table("By Q", summary.get("counts_by_q") or {}))
    lines.extend(format_count_table("By severity", summary.get("counts_by_severity") or {}))
    lines.extend(format_count_table("By category", summary.get("counts_by_category") or {}))

    errors = summary.get("parse_errors") or []
    if errors:
        lines.extend(["## Parse errors", ""])
        for err in errors:
            loc = err.get("file") or ""
            section = err.get("section")
            prefix = f"`{loc}`" + (f" / `{section}`" if section else "")
            lines.append(f"- {prefix}: {err.get('error')}")
        lines.append("")

    lines.extend(["## Findings", ""])
    grouped: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict(
        (code, []) for code in Q_ORDER
    )
    extras: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
    for item in findings:
        code = item.get("q_code") or "unknown"
        if code in grouped:
            grouped[code].append(item)
        else:
            extras.setdefault(code, []).append(item)

    any_finding = False
    for code, items in list(grouped.items()) + list(extras.items()):
        if not items:
            continue
        any_finding = True
        title = Q_TITLES.get(code, code)
        lines.append(f"### {title}")
        lines.append("")
        lines.append(f"_{len(items)} finding(s)_")
        lines.append("")
        for item in items:
            lines.append(f"#### {item.get('summary') or item.get('problem_id')}")
            lines.append("")
            lines.append(f"- problem_id: `{item.get('problem_id')}`")
            lines.append(
                f"- type / severity: `{item.get('problem_type')}` / **{item.get('severity')}**"
            )
            if item.get("confidence"):
                lines.append(f"- confidence: `{item.get('confidence')}`")
            lines.append(f"- trace: `{item.get('trace_file') or 'n/a'}`")
            lines.append(f"- report: `{item.get('report_file') or 'n/a'}`")
            if item.get("timestamp_utc"):
                lines.append(f"- timestamp: `{item.get('timestamp_utc')}`")
            if valid_lat_lon(item.get("lat"), item.get("lon")):
                lines.append(f"- coords: `{item.get('lat')}, {item.get('lon')}`")
            ident = [
                f"vehicle `{item.get('vehicle')}`" if item.get("vehicle") else "",
                f"user `{item.get('user_id')}`" if item.get("user_id") else "",
                f"project `{item.get('project')}`" if item.get("project") else "",
                f"platform `{item.get('platform')}`" if item.get("platform") else "",
                f"nav-native `{item.get('nav_native')}`" if item.get("nav_native") else "",
            ]
            ident = [part for part in ident if part]
            if ident:
                lines.append(f"- identity: {'; '.join(ident)}")
            meta = useful_metadata(item)
            if meta:
                pretty = json.dumps(meta, ensure_ascii=False, sort_keys=True, default=str)
                lines.append(f"- metadata: `{pretty}`")
            lines.append("")
    if not any_finding:
        lines.append("_No findings._")
        lines.append("")

    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def build_summary(
    *,
    started_at: str,
    finished_at: str,
    input_dir: Path,
    output_dir: Path,
    include_info: bool,
    files_scanned: int,
    files_parsed: int,
    findings: Sequence[Dict[str, Any]],
    parse_errors: Sequence[Dict[str, str]],
    geojson_features: int,
) -> Dict[str, Any]:
    error_files = {err.get("file") for err in parse_errors if err.get("file")}
    return {
        "started_at": started_at,
        "finished_at": finished_at,
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "include_info": include_info,
        "files_scanned": files_scanned,
        "files_parsed": files_parsed,
        "files_with_errors": len(error_files),
        "findings_count": len(findings),
        "geojson_features": geojson_features,
        "counts_by_q": count_by(findings, "q_code"),
        "counts_by_severity": count_by(findings, "severity"),
        "counts_by_category": count_by(findings, "category"),
        "parse_errors": list(parse_errors),
        "unsupported_q_codes": list(UNSUPPORTED_Q_CODES),
        "unsupported_q_note": UNSUPPORTED_Q_NOTE,
        "outputs": {
            "problems_report": "problems-report.md",
            "problems_csv": "problems.csv",
            "problems_json": "problems.json",
            "problems_geojson": "problems.geojson",
            "run_summary": "run-summary.json",
        },
    }


def run(
    input_dir: Path,
    output_dir: Path,
    include_info: bool = False,
) -> Dict[str, Any]:
    started_at = utc_now_iso()
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    if not input_dir.is_dir():
        raise FileNotFoundError(f"input dir not found: {input_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    reports = find_report_files(input_dir)
    all_findings: List[Dict[str, Any]] = []
    parse_errors: List[Dict[str, str]] = []
    files_parsed = 0
    for report in reports:
        findings, errors, _anchors = parse_report(report, input_dir, include_info)
        parse_errors.extend(errors)
        all_findings.extend(findings)
        files_parsed += 1

    all_findings = sort_findings(all_findings)
    write_csv(output_dir / "problems.csv", all_findings)
    write_json(output_dir / "problems.json", all_findings)
    geo_count = write_geojson(output_dir / "problems.geojson", all_findings)
    finished_at = utc_now_iso()
    summary = build_summary(
        started_at=started_at,
        finished_at=finished_at,
        input_dir=input_dir,
        output_dir=output_dir,
        include_info=include_info,
        files_scanned=len(reports),
        files_parsed=files_parsed,
        findings=all_findings,
        parse_errors=parse_errors,
        geojson_features=geo_count,
    )
    write_json(output_dir / "run-summary.json", summary)
    write_markdown_report(output_dir / "problems-report.md", summary, all_findings)
    return summary


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a local problem registry from Mapbox Co-pilot "
            "*-analysis.md reports. Does not decode PBF traces."
        )
    )
    parser.add_argument(
        "--input-dir",
        required=True,
        help="Directory to scan recursively for *-analysis.md. For the explorer, use input-traces/real only (skip simulated/short/stationary).",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory to write problems-report.md, CSV/JSON/GeoJSON, and run-summary.json.",
    )
    parser.add_argument(
        "--include-info",
        action="store_true",
        help="Include informational rows (clean tunnels, slowdowns, completed routes, etc.).",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    try:
        summary = run(
            Path(args.input_dir),
            Path(args.output_dir),
            include_info=args.include_info,
        )
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(
        "Wrote {count} findings from {scanned} reports to {out}".format(
            count=summary.get("findings_count", 0),
            scanned=summary.get("files_scanned", 0),
            out=summary.get("output_dir"),
        )
    )
    if summary.get("parse_errors"):
        print(
            f"Parse errors: {len(summary['parse_errors'])} (see run-summary.json)",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
