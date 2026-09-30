#!/usr/bin/env python3
"""Read-only CUPS queue status Adapter (stdio protocol v1)."""

import argparse
import json
import re
import subprocess
import sys

VERSION = 1
CAPABILITY_ID = "printer_status"
DESCRIPTOR = {
    "capabilityId": CAPABILITY_ID,
    "title": "Printer status",
    "version": "1",
    "observe": True,
    "actions": [],
}


def send(request_id, result=None, error=None):
    message = {"protocolVersion": VERSION, "id": request_id}
    if error:
        message["error"] = {"code": error}
    else:
        message["result"] = result
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def queue_status(queue_name):
    try:
        completed = subprocess.run(
            ["/usr/bin/lpstat", "-p", queue_name, "-l", "-a", queue_name],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=1.0,
            text=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None

    lines = completed.stdout.splitlines()
    state = None
    accepting_jobs = None
    for line in lines:
        folded = line.casefold()
        if " is idle" in folded or "闲置" in line:
            state = "idle"
        elif " is printing" in folded or "正在打印" in line:
            state = "printing"
        elif " is stopped" in folded or " is disabled" in folded or " disabled " in folded or "已停止" in line or "已停用" in line:
            state = "stopped"
        if "not accepting requests" in folded or "不接受请求" in line or "停止接受请求" in line:
            accepting_jobs = False
        elif "accepting requests" in folded or "正在接受请求" in line:
            accepting_jobs = True
    if state is None or accepting_jobs is None:
        return None
    return {"state": state, "acceptingJobs": accepting_jobs}


def handle(request, queue_name):
    request_id = request.get("id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 64:
        return {"protocolVersion": VERSION, "id": "invalid", "error": {"code": "invalid_request"}}
    if request.get("method") == "list":
        return {"protocolVersion": VERSION, "id": request_id, "result": [DESCRIPTOR]}
    method = request.get("method")
    if method not in ("describe", "observe", "invoke"):
        return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unsupported_method"}}
    if request.get("capabilityId") != CAPABILITY_ID:
        return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unknown_capability"}}
    if method == "describe":
        return {"protocolVersion": VERSION, "id": request_id, "result": DESCRIPTOR}
    if method == "invoke":
        return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unsupported_action"}}
    result = queue_status(queue_name)
    if result is None:
        return {"protocolVersion": VERSION, "id": request_id, "error": {"code": "unavailable"}}
    return {"protocolVersion": VERSION, "id": request_id, "result": result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", required=True, help="local CUPS queue name; never returned by the Adapter")
    options = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", options.queue):
        parser.error("--queue must be a bounded CUPS queue name")

    while True:
        frame = sys.stdin.buffer.readline(65537)
        if not frame:
            return
        if len(frame) > 65536 or not frame.endswith(b"\n"):
            send("invalid", error="too_large")
            return
        try:
            request = json.loads(frame)
        except (UnicodeDecodeError, json.JSONDecodeError):
            send("invalid", error="invalid_request")
            continue
        if not isinstance(request, dict) or request.get("protocolVersion") != VERSION or len(request) > 6:
            send("invalid", error="invalid_request")
            continue
        response = handle(request, options.queue)
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
