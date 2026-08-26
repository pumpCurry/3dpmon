# ADR-0010 Printer Core v3 Gate 2 Identity Repository

## Status

Accepted as the Gate 2 cutoff.

## Context

Gate 1 proved that the existing connection layer can collect Printer Core v3 identity evidence without changing production routing or UI behavior. However, the merge, conflict, and timestamp comparison rules lived inside `dashboard_connection.js`.

That made the connection module aware of too much v3 persistence detail and would make a later move to Data Schema v3 harder.

## Decision

Gate 2 introduces `dashboard_device_identity_repository.js` as the boundary for identity dry-run records.

The repository owns:

- `schemaVersion` and `dryRun` tagging.
- Merging identity candidates.
- Transferring identity records during legacy DHCP target consolidation.
- Suppressing writes when only observation timestamps would change.
- Isolating strong identity conflicts without overwriting the accepted candidate.
- Skipping Moonraker targets, because this gate only covers Creality Printer Core v3 evidence.

`dashboard_connection.js` still locates the current `connectionTarget` and persists the existing shared settings. The repository mutates the target record and returns `changed` so the caller can decide whether to save.

## Compatibility

Gate 2 does not create new IndexedDB stores and does not alter active connection keys. The stored shape remains under `connectionTargets[].printerCoreV3Identity`, which keeps Gate 1 behavior intact while making the next persistence move mechanical.

## Tests

Gate 2 adds repository-level coverage for:

- First observation save.
- Duplicate observation suppression.
- Serial conflict isolation.
- DHCP target identity transfer.
- Moonraker exclusion.
- Same-serial endpoint alias merge.

The Gate 1 connection tests remain in place to verify that the existing WebSocket path still records dry-run identity evidence.

## Consequences

Gate 3 can introduce Data Schema v3 `devices` and `deviceEndpoints` repositories or an export bridge without needing to keep identity merge rules in the connection module.
