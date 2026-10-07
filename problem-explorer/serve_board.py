#!/usr/bin/env python3
"""Serve Trace Board and a shared review file.

Tags live in data/reviews.json. The first tag on a finding is kept.
A later tag from anyone else is rejected.
"""
import json
import os
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
REVIEWS = os.path.join(ROOT, "data", "reviews.json")
TAGS = {"true_detection", "false_positive", "na"}
LOCK = threading.Lock()


def load_reviews():
    if not os.path.exists(REVIEWS):
        return {}
    with open(REVIEWS, encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict) and isinstance(data.get("reviews"), dict):
        return data["reviews"]
    return {}


def save_reviews(reviews):
    os.makedirs(os.path.dirname(REVIEWS), exist_ok=True)
    tmp = REVIEWS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"reviews": reviews}, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, REVIEWS)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/api/reviews":
            with LOCK:
                reviews = load_reviews()
            self._json(200, {"reviews": reviews})
            return
        super().do_GET()

    def do_DELETE(self):
        if urlparse(self.path).path != "/api/reviews":
            self.send_error(404, "File not found")
            return
        try:
            payload = self._read_json()
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "error": "bad_json"})
            return
        problem_id = str(payload.get("problem_id") or "").strip()
        if not problem_id:
            self._json(400, {"ok": False, "error": "bad_request"})
            return
        with LOCK:
            reviews = load_reviews()
            if problem_id not in reviews:
                self._json(404, {"ok": False, "error": "not_tagged"})
                return
            reviews.pop(problem_id, None)
            save_reviews(reviews)
        self._json(200, {"ok": True})

    def do_POST(self):
        if urlparse(self.path).path != "/api/reviews":
            self.send_error(404, "File not found")
            return
        try:
            payload = self._read_json()
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "error": "bad_json"})
            return
        problem_id = str(payload.get("problem_id") or "").strip()
        tag = str(payload.get("tag") or "").strip()
        reviewer = str(payload.get("reviewer") or "").strip()[:80]
        if not problem_id or tag not in TAGS or not reviewer:
            self._json(400, {"ok": False, "error": "bad_request"})
            return
        with LOCK:
            reviews = load_reviews()
            existing = reviews.get(problem_id)
            if existing and existing.get("tag"):
                self._json(409, {"ok": False, "error": "already_tagged", "review": existing})
                return
            review = {
                "tag": tag,
                "reviewer": reviewer,
                "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            reviews[problem_id] = review
            save_reviews(reviews)
        self._json(200, {"ok": True, "review": review})

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode() or "{}")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("Trace Board http://127.0.0.1:%s/" % port, flush=True)
    server.serve_forever()
