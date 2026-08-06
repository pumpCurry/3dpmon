# ADR-0006 Printer Core v3

## Status

Accepted for Gate 0.

## Context

3dpmon 2.2.1039 already supports multiple K1-series printers, WebSocket 9999, HTTP upload, camera integration, Moonraker translation, and a filament ledger based on mount history. Adding K2, CFS, and CFS-C directly to the current UI-facing communication modules would spread model-specific branches through connection, command, file, state, and filament code.

The next architecture must keep the existing K1 behavior testable while allowing K1+CFS-C, K2, and K2+CFS to share one application-facing printer API.

## Decision

Printer Core v3 introduces a small set of boundaries:

- `PrinterFacade` is the only UI-facing command and state API.
- `PrinterInstance` represents one physical printer and owns `deviceId`, `sessionId`, capabilities, state, providers, and command dispatch.
- `K1Adapter` and `K2Adapter` are the only body-family adapters.
- CFS and CFS-C are provider/topology capabilities, not separate adapter families.
- Transport classes only move frames. Protocol codecs interpret frames. Providers expose feature-level behavior.
- All core events must carry `deviceId`, `sessionId`, `sequence`, and `receivedAt`.
- Raw K1/K2 protocol payloads must not be passed directly to UI components.

The initial implementation uses a legacy bridge to compare current K1 behavior against the new normalized state and command frames. K2 read-only support starts only after recorder fixtures exist.

## Invariants

- A physical printer is identified by `deviceId`, not by IP address, hostname, or a single MAC address.
- Wired LAN MAC and wireless LAN MAC are endpoint aliases for the same physical printer. Identity resolution must prefer serial numbers or stable machine-reported IDs and then merge endpoint MAC aliases into the same device when evidence shows they belong together.
- CFS attach/detach changes capability and topology snapshots, not printer identity.
- Capability checks must gate commands before protocol frames are generated.
- Non-idempotent commands, including print start, stop, delete, load, and unload, must not be retried automatically.
- A stale event from an older connection session must be discarded.
- The K1 path remains regression-tested while the bridge is active.

## Consequences

This design is larger than a small K2 patch, but it prevents K2/CFS support from becoming UI conditionals and duplicated state logic. Gate 0 therefore starts with ADRs, a protocol recorder, fixture format, and replayable test data before command support is added.
