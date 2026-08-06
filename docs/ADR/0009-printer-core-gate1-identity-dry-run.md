# ADR-0009 Printer Core v3 Gate 1 Identity Dry-Run

## Status

Accepted as the Gate 1 cutoff.

## Context

Gate 0 created the protocol recorder, fixture format, and standalone identity resolver. The next step is to let the existing connection layer collect v3 identity evidence while keeping all v2 connection behavior authoritative.

The legacy connection layer still keys active sessions by hostname or temporary endpoint. That behavior remains unchanged in Gate 1.

## Decision

Gate 1 stores Printer Core v3 identity candidates on existing `connectionTargets` records:

- `connectionTargets[].printerCoreV3Identity` stores the latest dry-run identity candidate.
- `schemaVersion: 1` and `dryRun: true` mark the record as non-authoritative.
- Serial number and stable machine-reported IDs are used as strong identity seeds.
- MAC addresses are stored only in `endpointAliases.macs`.
- Endpoint addresses are stored in `endpointAliases.addresses`.
- Strong identity conflicts are stored in `printerCoreV3IdentityConflict` and do not overwrite the previous candidate.

The connection layer records identity evidence from WebSocket messages and ARP MAC resolution when available. The stored identity is not used yet for connection routing, UI selection, command authorization, or migration.

## Compatibility

Existing hostname and IP-reuse protection behavior remains the source of truth. When the legacy DHCP consolidation path merges two `connectionTargets` entries with the same hostname, Gate 1 also merges their v3 identity dry-run candidates so wired and wireless endpoint aliases are not lost.

## Tests

Gate 1 adds coverage for:

- Saving a v3 identity candidate from a Creality WebSocket message.
- Keeping MAC addresses as endpoint aliases rather than physical device IDs.
- Merging two endpoints with the same serial number and different MAC addresses during legacy DHCP consolidation.

## Consequences

Gate 2 can introduce a dedicated repository or bridge around these dry-run identity records. Until then, the data is observable and testable but cannot change production behavior.
