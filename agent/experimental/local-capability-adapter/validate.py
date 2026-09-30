#!/usr/bin/env python3
"""Small conformance probe for the experimental stdio Adapter protocol."""

import http.server
import argparse
import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
from fixture import Fixture

HERE = pathlib.Path(__file__).resolve().parent
MAX_FRAME = 65536
VERSION = 1


def start_adapter(config_path):
    return subprocess.Popen(
        [sys.executable, str(HERE / "adapter.py"), "--config", str(config_path)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def exchange(process, request):
    wire = json.dumps(request, separators=(",", ":")).encode() + b"\n"
    if len(wire) > MAX_FRAME:
        raise ValueError("test request oversized")
    process.stdin.write(wire)
    process.stdin.flush()
    frames = queue.Queue(maxsize=1)
    reader = threading.Thread(target=lambda: frames.put(process.stdout.readline(MAX_FRAME + 1)), daemon=True)
    reader.start()
    try:
        frame = frames.get(timeout=2)
    except queue.Empty:
        process.kill()
        raise RuntimeError("Adapter did not respond before the 2 second validator deadline") from None
    if not frame:
        raise RuntimeError("Adapter closed stdout without a response")
    if len(frame) > MAX_FRAME or not frame.endswith(b"\n"):
        raise RuntimeError("malformed or oversized response frame")
    response = json.loads(frame)
    if not isinstance(response, dict) or response.get("protocolVersion") != VERSION or response.get("id") != request["id"]:
        raise RuntimeError("malformed response envelope or mismatched id/version")
    if ("result" in response) == ("error" in response):
        raise RuntimeError("response must contain exactly one of result/error")
    return response


def fault_probe(source, expected):
    process = subprocess.Popen(
        [sys.executable, "-c", source], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    request = {"protocolVersion": VERSION, "id": "fault", "method": "list"}
    try:
        if expected == "duplicate":
            exchange(process, request)
            try:
                exchange(process, {"protocolVersion": VERSION, "id": "next", "method": "list"})
            except (RuntimeError, BrokenPipeError):
                return
            raise AssertionError("validator accepted a duplicate response ID")
        try:
            exchange(process, request)
        except (RuntimeError, ValueError, json.JSONDecodeError):
            return
        raise AssertionError(expected + " response was accepted")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", help="JSON array of executable and arguments; launched without a shell")
    parser.add_argument("--action", help="known-valid action for an Adapter that declares actions")
    parser.add_argument("--args-json", help="known-valid JSON object for --action; defaults to {}")
    options = parser.parse_args()

    if options.command:
        if bool(options.action) != (options.args_json is not None):
            parser.error("--action and --args-json must be provided together")
        try:
            command = json.loads(options.command)
        except json.JSONDecodeError as error:
            parser.error("--command is not a valid JSON array: " + str(error))
        if not isinstance(command, list) or not command or not all(isinstance(part, str) for part in command):
            parser.error("--command must be a non-empty JSON array of strings")
        try:
            invoke_args = json.loads(options.args_json) if options.args_json is not None else {}
        except json.JSONDecodeError as error:
            parser.error("--args-json is not valid JSON: " + str(error))
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            listed = exchange(process, {"protocolVersion": VERSION, "id": "1", "method": "list"})["result"]
            if not isinstance(listed, list) or not listed or len(listed) > 8:
                raise AssertionError("list must return between one and eight descriptors")
            for item in listed:
                if not isinstance(item, dict) or len(json.dumps(item, separators=(",", ":")).encode()) > 1024:
                    raise AssertionError("descriptor must be an object no larger than 1,024 bytes")
                if set(item) != {"capabilityId", "title", "version", "observe", "actions"} or not isinstance(item.get("capabilityId"), str) or not isinstance(item.get("title"), str) or not isinstance(item.get("version"), str) or not isinstance(item.get("observe"), bool) or not isinstance(item.get("actions"), list) or len(item["actions"]) > 4:
                    raise AssertionError("descriptor does not match the bounded semantic shape")
            descriptor = listed[0]
            capability_id = descriptor.get("capabilityId") if isinstance(descriptor, dict) else None
            if not isinstance(capability_id, str):
                raise AssertionError("first descriptor has no capabilityId")
            detailed = exchange(process, {"protocolVersion": VERSION, "id": "2", "method": "describe", "capabilityId": capability_id})["result"]
            if detailed != descriptor:
                raise AssertionError("describe did not match the listed descriptor")
            if descriptor["observe"]:
                observed = exchange(process, {"protocolVersion": VERSION, "id": "3", "method": "observe", "capabilityId": capability_id})
                if "result" not in observed or len(json.dumps(observed["result"], separators=(",", ":")).encode()) > 4096:
                    raise AssertionError("observe must return a result no larger than 4,096 bytes")
            if descriptor["actions"]:
                if not options.action:
                    raise AssertionError("Adapter declares actions; provide --action and --args-json for a valid invocation")
                if not any(isinstance(action, dict) and action.get("name") == options.action for action in descriptor["actions"]):
                    raise AssertionError("--action must name an action declared by the descriptor")
                good = exchange(process, {"protocolVersion": VERSION, "id": "4", "method": "invoke", "capabilityId": capability_id, "action": options.action, "args": invoke_args})
                if "result" not in good or len(json.dumps(good["result"], separators=(",", ":")).encode()) > 4096:
                    raise AssertionError("known-valid invoke must return a result no larger than 4,096 bytes: " + repr(good.get("error")))
            elif options.action:
                raise AssertionError("--action was supplied but the descriptor has no actions")
            bad = exchange(process, {"protocolVersion": VERSION, "id": "5", "method": "invoke", "capabilityId": capability_id, "action": "f4c_unsupported_probe", "args": {}})
            if bad.get("error", {}).get("code") != "unsupported_action":
                raise AssertionError("unsupported action must return unsupported_action")
            coverage = "invoke/" if descriptor["actions"] else "read-only/"
            print("PASS list/describe/observe/" + coverage + "unsupported_action")
        finally:
            process.stdin.close()
            process.wait(timeout=2)
            if process.returncode != 0:
                raise AssertionError("Adapter exited unexpectedly: " + process.stderr.read().decode(errors="replace"))
        return

    server = http.server.HTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="f4c-adapter-") as temp:
            config_path = pathlib.Path(temp) / "adapter-config.json"
            config_path.write_text(json.dumps({"fixtureBaseUrl": "http://127.0.0.1:%d" % server.server_port}), encoding="utf-8")
            process = start_adapter(config_path)
            try:
                descriptor = exchange(process, {"protocolVersion": VERSION, "id": "1", "method": "list"})["result"]
                assert len(descriptor) == 1 and descriptor[0]["capabilityId"] == "living_room_light"
                detailed = exchange(process, {"protocolVersion": VERSION, "id": "2", "method": "describe", "capabilityId": "living_room_light"})["result"]
                assert detailed == descriptor[0]
                state = exchange(process, {"protocolVersion": VERSION, "id": "3", "method": "observe", "capabilityId": "living_room_light"})["result"]
                assert state["brightness"] == 42
                invoked = exchange(process, {"protocolVersion": VERSION, "id": "4", "method": "invoke", "capabilityId": "living_room_light", "action": "set_led", "args": {"color": "#123456"}})["result"]
                assert invoked == {"ok": True, "color": "#123456"}
                unsupported = exchange(process, {"protocolVersion": VERSION, "id": "5", "method": "invoke", "capabilityId": "living_room_light", "action": "explode", "args": {}})
                assert unsupported.get("error", {}).get("code") == "unsupported_action"
            finally:
                process.stdin.close()
                process.wait(timeout=2)
                if process.returncode != 0:
                    raise AssertionError("reference Adapter exited unexpectedly: " + process.stderr.read().decode(errors="replace"))

        malformed = "import sys; sys.stdin.buffer.readline(); sys.stdout.buffer.write(b'not-json\\n'); sys.stdout.flush()"
        oversized = "import sys; sys.stdin.buffer.readline(); sys.stdout.buffer.write(b' ' * 65536 + b'\\n'); sys.stdout.flush()"
        duplicate = "import sys,json; r=json.loads(sys.stdin.readline()); x=json.dumps({'protocolVersion':1,'id':r['id'],'result':[]})+'\\n'; sys.stdout.write(x+x); sys.stdout.flush()"
        crash = "import sys; sys.stdin.buffer.readline(); sys.exit(7)"
        for label, code in (("malformed", malformed), ("oversized", oversized), ("duplicate", duplicate), ("missing", crash)):
            fault_probe(code, label)
            print("PASS failure detection: " + label)
        print("PASS list/describe/observe/invoke/unsupported_action")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
