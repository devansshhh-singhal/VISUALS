"""Serve the static app for development without exposing Git or device credentials."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_FILES = {
    "index.html", "activity-log.js", "sw.js", "manifest.webmanifest", "apple-touch-icon.png",
    "icon-192.png", "icon-512.png", "icon-maskable-512.png",
}


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        path = unquote(urlsplit(self.path).path).lstrip("/") or "index.html"
        if path not in PUBLIC_FILES:
            self.send_error(404, "File not found")
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()
    with ThreadingHTTPServer((args.host, args.port), AppHandler) as server:
        print(f"My Visuals available on port {args.port}", flush=True)
        server.serve_forever()
