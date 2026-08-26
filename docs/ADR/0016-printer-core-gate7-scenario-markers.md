# ADR-0016 Printer Core Gate 7 Scenario Markers

## Context

Gate 6 proved that the local K2 Pro Combo with CFS can provide a safe read-only
idle baseline through HTTP `/info`, WebSocket 9999, and a read-only `boxsInfo`
probe. The next live validation boundary is not another idle capture, but
physical-state fixtures where communication frames must be aligned with operator
observations.

The existing `ProtocolRecorder` already supports marker events. Before capturing
printing, pause/resume, completion, CFS reconnect, or material-change scenarios,
the capture CLI needs a documented path for adding those markers without sending
extra printer commands.

## Decision

- Expose recorder marker events in `scripts/capture_protocol_fixture.mjs`.
- Support repeatable scheduled markers with:

```text
--marker-at <ms:name[:json-details]>
```

- Support interactive marker entry during a capture with:

```text
--interactive-markers
```

- Keep marker handling local to the recorder. Marker capture must not change
  HTTP probing, WebSocket observation, heartbeat acknowledgement, `boxsInfo`
  probing, legacy UI state, command routing, or filament ledger authority.
- Treat scheduled markers as planned boundaries and interactive markers as
  operator observations. Scenario certification must compare both marker types
  with protocol frames instead of treating timer expiry alone as physical truth.
- Mark a capture as failed when a scheduled marker does not fire within the
  capture window.
- Continue storing later K2 Pro Combo physical fixtures under scenario
  subdirectories instead of overwriting the Gate 6 idle baseline.

## Marker Format

Scheduled marker examples:

```text
--marker-at 0:operator-print-start
--marker-at 90000:operator-paused:{"phase":"paused"}
```

Interactive marker input accepts either a plain marker name:

```text
operator print start
```

or a marker name followed by JSON details:

```text
operator pause requested {"phase":"paused"}
```

Marker details are still subject to fixture redaction at export time. Operators
should nevertheless avoid entering raw IP addresses, MAC addresses, serial
numbers, hostnames, credentials, SSIDs, print IDs, RFID values, or unredacted
G-code file names.

Marker provenance is fixed by the CLI:

- scheduled markers are exported with `source: "scheduled-cli"`.
- interactive markers are exported with `source: "stdin"`.
- invalid interactive marker JSON is recorded with
  `errorCode: "invalid-marker-json"` and does not store the raw parser message
  or input fragment.

## Acceptance

- CLI parsing keeps existing Gate 6 capture behavior unchanged when marker
  options are omitted.
- Scheduled markers are emitted as `direction: "marker"` events in the exported
  fixture.
- Missing scheduled markers make `metadata.validation.success` false with
  `required-marker-not-observed`.
- `metadata.validation.eventCount` includes marker events, so scenarios can
  require a minimum amount of evidence.
- `metadata.validation.protocolEventCount`, `markerCount`, and `markers` split
  protocol evidence from marker evidence for later scenario analyzers.
- The dry-run path can validate marker recording without requiring a live printer.

## Consequences

Gate 7 creates the fixture instrumentation needed for K2 Pro Combo physical
scenario captures. It does not yet collect those live scenarios and does not
promote K2 Adapter output to dashboard authority.
