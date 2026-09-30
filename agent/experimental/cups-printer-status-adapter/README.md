# CUPS printer status Adapter

This read-only Adapter projects one printer queue already configured in local
CUPS. It asks `lpstat` for that queue's state and whether CUPS is accepting new
jobs. It never submits a print job or returns the local queue name, device URI,
host, or other connection details.

The queue name is Adapter-owned, non-secret launcher configuration. Pass it
only as the Adapter's `--queue` argument:

```sh
python3 ../local-capability-adapter/validate.py \
  --command '["python3","adapter.py","--queue","MY_PRINTER"]'
```

The descriptor is read-only:

```json
{"capabilityId":"printer_status","title":"Printer status","version":"1","observe":true,"actions":[]}
```

The observation contains only semantic state:

```json
{"state":"idle","acceptingJobs":true}
```

The Adapter uses the standard library and macOS's `/usr/bin/lpstat`. CUPS queue
names must contain only letters, digits, underscore, dot, or hyphen. Missing
queues, command failures, unknown localized status output, and timeouts return
the bounded `unavailable` error. Unsupported actions return
`unsupported_action`.
