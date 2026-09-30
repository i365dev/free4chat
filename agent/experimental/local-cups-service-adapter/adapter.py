#!/usr/bin/env python3
"""Read-only macOS CUPS launchd status Adapter (stdio protocol v1)."""

import json
import re
import subprocess
import sys

VERSION = 1
CAPABILITY_ID = "local_cups_service"
DESCRIPTOR = {
    "capabilityId": CAPABILITY_ID,
    "title": "Local CUPS service",
    "version": "1",
    "observe": True,
    "actions": [],
}


def response(request_id, *, result=None, error=None):
    message = {"protocolVersion": VERSION, "id": request_id}
    if error is not None:
        message["error"] = {"code": error}
    else:
        message["result"] = result
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def observe_cups():
    try:
        completed = subprocess.run(
            ["/bin/launchctl", "print", "system/org.cups.cupsd"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=1.0,
            text=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    # launchctl's output contains machine and service details. Extract one
    # bounded semantic field and discard everything else.
    match = re.search(r"^\s*state = (running|not running)\s*$", completed.stdout, re.MULTILINE)
    if completed.returncode != 0 or match is None:
        return None
    state = "running" if match.group(1) == "running" else "not_running"
    return {"service": "cups", "state": state}


def handle(request):
    request_id = request.get("id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 64:
        return {"protocolVersion": VERSION, "id": "invalid", "error": {"code": "invalid_request"}}

    method = request.get("method")
    if method == "list":
        return {"protocolVersion": VERSION, "id": request_id, "result": [DESCRIPTOR]}
    if method not in ("describe", "observe", "invoke"):
        return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unsupported_method"}}
    if request.get("capabilityId") != CAPABILITY_ID:
        return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unknown_capability"}}
    if method == "describe":
        return {"protocolVersion": VERSION, "id": request_id, "result": DESCRIPTOR}
    if method == "observe":
        result = observe_cups()
        if result is None:
            return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unavailable"}}
        return {"protocolVersion": VERSION, "id": request_id, "result": result}
    return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unsupported_action"}}


def main():
    while True:
        frame = sys.stdin.buffer.readline(65537)
        if not frame:
            return
        if len(frame) > 65536 or not frame.endswith(b"\n"):
            response("invalid", error="too_large")
            return
        try:
            request = json.loads(frame)
        except (UnicodeDecodeError, json.JSONDecodeError):
            response("invalid", error="invalid_request")
            continue
        if not isinstance(request, dict) or request.get("protocolVersion") != VERSION:
            response("invalid", error="invalid_request")
            continue
        if len(request) > 6:
            response(request.get("id") if isinstance(request.get("id"), str) else "invalid", error="invalid_request")
            continue
        result = handle(request)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
