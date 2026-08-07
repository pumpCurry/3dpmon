# ADR-0011 Printer Core v3 Gate 2 Normalized K1 Dry-Run

## Status

Accepted as the Gate 2 Printer Core body cutoff.

## Context

Gate 0 and Gate 1 established safe fixture capture, identity evidence collection, and review fixes without changing the active K1 route. The next risk is not identity storage itself, but whether the new Printer Core can represent the same K1 status semantics that `processData()` currently feeds into the dashboard.

K1 transmission and UI authority must not switch in this gate. The new path has to run beside the legacy path and prove that it can generate an equivalent or more explicit normalized state from the same fixture frames.

## Decision

Gate 2 introduces the first read-only Printer Core body:

- `PrinterInstance` holds one physical printer's latest normalized state and monotonic sequence.
- `PrinterFacade` owns instances by `deviceId` and is the future connection-layer entry point.
- `NormalizedPrinterState` defines the dry-run state shape for temperatures, fans, light, print progress, layers, remaining time, filename, motion position, error, camera flags, and AI flags.
- `Capability model` provides deterministic capability sets inferred from observed frames.
- `K1Adapter` converts K1/K1 Max WS9999 status frames into `NormalizedPrinterState`.

The legacy `processData()` path remains the dashboard authority. Gate 2 only adds fixture-based differential coverage and does not send commands through Printer Core v3.

## Compatibility

This gate does not alter `connectionTargets`, IndexedDB stores, WebSocket routing, command routing, or UI rendering. The new modules live under `3dp_lib/printer_core/` and are imported only by tests at this stage.

## Tests

Gate 2 adds K1 fixture differential coverage using both captured K1 Max devices:

- nozzle and bed current/target temperatures
- part cooling, auxiliary, and chamber fan percentages
- LED state
- print state, progress, layer, total layer, remaining time, and filename
- current XYZ position
- error code/key
- MJPEG/WebRTC camera flags
- AI detection flag
- facade/instance sequence and capability accumulation

## Consequences

The next gate can connect this dry-run path to the live connection stream as a shadow observer, then compare real K1 Max devices before making K1Adapter authoritative. K2 Pro Combo and CFS topology can be added to the same Instance/Facade shape after the K1 baseline is proven.
