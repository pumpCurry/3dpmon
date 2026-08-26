# ADR-0014 Printer Core Gate 5 K2 Pro Combo Live Shadow

## Status

Accepted for Gate 5 implementation.

## Context

Gate 4 closed the K2 Pro Combo + CFS read-only adapter against captured WS9999 fixtures. The next boundary is live wiring for the local K2 Pro Combo with CFS while keeping the existing UI, command route, print manager, and filament ledger authoritative.

The available live K2 target is K2 Pro Combo with CFS, reported model `F012`. K2 Plus and K2 Pro without CFS remain supported family variants, but they are not live validation targets because hardware is not available.

## Decision

- Reuse the existing Printer Core v3 live shadow lifecycle for K2.
- Detect K2 live shadow by explicit `printerType: "creality-k2"` or observed K2 identifiers such as `model: "F012"`.
- Treat an observed K2 decision as sticky for the WebSocket lifetime so sparse delta frames do not fall back to K1.
- Keep K1 and K2 shadow sessions in separate namespaces: `k1-live:*` and `k2-live:*`.
- Route K2 frames to `K2Adapter` and store the resulting `NormalizedPrinterState` in `runtimeData.printerCoreV3Shadow`.
- Do not compare K2 to legacy storedData in Gate 5; K2 shadow state is observation-only until live semantics are proven.
- Send a read-only `boxsInfo` probe once per CFS connection epoch when a K2 frame reports `cfsConnect=1` and no `boxsInfo` has been observed for that epoch.
- Keep the probe separate from command authority and `sendCommand()` request/response tracking.
- Keep K2 out of both K1-only and Moonraker-only panel controls until K2-specific UI authority is designed.
- Do not write K2 material topology to `hostSpoolMap`, `filamentSpools`, mount history, or filament ledger.

## Non-Goals

- No K2 command authority.
- No CFS load/unload, material switching, color assignment, or spool reconciliation.
- No Data Schema v3 persistent material-source store activation.
- No K2 print-state code authority beyond runtime observation.

## Consequences

K2 Pro Combo live WS9999 frames can now run beside the legacy app path and produce normalized status plus CFS topology in the same runtime record used by K1 shadow. This gives live validation a clear surface for status semantics, CFS freshness, slot/material changes, and assignment changes without changing production behavior.
