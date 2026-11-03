"""Local server for the viewer.

Like `python -m http.server`, but tells the browser to re-check files on every
load (so code changes show up on a normal refresh) and only listens on this
computer, not the whole network.
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


os.chdir(os.path.dirname(os.path.abspath(__file__)))
try:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler)
except OSError:
    print(f"Port {PORT} is already in use - the viewer is probably already running.")
    sys.exit(1)
print(f"Serving the splat viewer at http://localhost:{PORT} (close this window to stop)")
server.serve_forever()
