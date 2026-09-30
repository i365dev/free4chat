# Local CUPS service Adapter

This read-only macOS reference Adapter reports whether the system CUPS launch
service is running. It uses only Python's standard library and the built-in
`launchctl` command. It does not discover printers, contact a network, change
system settings, or expose launchd output beyond the bounded status fields.

Run the shared protocol validator:

```sh
python3 ../local-capability-adapter/validate.py \
  --command '["python3","adapter.py"]'
```

It supports protocolVersion 1 `list`, `describe`, and `observe`. `invoke`
returns `unsupported_action`; the descriptor has no actions. The exact local
descriptor is:

```json
{"capabilityId":"local_cups_service","title":"Local CUPS service","version":"1","observe":true,"actions":[]}
```

The observation result is limited to `service` (`cups`) and `state`
(`running` or `not_running`). The launchd label and all other command output
remain inside the Adapter. There are no credentials, endpoints, or config
files.

The Adapter is macOS-specific because it relies on launchd. A missing service
or failed query returns the protocol's bounded `unavailable` error.
