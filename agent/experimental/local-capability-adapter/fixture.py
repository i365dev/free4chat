#!/usr/bin/env python3
"""Deterministic localhost fixture for the external Adapter spike."""

import argparse
import http.server
import json


class Fixture(http.server.BaseHTTPRequestHandler):
    state = {"ready": True, "on": False, "brightness": 42}

    def log_message(self, *_args):
        pass

    def reply(self, value, status=200):
        data = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/state":
            return self.reply(self.state)
        return self.reply({"error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/actions/set-led":
            return self.reply({"error": "not found"}, 404)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        Fixture.state = {**Fixture.state, "on": True, "color": body["color"]}
        return self.reply({"ok": True, "color": body["color"]})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=43127)
    args = parser.parse_args()
    server = http.server.HTTPServer((args.host, args.port), Fixture)
    print("fixture listening at http://%s:%d" % (args.host, args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
