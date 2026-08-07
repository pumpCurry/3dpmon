# ADR-0013 Printer Core Gate 4 K2 Pro Combo + CFS Read-Only Adapter

## Status

Accepted for Gate 4 implementation.

## Context

Gate 3 closed the K1 live shadow path while keeping the legacy K1 UI and command route authoritative. The next useful boundary is K2 Pro Combo with CFS read-only support: the app must be able to consume captured K2 WS9999 status frames and CFS `boxsInfo` frames without sending CFS commands or writing filament ledger data.

The local hardware target for this gate is K2 Pro Combo with CFS, represented by the `k2-pro-cfs` fixture and reported model `F012`. K2 Plus and K2 Pro without CFS remain supported family variants, but they are not live fixture requirements because hardware is not available.

## Decision

- Add `K2Adapter` as a read-only Printer Core v3 adapter.
- Reuse the shared K1-like status normalization for K2 status fields that have the same WS9999 semantics.
- Add a material topology section to `NormalizedPrinterState`.
- Normalize K2 `boxsInfo.materialBoxs` into CFS units, material sources, tool assignments, and same-material groups.
- Treat external spool and CFS slots as separate material sources.
- Keep CFS `sourceId` values as runtime/fixture observation keys, not stable Data Schema v3 device or spool IDs.
- Add `createK2PrinterFacade()` as a convenience factory while preserving the generic facade's explicit adapter requirement.

## Non-Goals

- No K2 command authority.
- No `multiColorPrint`, `colorMatch`, tool load/unload, or CFS control commands.
- No writes to `hostSpoolMap`, `filamentSpools`, mount history, or filament ledger.
- No Data Schema v3 store activation.

## Consequences

K2 Pro Combo + CFS can now be replayed through the same `PrinterFacade` / `PrinterInstance` shape as K1. The state output contains both ordinary printer status and read-only material topology, which gives the next gate a stable surface for live K2 shadow wiring and eventual Data Schema v3 material-source mapping.
