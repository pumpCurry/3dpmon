# ADR-0007 Data Schema v3

## Status

Accepted for Gate 0 dry-run and dual-route development.

## Context

The v2 storage model uses `shared` and `machines` stores plus in-memory structures such as `hostSpoolMap`, `filamentSpools`, print history, and `mountHistory`. ADR-0004 already makes filament remaining length an idempotent derived value instead of a direct subtraction target.

K2/CFS/CFS-C support requires multiple material sources, multiple CFS units, external spools, immutable job snapshots, multi-tool assignments, auto-refill segments, and a migration path that does not destroy legacy data.

## Decision

Data Schema v3 keeps the existing IndexedDB database and adds v3 stores behind repositories. During development, v2 and v3 write routes may coexist. Long-term, v2 data is read for migration and v3 becomes the write authority.

The planned v3 stores are:

- `meta`
- `devices`
- `deviceEndpoints`
- `capabilitySnapshots`
- `printJobs`
- `gcodeAssets`
- `printPlans`
- `filamentUnits`
- `materialSources`
- `spools`
- `spoolMounts`
- `jobMaterialSegments`
- `filamentLedger`
- `settings`
- `migrationJournal`
- `protocolCaptures`

Migration must first export canonical legacy JSON, compute a checksum, write a migration journal, transform records with deterministic IDs, validate counts and references, and then activate schema v3. Failed migrations must quarantine unconverted data and retain the original payload.

## Invariants

- CFS slots and inventory spools are different entities.
- A spool mount is an interval from one spool to one material source.
- One material source may have at most one open mount.
- Print history must use immutable snapshots from print start time.
- Filament consumption is append-only ledger data.
- Remaining filament is derived from initial amount, migration anchors, consumption, corrections, and reservations.
- Transforming the same legacy data twice must not create duplicate v3 records.
- Development builds may dual-write, but legacy data must not be silently discarded.
- Endpoint records may contain wired and wireless MAC aliases. These aliases help discovery but must not split one physical printer into two devices when the serial number or stable device evidence matches.

## Consequences

Schema v3 can support CFS auto-refill and multi-material histories without mutating past jobs when current spool mounting changes. It also gives CI a clear migration target before the production schema switch is enabled.
