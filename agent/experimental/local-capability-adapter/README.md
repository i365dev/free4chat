# Experimental local capability Adapter spike

This folder contains the experimental reference Adapter and validator. The production Go Runtime launches the Adapter as an external process and does not import its source.

Run with Python 3 (standard library only):

```sh
python3 validate.py
```

To dogfood through the production daemon, start the standalone fixture and create an Adapter-owned config file:

```sh
python3 fixture.py --port 43127
printf '{"fixtureBaseUrl":"http://127.0.0.1:43127"}\n' > adapter-config.json
free4chat-agent capability adapter register \\
  --exec python3 \\
  --arg /absolute/path/to/agent/experimental/local-capability-adapter/adapter.py \\
  --arg --config \\
  --arg /absolute/path/to/adapter-config.json
free4chat-agent capability list --json
free4chat-agent capability observe --id living_room_light
free4chat-agent capability invoke --id living_room_light --action set_led --args '{"color":"#123456"}'
free4chat-agent capability adapter remove
```

Replace `/absolute/path/to` with the checkout paths. Registration explicitly approves local execution. `adapter-config.json` belongs to the Adapter, not Free4Chat Runtime; do not put credentials in command arguments.

The validator starts an ephemeral deterministic localhost fixture, writes an Adapter-owned `adapter-config.json` in a temporary directory, launches `adapter.py`, and checks `list`, `describe`, `observe`, a valid `set_led` invocation, unsupported-action errors, and failure handling for malformed, oversized, duplicate, and missing responses. No Free4Chat source package or Runtime configuration is used. The only fixture endpoint is in the Adapter config file, never in a protocol descriptor or request.

To validate a read-only Adapter, pass its launch command without an action:

```sh
python3 validate.py --command '["python3","./my_read_only_adapter.py"]'
```

The validator checks `list`, `describe`, `observe`, descriptor/result bounds, and that an undeclared invocation returns `unsupported_action`. For an Adapter that declares actions, prepare its local config separately and pass one known-valid action:

```sh
python3 validate.py \\
  --command '["python3","./my_adapter.py","--config","./my-local-config.json"]' \\
  --action turn_on --args-json '{"duration":30}'
```

The JSON command array is launched directly (no shell). The validator does not supply Runtime config or secrets. `--action` and `--args-json` select one known-valid invocation for that Adapter.

The protocol document is [`docs/design/local-capability-adapter-protocol.md`](../../../docs/design/local-capability-adapter-protocol.md).
