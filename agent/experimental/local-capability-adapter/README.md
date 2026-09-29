# Experimental local capability Adapter spike

This folder is Phase 0 evidence only. It is not imported by the Go Runtime.

Run with Python 3 (standard library only):

```sh
python3 validate.py
```

The validator starts an ephemeral deterministic localhost fixture, writes an Adapter-owned `adapter-config.json` in a temporary directory, launches `adapter.py`, and checks `list`, `describe`, `observe`, a valid `set_led` invocation, unsupported-action errors, and failure handling for malformed, oversized, duplicate, and missing responses. No Free4Chat source package or Runtime configuration is used. The only fixture endpoint is in the Adapter config file, never in a protocol descriptor or request.

To validate an Adapter you wrote, prepare its local config separately and pass its launch command and one known-valid action:

```sh
python3 validate.py \\
  --command '["python3","./my_adapter.py","--config","./my-local-config.json"]' \\
  --action turn_on --args-json '{"duration":30}'
```

The JSON command array is launched directly (no shell). The validator does not supply Runtime config or secrets. `--action` and `--args-json` select one known-valid invocation for that Adapter.

The protocol document is [`docs/design/local-capability-adapter-protocol.md`](../../../docs/design/local-capability-adapter-protocol.md).
