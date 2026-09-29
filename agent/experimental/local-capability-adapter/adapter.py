#!/usr/bin/env python3
"""Experimental stdio Adapter; standard library only, no Free4Chat imports."""

import argparse
import json
import re
import sys
import urllib.error
import urllib.request

PROTOCOL_VERSION = 1
MAX_FRAME = 65536
MAX_ARGS = 1024
MAX_RESULT = 4096
CAPABILITY_ID = "living_room_light"
DESCRIPTOR = {
    "capabilityId": CAPABILITY_ID,
    "title": "Living room light",
    "version": "1",
    "observe": True,
    "actions": [{
        "name": "set_led",
        "title": "Set color",
        "input": {
            "type": "object",
            "properties": {"color": "string"},
            "required": ["color"],
        },
    }],
}


def response(request_id, result=None, code=None):
    envelope = {"protocolVersion": PROTOCOL_VERSION, "id": request_id}
    if code is None:
        envelope["result"] = result
    else:
        envelope["error"] = {"code": code}
    wire = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"
    if len(wire) > MAX_FRAME:
        wire = json.dumps({
            "protocolVersion": PROTOCOL_VERSION, "id": request_id,
            "error": {"code": "too_large"},
        }, separators=(",", ":")).encode() + b"\n"
    sys.stdout.buffer.write(wire)
    sys.stdout.buffer.flush()


def fixture_request(base_url, path, method="GET", body=None):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(base_url + path, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=1.0) as result:
            payload = result.read(MAX_RESULT + 1)
    except (OSError, urllib.error.URLError):
        raise ValueError("unavailable") from None
    if len(payload) > MAX_RESULT:
        raise ValueError("too_large")
    try:
        return json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("unavailable") from None


def dispatch(message, base_url):
    if not isinstance(message, dict):
        return None, "invalid_request"
    request_id = message.get("id")
    if not isinstance(request_id, str) or not re.fullmatch(r"[ -~]{1,64}", request_id):
        return None, "invalid_request"
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        return request_id, "invalid_request"
    method = message.get("method")
    capability_id = message.get("capabilityId")
    if method == "list" and set(message) == {"protocolVersion", "id", "method"}:
        return [DESCRIPTOR], None
    if method not in ("describe", "observe", "invoke"):
        return request_id, "unsupported_method"
    if capability_id != CAPABILITY_ID:
        return request_id, "unknown_capability"
    if method == "describe" and set(message) == {"protocolVersion", "id", "method", "capabilityId"}:
        return DESCRIPTOR, None
    if method == "observe" and set(message) == {"protocolVersion", "id", "method", "capabilityId"}:
        try:
            return fixture_request(base_url, "/state"), None
        except ValueError as error:
            return request_id, str(error)
    if method == "invoke":
        if set(message) != {"protocolVersion", "id", "method", "capabilityId", "action", "args"}:
            return request_id, "invalid_request"
        if message.get("action") != "set_led":
            return request_id, "unsupported_action"
        args = message.get("args")
        encoded = json.dumps(args, separators=(",", ":")).encode()
        if len(encoded) > MAX_ARGS:
            return request_id, "too_large"
        if not isinstance(args, dict) or set(args) != {"color"} or not isinstance(args["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", args["color"]):
            return request_id, "invalid_args"
        try:
            return fixture_request(base_url, "/actions/set-led", "POST", args), None
        except ValueError as error:
            return request_id, str(error)
    return request_id, "invalid_request"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Adapter-owned JSON config path")
    args = parser.parse_args()
    try:
        with open(args.config, "r", encoding="utf-8") as config_file:
            config = json.load(config_file)
        base_url = config["fixtureBaseUrl"]
        if not isinstance(base_url, str) or not base_url.startswith("http://127.0.0.1:"):
            raise ValueError
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        print("Adapter-local configuration unavailable", file=sys.stderr)
        return 2

    while True:
        frame = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not frame:
            return 0
        if len(frame) > MAX_FRAME or not frame.endswith(b"\n"):
            print("oversized or unterminated request frame", file=sys.stderr)
            return 2
        try:
            request = json.loads(frame)
        except (UnicodeDecodeError, json.JSONDecodeError):
            response("?", code="invalid_request")
            continue
        request_id = request.get("id") if isinstance(request, dict) else "?"
        result, error = dispatch(request, base_url)
        response(request_id, result=result, code=error)


if __name__ == "__main__":
    raise SystemExit(main())
