# K1C + CFS-C Fixture

Gate 0 records this target as pending because the K1C test printer is not reachable from the current development network.

When the separate K1C environment is available, capture the same read-only baseline shape used by the other devices:

```powershell
npm run capture:protocol -- --host <k1c-host> --model "K1C" --attachment "CFS-C" --scenario idle-baseline --out tests/fixtures/printers/k1c-cfs-c --send-boxsinfo
```

Expected outputs:

- `metadata.json`
- `capture.json`
- `events.ndjson`

Keep the raw capture outside the repository unless it has been redacted by `ProtocolRecorder`.
