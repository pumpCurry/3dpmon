# ADR-0025 Printer Core Gate 11 HTTP Info Identity Integration

## Context

Gate 11 moves identity evidence toward Data Schema v3 readiness without making
Printer Core v3 authoritative. The existing live path already records WS9999
status frames into `connectionTargets[].printerCoreV3Identity`, and Gate 11
introduced `DeviceFingerprint` fields that can represent HTTP `/info`
provenance, firmware, and transport ports.

The missing step was the production dry-run entry point: live connections did
not yet perform a read-only `/info` probe and therefore could not merge HTTP and
WS9999 evidence during normal connection lifecycle.

## Decision

- On non-Moonraker `connectWs()`, start a best-effort read-only HTTP `/info`
  probe after the connection target is stored.
- The probe sends only:

```text
GET http://<endpoint>:<httpPort>/info
```

- The probe is non-authoritative:
  - fetch/CORS/timeout/non-JSON failures do not fail the WebSocket connection
  - no UI state is driven directly from the HTTP response
  - no command authority is enabled
- Successful JSON responses are recorded through the existing identity
  repository with:

```text
source: "http-info"
endpointAddress: <connection endpoint>
```

- HTTP `/info` does not synthesize `reportedHostname` from an IP address. If the
  endpoint later reports a WS9999 hostname, the merged fingerprint keeps the
  real hostname rather than an IP fallback.

## Consequences

Live dry-run identity can now merge `/info` and WS9999 evidence in the same
connection target:

```text
sources: ["http-info", "ws9999"]
reported.firmwareVersion
transports.wssPort
transports.videoPort
endpointAliases.macs
```

This closes the main Gate 11 identity evidence gap before Data Schema v3. The
stored result is still dry-run evidence on `connectionTargets`; it is not yet a
canonical `Device` or `DeviceEndpoint` record.
