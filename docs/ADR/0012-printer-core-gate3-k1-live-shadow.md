# ADR-0012 Printer Core v3 Gate 3 K1 Live Shadow

## Status

Accepted as the Gate 3 K1 live shadow cutoff.

## Context

Gate 2 proved that the K1 dry-run adapter can replay captured K1 Max fixtures alongside the legacy `processData()` path. The next risk is live wiring: the same WebSocket stream must feed both the legacy dashboard authority and Printer Core v3 without changing UI state, command routing, storage authority, or printer behavior.

## Decision

Gate 3 connects K1 WebSocket receive handling to Printer Core v3 as a live shadow observer:

- `handleSocketMessage()` still runs `processData()` as the dashboard authority.
- After `processData()` updates legacy `storedData`, the same raw payload is observed by `observeK1LiveShadowFrame()`.
- The shadow path writes only volatile `machine.runtimeData.printerCoreV3Shadow`.
- The shadow path records normalized state, sequence, last observed time, and field-by-field differences against legacy projection.
- WebSocket open creates a new shadow session ID. The first JSON frame fixes the shadow `deviceId` for that session.
- WebSocket close, manual disconnect, stale-socket replacement, and cleanup end the shadow session so `adapterState` cannot leak across reconnects.
- Stale close requests update runtimeData only when they still target the current shadow `sessionId`.
- If identity evidence has an open conflict, live shadow uses an endpoint/host provisional ID instead of reusing the conflicting authoritative seed.
- `caseFanPct` is normalized as `fans.case` so it remains separate from K2 chamber temperature and chamber heater concepts.

No command path, UI rendering path, IndexedDB schema, connection target authority, or K1 transmission behavior changes in this gate.

## Compatibility

The live shadow path is K1-only. Moonraker translated data continues through the existing `simulateReceivedJson()` route but is not shadowed by the K1 live observer.

If Printer Core v3 detects a mismatch, it writes the diff to `runtimeData.printerCoreV3Shadow.lastDiffs` and logs a console warning. The legacy UI remains authoritative even when the shadow state differs.

## Tests

Gate 3 adds coverage for:

- deterministic shadow session ID generation
- matched live shadow projection into runtimeData
- K1 delta replay preserving protocol-state semantics during live shadow
- runtime differential recording when legacy and v3 diverge
- shadow session close marking runtimeData as closed
- stale session close preserving the active runtimeData record
- recoverable session-not-started observe retry without hiding unrelated adapter exceptions
- identity-conflict fallback to host provisional shadow ID
- connection-layer K1 WebSocket receive branching into live shadow
- connection-layer open, close, manual disconnect, cleanup, and stale WebSocket replacement lifecycle assertions
- transactional `beginSession()` preserving the old instance if new instance construction fails
- table-driven alias replay for bed temperature, filename, and hostname fields

## Consequences

K1 Max live validation can now connect two real printers and inspect per-host `runtimeData.printerCoreV3Shadow` to confirm that session IDs, sequence numbers, adapter state, and differential logs stay isolated. Once K1 live shadow is stable, K2 Pro Combo with CFS can be introduced as a read-only adapter on the same Facade and Instance shape.
